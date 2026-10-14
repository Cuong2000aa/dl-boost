export const STORAGE_KEY = "pulsedm_jobs";
export const HISTORY_KEY = "pulsedm_history";
export const SETTINGS_KEY = "pulsedm_settings";

export const defaultSettings = {
  connections: 8,
  maxConcurrent: 3,
  speedLimit: 0, // bytes/sec, 0 = unlimited
  /** auto | accelerate | native */
  downloadMode: "auto",
  captureBrowserDownloads: false,
  captureMinSizeMB: 1,
  captureExtensions:
    "zip,rar,7z,iso,exe,msi,dmg,apk,mp4,mkv,avi,mov,webm,mp3,flac,pdf",
  showNotifications: true,
  soundOnComplete: false,
  autoOpenManagerOnAdd: false,
  duplicatePolicy: "skip", // skip | allow | replace
  defaultCategory: "auto",
  savePathHint: "",
  snifferEnabled: true,
  snifferAutoShow: false, // less intrusive; Ctrl/Cmd+Shift+Y to open
  networkSnifferEnabled: true, // webRequest catch mp4/m3u8/hls
  /** Use native helper (Mac/Win) when available; auto for YT/FB/… */
  useNativeHelper: true,
  helperDownloadDir: "", // empty → ~/Downloads/PulseDM (or %USERPROFILE%\Downloads\PulseDM)
  theme: "dark",
  language: "vi",
};

export const CATEGORY_LABELS = {
  all: "Tất cả",
  downloading: "Đang tải",
  scheduled: "Đã lên lịch",
  completed: "Hoàn tất",
  video: "Video",
  audio: "Audio",
  archive: "Nén",
  document: "Tài liệu",
  program: "Chương trình",
  image: "Hình ảnh",
  other: "Khác",
};

export function parseExtList(str) {
  return String(str || "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
}

export function matchesCapture(filename, size, settings) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const allowed = parseExtList(settings.captureExtensions);
  if (allowed.length && ext && !allowed.includes(ext)) return false;
  const minBytes = (Number(settings.captureMinSizeMB) || 0) * 1024 * 1024;
  if (minBytes > 0 && size > 0 && size < minBytes) return false;
  return true;
}
