import {
  downloadMulti,
  categorize,
  guessFilename,
  probe,
  fileExtension,
} from "../lib/download-engine.js";
import { putSegment, getSegment, clearJobSegments } from "../lib/idb.js";
import {
  STORAGE_KEY,
  HISTORY_KEY,
  SETTINGS_KEY,
  defaultSettings,
  matchesCapture,
} from "../lib/settings.js";

/** @type {Map<string, AbortController>} */
const controllers = new Map();
/** throttle progress writes */
const progressTimers = new Map();

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...defaultSettings, ...(data[SETTINGS_KEY] || {}) };
}

async function getJobs() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
}

async function getHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return data[HISTORY_KEY] || [];
}

async function saveJobs(jobs) {
  await chrome.storage.local.set({ [STORAGE_KEY]: jobs });
  broadcast({ type: "jobs-updated", jobs });
  updateBadge(jobs);
}

async function saveHistory(history) {
  await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, 500) });
  broadcast({ type: "history-updated", history: history.slice(0, 500) });
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function uid(prefix = "job") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function updateBadge(jobs) {
  const n = jobs.filter((j) =>
    ["downloading", "queued"].includes(j.status)
  ).length;
  chrome.action.setBadgeBackgroundColor({ color: "#0f766e" });
  chrome.action.setBadgeText({ text: n > 0 ? String(n) : "" });
}

async function upsertJob(job) {
  const jobs = await getJobs();
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) jobs[idx] = job;
  else jobs.unshift(job);
  await saveJobs(jobs);
  return job;
}

async function updateJob(id, patch, { quiet } = {}) {
  const jobs = await getJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  jobs[idx] = { ...jobs[idx], ...patch, updatedAt: Date.now() };
  if (quiet) {
    // Debounced persist for high-freq progress
    await chrome.storage.local.set({ [STORAGE_KEY]: jobs });
    broadcast({ type: "jobs-updated", jobs });
    updateBadge(jobs);
  } else {
    await saveJobs(jobs);
  }
  return jobs[idx];
}

function scheduleProgressWrite(id, patch) {
  const prev = progressTimers.get(id);
  if (prev) clearTimeout(prev);
  progressTimers.set(
    id,
    setTimeout(() => {
      progressTimers.delete(id);
      updateJob(id, patch, { quiet: true });
    }, 250)
  );
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.local.get(SETTINGS_KEY);
  if (!existing[SETTINGS_KEY] || details.reason === "install") {
    await chrome.storage.local.set({ [SETTINGS_KEY]: defaultSettings });
  } else {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...defaultSettings, ...existing[SETTINGS_KEY] },
    });
  }
  setupMenus();
  chrome.alarms.create("pulsedm-tick", { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  setupMenus();
  chrome.alarms.create("pulsedm-tick", { periodInMinutes: 1 });
  pumpQueue();
  promoteScheduled();
});

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "pulsedm-download-link",
      title: "Tải bằng PulseDM",
      contexts: ["link", "image", "video", "audio"],
    });
    chrome.contextMenus.create({
      id: "pulsedm-download-link-schedule",
      title: "Lên lịch tải bằng PulseDM…",
      contexts: ["link", "image", "video", "audio"],
    });
    chrome.contextMenus.create({
      id: "pulsedm-download-page",
      title: "Tải URL trang bằng PulseDM",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "pulsedm-open-manager",
      title: "Mở PulseDM Manager",
      contexts: ["action", "page"],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "pulsedm-open-manager") {
    openManager();
    return;
  }
  const url =
    info.linkUrl || info.srcUrl || info.pageUrl || info.frameUrl || null;
  if (!url) return;
  if (info.menuItemId === "pulsedm-download-link-schedule") {
    await enqueueDownload({
      url,
      referrer: info.pageUrl || "",
      scheduledAt: Date.now() + 60 * 60 * 1000,
    });
    openManager("scheduled");
    return;
  }
  await enqueueDownload({ url, referrer: info.pageUrl || "" });
});

chrome.commands?.onCommand?.addListener?.(async (command) => {
  if (command === "open-manager") openManager();
  if (command === "add-from-clipboard") {
    // Clipboard not available in SW — open manager with batch focus
    openManager("batch");
  }
});

function openManager(hash = "") {
  const base = chrome.runtime.getURL("manager/manager.html");
  const url = hash ? `${base}#${hash}` : base;
  chrome.tabs.query({}, (tabs) => {
    const hit = (tabs || []).find((t) => t.url && t.url.startsWith(base));
    if (hit) {
      chrome.tabs.update(hit.id, { active: true, url });
      chrome.windows.update(hit.windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
}

chrome.downloads.onCreated.addListener(async (item) => {
  const settings = await getSettings();
  if (!settings.captureBrowserDownloads) return;
  if (!item.url || item.url.startsWith("blob:") || item.url.startsWith("data:")) {
    return;
  }
  if (item.byExtensionId === chrome.runtime.id) return;

  const name = item.filename?.split(/[/\\]/).pop() || guessFilename(item.url, null);
  if (!matchesCapture(name, item.fileSize || item.totalBytes || 0, settings)) {
    return;
  }

  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch {
    /* ignore */
  }
  await enqueueDownload({
    url: item.finalUrl || item.url,
    filename: name,
    referrer: item.referrer || "",
  });
});

async function enqueueDownload({
  url,
  filename = "",
  referrer = "",
  headers = {},
  priority = 0,
  scheduledAt = null,
  category = null,
}) {
  if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
    throw new Error("URL không hợp lệ");
  }

  const settings = await getSettings();
  const jobs = await getJobs();

  if (settings.duplicatePolicy === "skip") {
    const dup = jobs.find(
      (j) =>
        j.url === url &&
        !["cancelled", "error"].includes(j.status)
    );
    if (dup) return dup;
  }
  if (settings.duplicatePolicy === "replace") {
    const dups = jobs.filter((j) => j.url === url);
    for (const d of dups) {
      await removeJob(d.id, { silent: true });
    }
  }

  let probed = null;
  try {
    probed = await probe(url, headers);
  } catch {
    probed = null;
  }

  const name = filename || probed?.filename || guessFilename(url, null);
  const cat = category || categorize(name);
  const isScheduled = scheduledAt && scheduledAt > Date.now();

  const job = {
    id: uid(),
    url,
    referrer,
    filename: name,
    category: cat,
    ext: fileExtension(name),
    status: isScheduled ? "scheduled" : "queued",
    priority: Number(priority) || 0,
    loaded: 0,
    total: probed?.size || 0,
    speed: 0,
    eta: null,
    connections: 0,
    parts: [],
    error: null,
    scheduledAt: isScheduled ? scheduledAt : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    chromeDownloadId: null,
  };

  await upsertJob(job);

  if (settings.autoOpenManagerOnAdd) openManager();
  if (!isScheduled) pumpQueue();
  return job;
}

async function enqueueBatch(urls, extras = {}) {
  const results = [];
  for (const raw of urls) {
    const url = String(raw || "").trim();
    if (!url) continue;
    try {
      results.push(await enqueueDownload({ url, ...extras }));
    } catch (e) {
      results.push({ url, error: e?.message || String(e) });
    }
  }
  return results;
}

async function promoteScheduled() {
  const now = Date.now();
  const jobs = await getJobs();
  let changed = false;
  for (const j of jobs) {
    if (j.status === "scheduled" && j.scheduledAt && j.scheduledAt <= now) {
      j.status = "queued";
      j.updatedAt = now;
      changed = true;
    }
  }
  if (changed) {
    await saveJobs(jobs);
    pumpQueue();
  }
}

async function pumpQueue() {
  const settings = await getSettings();
  const jobs = await getJobs();
  const active = jobs.filter((j) => j.status === "downloading").length;
  const slots = Math.max(0, settings.maxConcurrent - active);
  if (slots <= 0) return;

  const queued = jobs
    .filter((j) => j.status === "queued")
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.createdAt - b.createdAt)
    .slice(0, slots);

  for (const job of queued) startJob(job.id);
}

async function startJob(id) {
  const jobs = await getJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job || !["queued", "paused"].includes(job.status)) return;

  const settings = await getSettings();
  const controller = new AbortController();
  controllers.set(id, controller);

  await updateJob(id, { status: "downloading", error: null, speed: 0 });

  try {
    const result = await downloadMulti({
      jobId: id,
      url: job.url,
      headers: job.referrer ? { Referer: job.referrer } : {},
      connections: settings.connections,
      speedLimit: Number(settings.speedLimit) || 0,
      signal: controller.signal,
      partsMeta: job.parts || [],
      loadSegment: async (partIndex) => {
        const row = await getSegment(id, partIndex);
        return row?.buffer || null;
      },
      saveSegment: async (partIndex, buffer, meta) => {
        await putSegment(id, partIndex, buffer, meta);
      },
      onProgress: ({ loaded, total, speed, eta, connections, parts }) => {
        scheduleProgressWrite(id, {
          loaded,
          total: total || job.total,
          speed,
          eta,
          connections,
          parts,
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

    await clearJobSegments(id);

    const doneJob = await updateJob(id, {
      status: "completed",
      loaded: result.size,
      total: result.size,
      speed: 0,
      eta: 0,
      connections: result.connections,
      filename: result.filename,
      category: result.category,
      ext: fileExtension(result.filename),
      parts: result.parts || [],
      chromeDownloadId: downloadId,
      completedAt: Date.now(),
      error: null,
    });

    await pushHistory(doneJob);

    if (settings.showNotifications) {
      chrome.notifications.create(`done_${id}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "PulseDM — Tải xong",
        message: result.filename,
      });
    }

    setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
  } catch (err) {
    if (err?.name === "AbortError") {
      const current = (await getJobs()).find((j) => j.id === id);
      if (current && current.status !== "cancelled") {
        await updateJob(id, { status: "paused", speed: 0, eta: null });
      }
    } else {
      await updateJob(id, {
        status: "error",
        speed: 0,
        eta: null,
        error: err?.message || String(err),
      });
    }
  } finally {
    controllers.delete(id);
    const t = progressTimers.get(id);
    if (t) clearTimeout(t);
    progressTimers.delete(id);
    pumpQueue();
  }
}

async function pushHistory(job) {
  if (!job) return;
  const history = await getHistory();
  history.unshift({
    id: job.id,
    url: job.url,
    filename: job.filename,
    category: job.category,
    size: job.total,
    completedAt: job.completedAt || Date.now(),
    chromeDownloadId: job.chromeDownloadId,
  });
  await saveHistory(history);
}

async function pauseJob(id) {
  const c = controllers.get(id);
  if (c) c.abort();
  await updateJob(id, { status: "paused", speed: 0, eta: null });
}

async function resumeJob(id) {
  const job = (await getJobs()).find((j) => j.id === id);
  if (!job) return;
  // Keep parts + IDB segments — true resume
  await updateJob(id, {
    status: "queued",
    scheduledAt: null,
    error: null,
    speed: 0,
  });
  pumpQueue();
}

async function cancelJob(id) {
  const c = controllers.get(id);
  if (c) c.abort();
  await clearJobSegments(id);
  await updateJob(id, {
    status: "cancelled",
    speed: 0,
    eta: null,
    parts: [],
  });
  controllers.delete(id);
  pumpQueue();
}

async function removeJob(id, { silent } = {}) {
  const c = controllers.get(id);
  if (c) c.abort();
  controllers.delete(id);
  await clearJobSegments(id);
  const jobs = (await getJobs()).filter((j) => j.id !== id);
  if (silent) {
    await chrome.storage.local.set({ [STORAGE_KEY]: jobs });
  } else {
    await saveJobs(jobs);
  }
  pumpQueue();
}

async function clearFinished() {
  const jobs = await getJobs();
  const keep = [];
  for (const j of jobs) {
    if (["completed", "cancelled", "error"].includes(j.status)) {
      await clearJobSegments(j.id);
    } else {
      keep.push(j);
    }
  }
  await saveJobs(keep);
}

async function setPriority(id, priority) {
  await updateJob(id, { priority: Number(priority) || 0 });
  pumpQueue();
}

async function scheduleJob(id, scheduledAt) {
  const ts = Number(scheduledAt);
  if (!ts || ts <= Date.now()) {
    await updateJob(id, { status: "queued", scheduledAt: null });
    pumpQueue();
    return;
  }
  const c = controllers.get(id);
  if (c) c.abort();
  await updateJob(id, {
    status: "scheduled",
    scheduledAt: ts,
    speed: 0,
    eta: null,
  });
}

async function openDownload(id) {
  const job = (await getJobs()).find((j) => j.id === id);
  if (job?.chromeDownloadId != null) {
    try {
      await chrome.downloads.open(job.chromeDownloadId);
      return { ok: true };
    } catch (e) {
      return { error: e?.message || String(e) };
    }
  }
  const hist = (await getHistory()).find((h) => h.id === id);
  if (hist?.chromeDownloadId != null) {
    try {
      await chrome.downloads.open(hist.chromeDownloadId);
      return { ok: true };
    } catch (e) {
      return { error: e?.message || String(e) };
    }
  }
  return { error: "Không tìm thấy file trên đĩa" };
}

async function showInFolder(id) {
  const job = (await getJobs()).find((j) => j.id === id);
  const dlId = job?.chromeDownloadId;
  if (dlId != null) {
    await chrome.downloads.show(dlId);
    return { ok: true };
  }
  const hist = (await getHistory()).find((h) => h.id === id);
  if (hist?.chromeDownloadId != null) {
    await chrome.downloads.show(hist.chromeDownloadId);
    return { ok: true };
  }
  return { error: "Không tìm thấy file" };
}

async function exportData() {
  const [jobs, history, settings] = await Promise.all([
    getJobs(),
    getHistory(),
    getSettings(),
  ]);
  return {
    version: 2,
    exportedAt: Date.now(),
    jobs,
    history,
    settings,
  };
}

async function importData(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Dữ liệu không hợp lệ");
  if (payload.settings) {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...defaultSettings, ...payload.settings },
    });
  }
  if (Array.isArray(payload.jobs)) {
    await saveJobs(payload.jobs);
  }
  if (Array.isArray(payload.history)) {
    await saveHistory(payload.history);
  }
  pumpQueue();
  return { ok: true };
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "pulsedm-tick") {
    promoteScheduled();
    pumpQueue();
  }
});

chrome.notifications.onClicked.addListener((nid) => {
  if (nid.startsWith("done_")) openManager("completed");
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "get-state": {
        const [jobs, settings, history] = await Promise.all([
          getJobs(),
          getSettings(),
          getHistory(),
        ]);
        return { jobs, settings, history };
      }
      case "add-download":
        return enqueueDownload(msg.payload || {});
      case "add-batch":
        return enqueueBatch(msg.urls || [], msg.extras || {});
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
      case "set-priority":
        await setPriority(msg.id, msg.priority);
        return { ok: true };
      case "schedule":
        await scheduleJob(msg.id, msg.scheduledAt);
        return { ok: true };
      case "open-manager":
        openManager(msg.hash || "");
        return { ok: true };
      case "open-options":
        chrome.runtime.openOptionsPage();
        return { ok: true };
      case "open-file":
        return openDownload(msg.id);
      case "show-folder":
        return showInFolder(msg.id);
      case "save-settings": {
        const next = { ...(await getSettings()), ...(msg.settings || {}) };
        await chrome.storage.local.set({ [SETTINGS_KEY]: next });
        broadcast({ type: "settings-updated", settings: next });
        pumpQueue();
        return { settings: next };
      }
      case "probe-url":
        return probe(msg.url);
      case "export-data":
        return exportData();
      case "import-data":
        return importData(msg.payload);
      case "clear-history":
        await saveHistory([]);
        return { ok: true };
      case "redownload-history": {
        const h = (await getHistory()).find((x) => x.id === msg.id);
        if (!h) throw new Error("Không có trong lịch sử");
        return enqueueDownload({ url: h.url, filename: h.filename });
      }
      case "get-settings-defaults":
        return defaultSettings;
      default:
        return { error: "unknown" };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: e?.message || String(e) }));
  return true;
});

// Initial badge
getJobs().then(updateBadge).catch(() => {});
