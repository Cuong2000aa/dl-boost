/**
 * Minimal HLS helper: resolve media playlist + list .ts/.m4s segment URLs.
 * Encrypted / complex multi-audio playlists are skipped with a clear error.
 */

function absUrl(base, ref) {
  return new URL(ref, base).href;
}

export function isProbablyHls(url) {
  return /\.m3u8(?:$|[?#])/i.test(url || "");
}

/**
 * @returns {Promise<{ mediaPlaylistUrl: string, segments: string[], targetDuration: number }>}
 */
export async function resolveHls(playlistUrl, headers = {}) {
  const text = await fetchText(playlistUrl, headers);
  if (/#EXT-X-KEY:/i.test(text) && /METHOD=(?!NONE)/i.test(text)) {
    throw new Error("HLS đang mã hóa (DRM/AES) — PulseDM chưa tải được");
  }

  // Master playlist → pick highest BANDWIDTH variant
  if (/#EXT-X-STREAM-INF:/i.test(text)) {
    const variants = parseMaster(text, playlistUrl);
    if (!variants.length) throw new Error("Không đọc được HLS master playlist");
    variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    return resolveHls(variants[0].url, headers);
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
  if (segments.length > 800) {
    throw new Error(`Quá nhiều segment (${segments.length}) — thử chế độ native hoặc URL mp4`);
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
 * Download HLS segments sequentially into one Uint8Array (MPEG-TS concat).
 */
export async function downloadHlsToBuffer({
  playlistUrl,
  headers = {},
  signal,
  onProgress,
}) {
  const { segments } = await resolveHls(playlistUrl, headers);
  const chunks = [];
  let loaded = 0;
  let lastTick = Date.now();
  let lastLoaded = 0;

  for (let i = 0; i < segments.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const res = await fetch(segments[i], {
      headers,
      signal,
      credentials: "include",
    });
    if (!res.ok) {
      throw new Error(`Segment ${i + 1}/${segments.length} lỗi HTTP ${res.status}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    chunks.push(buf);
    loaded += buf.byteLength;
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
  };
}
