/** Shared media URL / Content-Type detection for network sniffer. */

export const MEDIA_URL_RE =
  /\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m3u8|mp3|m4a|aac|flac|ogg|wav|opus)(?:$|[?#])/i;

export const MEDIA_TYPE_RE =
  /^(video|audio)\//i;

export const HLS_TYPE_RE =
  /mpegurl|application\/vnd\.apple\.mpegurl|application\/x-mpegurl/i;

const SKIP_URL_RE =
  /(google-analytics|googletagmanager|doubleclick|facebook\.com\/tr|hotjar|sentry\.io|\/pixel|\/beacon|favicon|woff2?|ttf|otg?|css(?:$|\?)|js(?:$|\?))/i;

const SKIP_HOST_RE =
  /(googlevideo\.com\/videoplayback.*&range=|youtube\.com\/generate_204)/i;

export function headerMap(headers = []) {
  const map = {};
  for (const h of headers || []) {
    if (h?.name) map[h.name.toLowerCase()] = h.value || "";
  }
  return map;
}

export function guessMediaKind(url, contentType = "") {
  const ct = contentType.toLowerCase();
  if (HLS_TYPE_RE.test(ct) || /\.m3u8(?:$|[?#])/i.test(url)) return "hls";
  if (/^video\//i.test(ct) || /\.(mp4|m4v|webm|mkv|mov|avi|flv|ts)(?:$|[?#])/i.test(url)) {
    return "video";
  }
  if (/^audio\//i.test(ct) || /\.(mp3|m4a|aac|flac|ogg|wav|opus)(?:$|[?#])/i.test(url)) {
    return "audio";
  }
  return null;
}

export function shouldIgnoreUrl(url) {
  if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) return true;
  if (url.startsWith("blob:") || url.startsWith("data:")) return true;
  if (SKIP_URL_RE.test(url)) return true;
  if (SKIP_HOST_RE.test(url)) return true;
  return false;
}

export function isSniffableMedia(url, contentType = "", contentLength = 0) {
  if (shouldIgnoreUrl(url)) return false;
  const kind = guessMediaKind(url, contentType);
  if (!kind) return false;
  // Ignore tiny progressive chunks unless HLS playlist
  if (kind !== "hls" && contentLength > 0 && contentLength < 80 * 1024) return false;
  return true;
}

export function mediaFilename(url, contentType = "") {
  try {
    const u = new URL(url);
    let base = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    base = base.split("?")[0];
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
  } catch {
    /* ignore */
  }
  const kind = guessMediaKind(url, contentType);
  if (kind === "hls") return `stream-${Date.now()}.m3u8`;
  if (kind === "audio") return `audio-${Date.now()}.mp3`;
  return `video-${Date.now()}.mp4`;
}

export function formatBytesShort(n) {
  if (!n || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
