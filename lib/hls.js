/**
 * HLS helper: resolve playlist, download segments with IDB resume, optional remux via helper.
 */

function absUrl(base, ref) {
  return new URL(ref, base).href;
}

export function isProbablyHls(url) {
  return /\.m3u8(?:$|[?#])/i.test(url || "");
}

/**
 * @returns {Promise<{ mediaPlaylistUrl: string, segments: string[], targetDuration: number, variants?: object[] }>}
 */
/** List master playlist variants without downloading segments. */
export async function listHlsVariants(playlistUrl, headers = {}) {
  const text = await fetchText(playlistUrl, headers);
  if (/#EXT-X-KEY:/i.test(text) && /METHOD=(?!NONE)/i.test(text)) {
    return { encrypted: true, variants: [], mediaPlaylistUrl: playlistUrl };
  }
  if (/#EXT-X-STREAM-INF:/i.test(text)) {
    const variants = parseMaster(text, playlistUrl);
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    return { encrypted: false, variants, mediaPlaylistUrl: playlistUrl };
  }
  // Already a media playlist
  return {
    encrypted: false,
    variants: [{ url: playlistUrl, bandwidth: 0, resolution: "" }],
    mediaPlaylistUrl: playlistUrl,
  };
}

export async function resolveHls(playlistUrl, headers = {}) {
  const text = await fetchText(playlistUrl, headers);
  if (/#EXT-X-KEY:/i.test(text) && /METHOD=(?!NONE)/i.test(text)) {
    throw new Error(
      "HLS đang mã hóa (DRM/AES) — dùng Helper + yt-dlp nếu site hỗ trợ"
    );
  }

  if (/#EXT-X-STREAM-INF:/i.test(text)) {
    const variants = parseMaster(text, playlistUrl);
    if (!variants.length) throw new Error("Không đọc được HLS master playlist");
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    const best = await resolveHls(variants[0].url, headers);
    return { ...best, variants };
  }

  if (!/#EXTINF:/i.test(text)) {
    throw new Error("Playlist HLS không hợp lệ");
  }

  const segments = [];
  let targetDuration = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.split(":")[1]) || 0;
    }
    if (line.startsWith("#EXTINF:")) {
      const next = (lines[i + 1] || "").trim();
      if (next && !next.startsWith("#")) {
        segments.push(absUrl(playlistUrl, next));
        i++;
      }
    }
  }
  if (!segments.length) throw new Error("Playlist không có segment");
  if (segments.length > 2000) {
    throw new Error(
      `Quá nhiều segment (${segments.length}) — dùng Helper (yt-dlp → mp4)`
    );
  }
  return { mediaPlaylistUrl: playlistUrl, segments, targetDuration };
}

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const bw = /BANDWIDTH=(\d+)/i.exec(line);
    const res = /RESOLUTION=(\d+x\d+)/i.exec(line);
    const next = (lines[i + 1] || "").trim();
    if (!next || next.startsWith("#")) continue;
    out.push({
      url: absUrl(baseUrl, next),
      bandwidth: bw ? Number(bw[1]) : 0,
      resolution: res ? res[1] : "",
    });
    i++;
  }
  return out;
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Không tải playlist (HTTP ${res.status})`);
  return res.text();
}

/**
 * Download HLS segments with optional per-segment IDB resume.
 * @param {object} opts
 * @param {function} [opts.loadSegment] async (index) => Uint8Array|null
 * @param {function} [opts.saveSegment] async (index, buffer) => void
 * @param {number} [opts.resumeFrom] start index hint
 */
export async function downloadHlsToBuffer({
  playlistUrl,
  headers = {},
  signal,
  onProgress,
  loadSegment,
  saveSegment,
}) {
  const { segments } = await resolveHls(playlistUrl, headers);
  const chunks = new Array(segments.length);
  let loaded = 0;
  let lastTick = Date.now();
  let lastLoaded = 0;

  // Restore completed segments
  for (let i = 0; i < segments.length; i++) {
    const existing = await loadSegment?.(i);
    if (existing && existing.byteLength > 0) {
      chunks[i] = existing;
      loaded += existing.byteLength;
    }
  }

  for (let i = 0; i < segments.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (chunks[i]) {
      onProgress?.({
        loaded,
        total: 0,
        speed: 0,
        eta: null,
        connections: 1,
        hls: { index: i + 1, count: segments.length },
        parts: [
          {
            index: 0,
            start: 0,
            end: Math.max(0, loaded - 1),
            loaded,
            done: false,
          },
        ],
      });
      continue;
    }

    const res = await fetch(segments[i], {
      headers,
      signal,
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(
        `Segment ${i + 1}/${segments.length} lỗi HTTP ${res.status}`
      );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    chunks[i] = buf;
    loaded += buf.byteLength;
    await saveSegment?.(i, buf);

    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    const speed = dt > 0 ? (loaded - lastLoaded) / dt : 0;
    if (dt >= 0.35) {
      lastTick = now;
      lastLoaded = loaded;
    }
    onProgress?.({
      loaded,
      total: 0,
      speed,
      eta: null,
      connections: 1,
      hls: { index: i + 1, count: segments.length },
      parts: [
        {
          index: 0,
          start: 0,
          end: Math.max(0, loaded - 1),
          loaded,
          done: false,
        },
      ],
    });
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return {
    buffer: out,
    size: loaded,
    segmentCount: segments.length,
    filenameHint: `hls-${Date.now()}.ts`,
    contentType: "video/mp2t",
    needsRemux: true,
  };
}
