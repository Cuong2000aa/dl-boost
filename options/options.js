import { defaultSettings } from "../lib/settings.js";

const form = document.getElementById("form");
const saved = document.getElementById("saved");

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function rulesToText(rules) {
  return (rules || [])
    .map((r) => `${r.host}|${r.mode}`)
    .join("\n");
}

function textToRules(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [host, mode] = line.split("|").map((s) => s.trim());
      if (!host || !mode) return null;
      return { host, mode: mode.toLowerCase() };
    })
    .filter(Boolean);
}

function fill(settings) {
  const s = { ...defaultSettings, ...settings };
  form.downloadMode.value = s.downloadMode || "auto";
  form.connections.value = s.connections;
  form.maxConcurrent.value = s.maxConcurrent;
  form.speedLimitKb.value = Math.round((Number(s.speedLimit) || 0) / 1024);
  form.duplicatePolicy.value = s.duplicatePolicy;
  form.captureBrowserDownloads.checked = Boolean(s.captureBrowserDownloads);
  form.captureMinSizeMB.value = s.captureMinSizeMB;
  form.captureExtensions.value = s.captureExtensions;
  form.snifferEnabled.checked = Boolean(s.snifferEnabled);
  form.networkSnifferEnabled.checked = s.networkSnifferEnabled !== false;
  form.snifferAutoShow.checked = Boolean(s.snifferAutoShow);
  form.useNativeHelper.checked = s.useNativeHelper !== false;
  form.useTabAuth.checked = s.useTabAuth !== false;
  form.helperOffloadMinMB.value = s.helperOffloadMinMB ?? 200;
  form.helperDownloadDir.value = s.helperDownloadDir || "";
  form.domainRulesText.value = rulesToText(
    s.domainRules?.length ? s.domainRules : defaultSettings.domainRules
  );
  form.showNotifications.checked = Boolean(s.showNotifications);
  form.autoOpenManagerOnAdd.checked = Boolean(s.autoOpenManagerOnAdd);
}

function readForm() {
  return {
    downloadMode: form.downloadMode.value || "auto",
    connections: Math.max(1, Math.min(16, Number(form.connections.value) || 8)),
    maxConcurrent: Math.max(1, Math.min(10, Number(form.maxConcurrent.value) || 3)),
    speedLimit: Math.max(0, Number(form.speedLimitKb.value) || 0) * 1024,
    duplicatePolicy: form.duplicatePolicy.value,
    captureBrowserDownloads: form.captureBrowserDownloads.checked,
    captureMinSizeMB: Math.max(0, Number(form.captureMinSizeMB.value) || 0),
    captureExtensions: form.captureExtensions.value.trim(),
    snifferEnabled: form.snifferEnabled.checked,
    networkSnifferEnabled: form.networkSnifferEnabled.checked,
    snifferAutoShow: form.snifferAutoShow.checked,
    useNativeHelper: form.useNativeHelper.checked,
    useTabAuth: form.useTabAuth.checked,
    helperOffloadMinMB: Math.max(
      50,
      Math.min(10240, Number(form.helperOffloadMinMB.value) || 200)
    ),
    helperDownloadDir: form.helperDownloadDir.value.trim(),
    domainRules: textToRules(form.domainRulesText.value),
    showNotifications: form.showNotifications.checked,
    autoOpenManagerOnAdd: form.autoOpenManagerOnAdd.checked,
  };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await send("save-settings", { settings: readForm() });
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1600);
});

document.getElementById("openManager").addEventListener("click", () => {
  send("open-manager");
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  fill(defaultSettings);
  await send("save-settings", { settings: defaultSettings });
  saved.hidden = false;
});

document.getElementById("exportBtn").addEventListener("click", async () => {
  const data = await send("export-data");
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pulsedm-backup-${Date.now()}.json`;
  a.click();
});

document.getElementById("importFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const payload = JSON.parse(text);
  await send("import-data", { payload });
  const state = await send("get-state");
  fill(state.settings || defaultSettings);
  saved.hidden = false;
});

const state = await send("get-state");
fill(state?.settings || defaultSettings);
const extLabel = document.getElementById("extIdLabel");
if (extLabel) extLabel.textContent = state?.extensionId || chrome.runtime.id;
const helper = await send("native-status");
const hint = document.getElementById("helperHint");
if (hint && helper?.connected) {
  hint.insertAdjacentHTML(
    "beforeend",
    `<br><strong style="color:#2dd4bf">Helper đang chạy</strong>${
      helper.ytdlpReady ? " · yt-dlp OK" : " · chưa có yt-dlp"
    }${helper.ffmpegReady ? " · ffmpeg OK" : ""}`
  );
}
