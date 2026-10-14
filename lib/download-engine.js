/**
 * Multi-connection download engine (HTTP Range).
 * Falls back to a single stream when the server does not support ranges.
 */

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
    video: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts"],
    audio: ["mp3", "flac", "wav", "aac", "ogg", "m4a", "wma"],
    image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic"],
    archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "iso"],
    document: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv"],
    program: ["exe", "msi", "dmg", "pkg", "apk", "deb", "rpm", "appimage"],
  };
  for (const [cat, list] of Object.entries(map)) {
    if (list.includes(ext)) return cat;
  }
  return "other";
}

export function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 || i === 0 ? 1 : 2)} ${units[i]}`;
}

export function formatSpeed(bps) {
  if (!bps || bps < 1) return "0 B/s";
  return `${formatBytes(bps)}/s`;
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

function buildParts(size, connections) {
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
    parts.push({ index: i, start, end, loaded: 0 });
  }
  return parts;
}

async function readBody(res, onChunk, signal) {
  if (!res.body) throw new Error("Không có body phản hồi");
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
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

export async function downloadMulti({
  url,
  headers = {},
  connections = DEFAULT_CONNECTIONS,
  signal,
  onProgress,
}) {
  const info = await probe(url, headers);
  if (!info.ok) {
    throw new Error(`Không thể truy cập URL (HTTP ${info.status})`);
  }

  const total = info.size || 0;
  const useMulti = info.ranged && total > MIN_PART_SIZE * 2;

  if (!useMulti) {
    return downloadSingle({
      url,
      headers,
      signal,
      onProgress,
      knownTotal: total,
      filename: info.filename,
      contentType: info.contentType,
    });
  }

  const parts = buildParts(total, connections);
  const buffers = new Array(parts.length);
  let lastTick = Date.now();
  let lastLoaded = 0;

  const emit = () => {
    const loaded = parts.reduce((s, p) => s + p.loaded, 0);
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    const speed = dt > 0 ? (loaded - lastLoaded) / dt : 0;
    if (dt >= 0.35) {
      lastTick = now;
      lastLoaded = loaded;
    }
    onProgress?.({ loaded, total, speed });
  };

  await Promise.all(
    parts.map(async (part) => {
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
      const buf = await readBody(
        res,
        (loaded) => {
          part.loaded = loaded;
          emit();
        },
        signal
      );
      buffers[part.index] = buf;
      part.loaded = buf.byteLength;
      emit();
    })
  );

  const out = new Uint8Array(total);
  for (const part of parts) {
    const buf = buffers[part.index];
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
}) {
  const res = await fetch(url, {
    headers,
    signal,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Tải thất bại (HTTP ${res.status})`);
  }
  const total = knownTotal || Number(res.headers.get("content-length")) || 0;
  let lastTick = Date.now();
  let lastLoaded = 0;
  const buf = await readBody(
    res,
    (loaded) => {
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      const speed = dt > 0 ? (loaded - lastLoaded) / dt : 0;
      if (dt >= 0.35) {
        lastTick = now;
        lastLoaded = loaded;
      }
      onProgress?.({ loaded, total: total || loaded, speed });
    },
    signal
  );
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
  };
}
