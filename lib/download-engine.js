/**
 * Multi-connection download engine with true pause/resume via segment callbacks.
 */

import { formatBytes, formatSpeed } from "./format.js";

export { formatBytes, formatSpeed };

const DEFAULT_CONNECTIONS = 8;
const MIN_PART_SIZE = 256 * 1024;

export function guessFilename(url, contentDisposition) {
  if (contentDisposition) {
    const utf = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
    if (utf) {
      try {
        return decodeURIComponent(utf[1].trim());
      } catch {
        /* ignore */
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(contentDisposition);
    if (plain) return plain[1].trim();
  }
  try {
    const path = new URL(url).pathname;
    const base = path.split("/").filter(Boolean).pop();
    if (base) return decodeURIComponent(base.split("?")[0]);
  } catch {
    /* ignore */
  }
  return `download-${Date.now()}`;
}

export function categorize(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const map = {
    video: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "mpeg"],
    audio: ["mp3", "flac", "wav", "aac", "ogg", "m4a", "wma", "opus"],
    image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "avif"],
    archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "iso", "xz"],
    document: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "epub"],
    program: ["exe", "msi", "dmg", "pkg", "apk", "deb", "rpm", "appimage", "msix"],
  };
  for (const [cat, list] of Object.entries(map)) {
    if (list.includes(ext)) return cat;
  }
  return "other";
}

export function fileExtension(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return ext.length <= 8 ? ext : "";
}

export async function probe(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    let res = await fetch(url, {
      method: "HEAD",
      headers,
      signal: controller.signal,
      credentials: "include",
    });
    if (!res.ok) {
      res = await fetch(url, {
        method: "GET",
        headers: { ...headers, Range: "bytes=0-0" },
        signal: controller.signal,
        credentials: "include",
      });
    }
    const cd = res.headers.get("content-disposition");
    const ct = res.headers.get("content-type") || "";
    const acceptRanges = (res.headers.get("accept-ranges") || "").toLowerCase();
    const contentRange = res.headers.get("content-range");
    let size = Number(res.headers.get("content-length")) || 0;
    if (contentRange) {
      const m = /\/(\d+)\s*$/.exec(contentRange);
      if (m) size = Number(m[1]);
    }
    const ranged =
      acceptRanges.includes("bytes") ||
      res.status === 206 ||
      Boolean(contentRange);
    if (res.body) {
      try {
        await res.body.cancel();
      } catch {
        /* ignore */
      }
    }
    return {
      ok: res.ok || res.status === 206,
      status: res.status,
      size,
      ranged,
      contentType: ct,
      filename: guessFilename(url, cd),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildParts(size, connections) {
  const n = Math.max(
    1,
    Math.min(connections, Math.floor(size / MIN_PART_SIZE) || 1)
  );
  const partSize = Math.ceil(size / n);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const start = i * partSize;
    if (start >= size) break;
    const end = Math.min(size - 1, start + partSize - 1);
    parts.push({
      index: i,
      start,
      end,
      loaded: 0,
      done: false,
    });
  }
  return parts;
}

/**
 * Simple token-bucket style limiter shared across connections.
 */
function createRateLimiter(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) {
    return async () => {};
  }
  let allowed = bytesPerSecond;
  let last = Date.now();
  return async (n) => {
    const now = Date.now();
    const elapsed = (now - last) / 1000;
    allowed = Math.min(bytesPerSecond, allowed + elapsed * bytesPerSecond);
    last = now;
    if (n <= allowed) {
      allowed -= n;
      return;
    }
    const wait = ((n - allowed) / bytesPerSecond) * 1000;
    allowed = 0;
    await new Promise((r) => setTimeout(r, Math.min(wait, 2000)));
  };
}

async function readStream(res, { signal, onChunk, limit }) {
  if (!res.body) throw new Error("Không có body phản hồi");
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    await limit?.(value.byteLength);
    chunks.push(value);
    loaded += value.byteLength;
    onChunk?.(loaded, value.byteLength);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.jobId
 * @param {string} opts.url
 * @param {object} [opts.headers]
 * @param {number} [opts.connections]
 * @param {number} [opts.speedLimit] bytes/sec, 0 = unlimited
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.onProgress]
 * @param {function} [opts.loadSegment] async (partIndex) => Uint8Array|null
 * @param {function} [opts.saveSegment] async (partIndex, buffer, partMeta) => void
 * @param {Array} [opts.partsMeta] previous part layout
 */
export async function downloadMulti(opts) {
  const {
    url,
    headers = {},
    connections = DEFAULT_CONNECTIONS,
    speedLimit = 0,
    signal,
    onProgress,
    loadSegment,
    saveSegment,
    partsMeta,
  } = opts;

  const info = await probe(url, headers);
  if (!info.ok) {
    throw new Error(`Không thể truy cập URL (HTTP ${info.status})`);
  }

  const total = info.size || 0;
  const useMulti = info.ranged && total > MIN_PART_SIZE * 2;
  const limit = createRateLimiter(speedLimit);

  if (!useMulti) {
    return downloadSingle({
      url,
      headers,
      signal,
      onProgress,
      knownTotal: total,
      filename: info.filename,
      contentType: info.contentType,
      limit,
      loadSegment,
      saveSegment,
    });
  }

  let parts =
    partsMeta?.length && partsMeta[0]?.end != null
      ? partsMeta.map((p) => ({
          index: p.index,
          start: p.start,
          end: p.end,
          loaded: p.loaded || 0,
          done: Boolean(p.done),
        }))
      : buildParts(total, connections);

  // Restore completed segments from storage
  for (const part of parts) {
    if (part.done) continue;
    const existing = await loadSegment?.(part.index);
    if (existing && existing.byteLength === part.end - part.start + 1) {
      part.loaded = existing.byteLength;
      part.done = true;
      part._buf = existing;
    } else if (existing && existing.byteLength > 0) {
      // Partial segment — restart that part cleanly
      part.loaded = 0;
      part.done = false;
    }
  }

  const buffers = new Array(parts.length);
  for (const part of parts) {
    if (part._buf) {
      buffers[part.index] = part._buf;
      delete part._buf;
    }
  }

  let lastTick = Date.now();
  let lastLoaded = parts.reduce((s, p) => s + p.loaded, 0);

  const emit = (connStats) => {
    const loaded = parts.reduce((s, p) => s + p.loaded, 0);
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    const speed = dt > 0 ? (loaded - lastLoaded) / dt : 0;
    if (dt >= 0.3) {
      lastTick = now;
      lastLoaded = loaded;
    }
    const remaining = Math.max(0, total - loaded);
    const eta = speed > 0 ? remaining / speed : null;
    onProgress?.({
      loaded,
      total,
      speed,
      eta,
      connections: parts.length,
      parts: parts.map(({ index, start, end, loaded: l, done }) => ({
        index,
        start,
        end,
        loaded: l,
        done,
      })),
      connStats,
    });
  };

  emit();

  const pending = parts.filter((p) => !p.done);
  await Promise.all(
    pending.map(async (part) => {
      const rangeStart = part.start + part.loaded;
      if (rangeStart > part.end) {
        part.done = true;
        return;
      }

      // Always re-fetch full part if not done (simpler + reliable with IDB full parts)
      const res = await fetch(url, {
        headers: {
          ...headers,
          Range: `bytes=${part.start}-${part.end}`,
        },
        signal,
        credentials: "include",
      });
      if (!(res.ok || res.status === 206)) {
        throw new Error(`Part ${part.index} thất bại (HTTP ${res.status})`);
      }

      const buf = await readStream(res, {
        signal,
        limit,
        onChunk: (loaded) => {
          part.loaded = loaded;
          emit();
        },
      });

      const expected = part.end - part.start + 1;
      if (buf.byteLength !== expected && total > 0) {
        // Some servers ignore exact range end — accept if covers
        if (buf.byteLength < expected * 0.95) {
          throw new Error(
            `Part ${part.index} thiếu dữ liệu (${buf.byteLength}/${expected})`
          );
        }
      }

      buffers[part.index] = buf;
      part.loaded = buf.byteLength;
      part.done = true;
      await saveSegment?.(part.index, buf, {
        start: part.start,
        end: part.end,
      });
      emit();
    })
  );

  const out = new Uint8Array(total);
  for (const part of parts) {
    let buf = buffers[part.index];
    if (!buf) {
      buf = await loadSegment?.(part.index);
    }
    if (!buf) throw new Error(`Thiếu dữ liệu part ${part.index}`);
    out.set(buf, part.start);
  }

  const blob = new Blob([out], {
    type: info.contentType || "application/octet-stream",
  });
  return {
    blob,
    filename: info.filename,
    size: total,
    contentType: info.contentType,
    category: categorize(info.filename),
    connections: parts.length,
    parts: parts.map(({ index, start, end, loaded, done }) => ({
      index,
      start,
      end,
      loaded,
      done,
    })),
  };
}

async function downloadSingle({
  url,
  headers,
  signal,
  onProgress,
  knownTotal,
  filename,
  contentType,
  limit,
  loadSegment,
  saveSegment,
}) {
  const existing = await loadSegment?.(0);
  if (existing && knownTotal && existing.byteLength === knownTotal) {
    const name = filename || guessFilename(url, null);
    const blob = new Blob([existing], {
      type: contentType || "application/octet-stream",
    });
    return {
      blob,
      filename: name,
      size: blob.size,
      contentType: contentType || "",
      category: categorize(name),
      connections: 1,
      parts: [{ index: 0, start: 0, end: blob.size - 1, loaded: blob.size, done: true }],
    };
  }

  const res = await fetch(url, { headers, signal, credentials: "include" });
  if (!res.ok) throw new Error(`Tải thất bại (HTTP ${res.status})`);
  const total = knownTotal || Number(res.headers.get("content-length")) || 0;
  let lastTick = Date.now();
  let lastLoaded = 0;
  const buf = await readStream(res, {
    signal,
    limit,
    onChunk: (loaded) => {
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      const speed = dt > 0 ? (loaded - lastLoaded) / dt : 0;
      if (dt >= 0.3) {
        lastTick = now;
        lastLoaded = loaded;
      }
      const remaining = total > 0 ? Math.max(0, total - loaded) : null;
      const eta = speed > 0 && remaining != null ? remaining / speed : null;
      onProgress?.({
        loaded,
        total: total || loaded,
        speed,
        eta,
        connections: 1,
        parts: [
          {
            index: 0,
            start: 0,
            end: (total || loaded) - 1,
            loaded,
            done: false,
          },
        ],
      });
    },
  });

  await saveSegment?.(0, buf, { start: 0, end: buf.byteLength - 1 });

  const name =
    filename || guessFilename(url, res.headers.get("content-disposition"));
  const blob = new Blob([buf], {
    type: contentType || res.headers.get("content-type") || "application/octet-stream",
  });
  return {
    blob,
    filename: name,
    size: blob.size,
    contentType: contentType || res.headers.get("content-type") || "",
    category: categorize(name),
    connections: 1,
    parts: [
      {
        index: 0,
        start: 0,
        end: blob.size - 1,
        loaded: blob.size,
        done: true,
      },
    ],
  };
}
