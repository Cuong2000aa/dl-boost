import {
  downloadMulti,
  categorize,
  guessFilename,
  probe,
} from "../lib/download-engine.js";

const STORAGE_KEY = "pulsedm_jobs";
const SETTINGS_KEY = "pulsedm_settings";

/** @type {Map<string, AbortController>} */
const controllers = new Map();

const defaultSettings = {
  connections: 8,
  captureBrowserDownloads: false,
  showNotifications: true,
  maxConcurrent: 3,
};

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...defaultSettings, ...(data[SETTINGS_KEY] || {}) };
}

async function getJobs() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
}

async function saveJobs(jobs) {
  await chrome.storage.local.set({ [STORAGE_KEY]: jobs });
  broadcast({ type: "jobs-updated", jobs });
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function uid() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function upsertJob(job) {
  const jobs = await getJobs();
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) jobs[idx] = job;
  else jobs.unshift(job);
  await saveJobs(jobs);
  return job;
}

async function updateJob(id, patch) {
  const jobs = await getJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  jobs[idx] = { ...jobs[idx], ...patch, updatedAt: Date.now() };
  await saveJobs(jobs);
  return jobs[idx];
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: defaultSettings,
  });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "pulsedm-download-link",
      title: "Tải bằng PulseDM",
      contexts: ["link", "image", "video", "audio"],
    });
    chrome.contextMenus.create({
      id: "pulsedm-download-page",
      title: "Tải trang / URL hiện tại bằng PulseDM",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "pulsedm-open-manager",
      title: "Mở PulseDM Manager",
      contexts: ["action"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "pulsedm-open-manager") {
    openManager();
    return;
  }
  const url =
    info.linkUrl || info.srcUrl || info.pageUrl || info.frameUrl || null;
  if (!url) return;
  await enqueueDownload({ url, referrer: info.pageUrl || "" });
});

function openManager() {
  const url = chrome.runtime.getURL("manager/manager.html");
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
}

/**
 * Optionally take over browser downloads (IDM-style grabber).
 * We cancel the native download and re-queue through PulseDM when enabled.
 */
chrome.downloads.onCreated.addListener(async (item) => {
  const settings = await getSettings();
  if (!settings.captureBrowserDownloads) return;
  if (!item.url || item.url.startsWith("blob:") || item.url.startsWith("data:")) {
    return;
  }
  // Skip our own saves
  if (item.byExtensionId === chrome.runtime.id) return;
  if (item.filename && item.filename.includes("PulseDM")) return;

  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch {
    /* may already be gone */
  }
  await enqueueDownload({
    url: item.finalUrl || item.url,
    filename: item.filename?.split(/[/\\]/).pop() || "",
    referrer: item.referrer || "",
  });
});

async function enqueueDownload({ url, filename = "", referrer = "", headers = {} }) {
  if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
    throw new Error("URL không hợp lệ");
  }

  let probed = null;
  try {
    probed = await probe(url, headers);
  } catch {
    probed = null;
  }

  const name =
    filename ||
    probed?.filename ||
    guessFilename(url, null);

  const job = {
    id: uid(),
    url,
    referrer,
    filename: name,
    category: categorize(name),
    status: "queued",
    loaded: 0,
    total: probed?.size || 0,
    speed: 0,
    connections: 0,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chromeDownloadId: null,
  };

  await upsertJob(job);
  pumpQueue();
  return job;
}

async function pumpQueue() {
  const settings = await getSettings();
  const jobs = await getJobs();
  const active = jobs.filter((j) => j.status === "downloading").length;
  const slots = Math.max(0, settings.maxConcurrent - active);
  if (slots <= 0) return;

  const queued = jobs.filter((j) => j.status === "queued").slice(0, slots);
  for (const job of queued) {
    startJob(job.id);
  }
}

async function startJob(id) {
  const jobs = await getJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job || (job.status !== "queued" && job.status !== "paused")) return;

  const settings = await getSettings();
  const controller = new AbortController();
  controllers.set(id, controller);

  await updateJob(id, {
    status: "downloading",
    error: null,
    speed: 0,
  });

  try {
    const result = await downloadMulti({
      url: job.url,
      headers: job.referrer ? { Referer: job.referrer } : {},
      connections: settings.connections,
      signal: controller.signal,
      onProgress: ({ loaded, total, speed }) => {
        updateJob(id, {
          loaded,
          total: total || job.total,
          speed,
          status: "downloading",
        });
      },
    });

    const blobUrl = URL.createObjectURL(result.blob);
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: result.filename,
      saveAs: false,
      conflictAction: "uniquify",
    });

    await updateJob(id, {
      status: "completed",
      loaded: result.size,
      total: result.size,
      speed: 0,
      connections: result.connections,
      filename: result.filename,
      category: result.category,
      chromeDownloadId: downloadId,
      error: null,
    });

    if (settings.showNotifications) {
      chrome.notifications.create(`done_${id}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "PulseDM — Tải xong",
        message: result.filename,
      });
    }

    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  } catch (err) {
    if (err?.name === "AbortError") {
      const current = (await getJobs()).find((j) => j.id === id);
      if (current?.status !== "cancelled") {
        await updateJob(id, { status: "paused", speed: 0 });
      }
    } else {
      await updateJob(id, {
        status: "error",
        speed: 0,
        error: err?.message || String(err),
      });
    }
  } finally {
    controllers.delete(id);
    pumpQueue();
  }
}

async function pauseJob(id) {
  const c = controllers.get(id);
  if (c) c.abort();
  await updateJob(id, { status: "paused", speed: 0 });
}

async function resumeJob(id) {
  await updateJob(id, { status: "queued", error: null, loaded: 0 });
  pumpQueue();
}

async function cancelJob(id) {
  const c = controllers.get(id);
  if (c) c.abort();
  await updateJob(id, { status: "cancelled", speed: 0 });
  controllers.delete(id);
  pumpQueue();
}

async function removeJob(id) {
  await cancelJob(id);
  const jobs = (await getJobs()).filter((j) => j.id !== id);
  await saveJobs(jobs);
}

async function clearFinished() {
  const jobs = (await getJobs()).filter(
    (j) => !["completed", "cancelled", "error"].includes(j.status)
  );
  await saveJobs(jobs);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "get-state": {
        const [jobs, settings] = await Promise.all([getJobs(), getSettings()]);
        return { jobs, settings };
      }
      case "add-download":
        return enqueueDownload(msg.payload || {});
      case "pause":
        await pauseJob(msg.id);
        return { ok: true };
      case "resume":
        await resumeJob(msg.id);
        return { ok: true };
      case "cancel":
        await cancelJob(msg.id);
        return { ok: true };
      case "remove":
        await removeJob(msg.id);
        return { ok: true };
      case "clear-finished":
        await clearFinished();
        return { ok: true };
      case "open-manager":
        openManager();
        return { ok: true };
      case "save-settings": {
        const next = { ...(await getSettings()), ...(msg.settings || {}) };
        await chrome.storage.local.set({ [SETTINGS_KEY]: next });
        return { settings: next };
      }
      case "probe-url":
        return probe(msg.url);
      default:
        return { error: "unknown" };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: e?.message || String(e) }));
  return true;
});

chrome.alarms.create("pulsedm-pump", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "pulsedm-pump") pumpQueue();
});
