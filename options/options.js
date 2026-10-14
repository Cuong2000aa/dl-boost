import { defaultSettings } from "../lib/settings.js";

const form = document.getElementById("form");
const saved = document.getElementById("saved");

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function fill(settings) {
  const s = { ...defaultSettings, ...settings };
  form.connections.value = s.connections;
  form.maxConcurrent.value = s.maxConcurrent;
  form.speedLimitKb.value = Math.round((Number(s.speedLimit) || 0) / 1024);
  form.duplicatePolicy.value = s.duplicatePolicy;
  form.captureBrowserDownloads.checked = Boolean(s.captureBrowserDownloads);
  form.captureMinSizeMB.value = s.captureMinSizeMB;
  form.captureExtensions.value = s.captureExtensions;
  form.snifferEnabled.checked = Boolean(s.snifferEnabled);
  form.snifferAutoShow.checked = Boolean(s.snifferAutoShow);
  form.showNotifications.checked = Boolean(s.showNotifications);
  form.autoOpenManagerOnAdd.checked = Boolean(s.autoOpenManagerOnAdd);
}

function readForm() {
  return {
    connections: Math.max(1, Math.min(16, Number(form.connections.value) || 8)),
    maxConcurrent: Math.max(1, Math.min(10, Number(form.maxConcurrent.value) || 3)),
    speedLimit: Math.max(0, Number(form.speedLimitKb.value) || 0) * 1024,
    duplicatePolicy: form.duplicatePolicy.value,
    captureBrowserDownloads: form.captureBrowserDownloads.checked,
    captureMinSizeMB: Math.max(0, Number(form.captureMinSizeMB.value) || 0),
    captureExtensions: form.captureExtensions.value.trim(),
    snifferEnabled: form.snifferEnabled.checked,
    snifferAutoShow: form.snifferAutoShow.checked,
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
