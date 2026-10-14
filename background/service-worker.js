import {
  downloadMulti,
  categorize,
  guessFilename,
  probe,
  fileExtension,
} from "../lib/download-engine.js";
import { putSegment, getSegment, clearJobSegments } from "../lib/idb.js";
import { sanitizeFilename } from "../lib/filename.js";
import {
  STORAGE_KEY,
  HISTORY_KEY,
  SETTINGS_KEY,
  defaultSettings,
  matchesCapture,
} from "../lib/settings.js";
import {
  initMediaSniffer,
  listTabMedia,
  clearTabMedia,
  reportDomMedia,
} from "./media-sniffer.js";
import { isProbablyHls, downloadHlsToBuffer } from "../lib/hls.js";
import { guessMediaKind } from "../lib/media-detect.js";
import {
  probeNativeHost,
  startNativeJob as startNativePortJob,
  isHelperSiteUrl,
} from "./native-bridge.js";

/** @type {Map<string, AbortController>} */
const controllers = new Map();
/** jobId -> chrome.downloads id for native mode */
const nativeDownloadMap = new Map();
/** throttle progress writes */
const progressTimers = new Map();
/** jobs intentionally paused — block progress from flipping status back */
const pausedIds = new Set();
/** prevent double start */
const startingIds = new Set();
/** jobId -> cancel() for native helper port */
const nativeHelperCancels = new Map();
/** cached helper probe */
let helperStatusCache = { checkedAt: 0, data: null };

const ACCEL_MIN = 1 * 1024 * 1024; // 1 MB
const ACCEL_MAX = 1536 * 1024 * 1024; // 1.5 GB (keep RAM safe)

initMediaSniffer({
  getSettings: () => getSettings(),
  onTabMediaChanged: (tabId, items) => {
    broadcast({ type: "tab-media-updated", tabId, items });
  },
});

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

async function updateJob(id, patch) {
  const jobs = await getJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  jobs[idx] = { ...jobs[idx], ...patch, updatedAt: Date.now() };
  await saveJobs(jobs);
  return jobs[idx];
}

function scheduleProgressWrite(id, patch) {
  if (pausedIds.has(id)) return;
  const prev = progressTimers.get(id);
  if (prev) clearTimeout(prev);
  progressTimers.set(
    id,
    setTimeout(async () => {
      progressTimers.delete(id);
      if (pausedIds.has(id)) return;
      const jobs = await getJobs();
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx < 0) return;
      if (jobs[idx].status !== "downloading") return;
      jobs[idx] = { ...jobs[idx], ...patch, updatedAt: Date.now() };
      await chrome.storage.local.set({ [STORAGE_KEY]: jobs });
      broadcast({ type: "jobs-updated", jobs });
      updateBadge(jobs);
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
  // Reset stuck "downloading" after browser restart
  resetStaleDownloads().then(() => {
    pumpQueue();
    promoteScheduled();
  });
});

async function resetStaleDownloads() {
  const jobs = await getJobs();
  let changed = false;
  for (const j of jobs) {
    if (j.status === "downloading") {
      j.status = j.mode === "native" ? "queued" : "paused";
      j.speed = 0;
      j.eta = null;
      changed = true;
    }
  }
  if (changed) await saveJobs(jobs);
}

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

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "open-manager") openManager();
  if (command === "add-from-clipboard") openManager("batch");
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

  const name =
    item.filename?.split(/[/\\]/).pop() || guessFilename(item.url, null);
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

chrome.downloads.onChanged.addListener(async (delta) => {
  let jobId = null;
  for (const [jid, did] of nativeDownloadMap.entries()) {
    if (did === delta.id) {
      jobId = jid;
      break;
    }
  }
  if (!jobId) return;

  if (delta.state?.current === "in_progress" || delta.bytesReceived != null) {
    try {
      const [item] = await chrome.downloads.search({ id: delta.id });
      if (item) {
        scheduleProgressWrite(jobId, {
          loaded: item.bytesReceived || 0,
          total: item.totalBytes > 0 ? item.totalBytes : 0,
          speed: 0,
          status: "downloading",
          mode: "native",
        });
      }
    } catch {
      /* ignore */
    }
  }

  if (delta.state?.current === "complete") {
    nativeDownloadMap.delete(jobId);
    const [item] = await chrome.downloads.search({ id: delta.id });
    const doneJob = await updateJob(jobId, {
      status: "completed",
      loaded: item?.fileSize || item?.bytesReceived || 0,
      total: item?.fileSize || item?.totalBytes || 0,
      speed: 0,
      eta: 0,
      chromeDownloadId: delta.id,
      completedAt: Date.now(),
      error: null,
      mode: "native",
    });
    await pushHistory(doneJob);
    const settings = await getSettings();
    if (settings.showNotifications && doneJob) {
      chrome.notifications.create(`done_${jobId}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "PulseDM — Tải xong",
        message: doneJob.filename,
      });
    }
    pumpQueue();
  }

  if (delta.state?.current === "interrupted") {
    nativeDownloadMap.delete(jobId);
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (pausedIds.has(jobId)) {
      await updateJob(jobId, { status: "paused", speed: 0, eta: null });
    } else {
      await updateJob(jobId, {
        status: "error",
        speed: 0,
        eta: null,
        error: item?.error || "Tải bị gián đoạn",
      });
    }
    pumpQueue();
  }
});

async function enqueueDownload({
  url,
  filename = "",
  referrer = "",
  priority = 0,
  scheduledAt = null,
  category = null,
  forceHelper = false,
}) {
  if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
    throw new Error("URL không hợp lệ");
  }

  const settings = await getSettings();
  const jobs = await getJobs();

  if (settings.duplicatePolicy === "skip") {
    const dup = jobs.find(
      (j) => j.url === url && !["cancelled", "error"].includes(j.status)
    );
    if (dup) return dup;
  }
  if (settings.duplicatePolicy === "replace") {
    const dups = jobs.filter((j) => j.url === url);
    for (const d of dups) await removeJob(d.id, { silent: true });
  }

  let probed = null;
  try {
    probed = await probe(url);
  } catch {
    probed = null;
  }

  const name = sanitizeFilename(
    filename || probed?.filename || guessFilename(url, null)
  );
  const cat = category || categorize(name);
  const isScheduled = scheduledAt && scheduledAt > Date.now();

  const kind =
    guessMediaKind(url, probed?.contentType || "") ||
    (isProbablyHls(url) ? "hls" : null);

  const job = {
    id: uid(),
    url,
    referrer,
    filename: name,
    category: cat,
    ext: fileExtension(name),
    kind,
    status: isScheduled ? "scheduled" : "queued",
    priority: Number(priority) || 0,
    loaded: 0,
    total: probed?.size || 0,
    speed: 0,
    eta: null,
    connections: 0,
    parts: [],
    mode: null,
    forceHelper: Boolean(forceHelper) || isHelperSiteUrl(url),
    error: null,
    scheduledAt: isScheduled ? scheduledAt : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    chromeDownloadId: null,
    localPath: null,
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
    .sort(
      (a, b) =>
        (b.priority || 0) - (a.priority || 0) || a.createdAt - b.createdAt
    )
    .slice(0, slots);

  for (const job of queued) startJob(job.id);
}

function chooseMode(settings, probedSize, ranged) {
  const mode = settings.downloadMode || "auto";
  if (mode === "native") return "native";
  if (mode === "accelerate") return "accelerate";
  // auto
  if (
    ranged &&
    probedSize >= ACCEL_MIN &&
    probedSize <= ACCEL_MAX &&
    (settings.connections || 8) > 1
  ) {
    return "accelerate";
  }
  return "native";
}

async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts?.length) return;
  } catch {
    /* older Chromium */
  }
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen/offscreen.html",
      reasons: ["BLOBS"],
      justification: "Assemble downloaded segments and save via blob URL",
    });
  } catch (e) {
    const msg = e?.message || String(e);
    if (!/already exists|only one offscreen/i.test(msg)) throw e;
  }
}

function sendToOffscreen(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (res?.error) reject(new Error(res.error));
      else resolve(res);
    });
  });
}

async function refreshHelperStatus(force = false) {
  const now = Date.now();
  if (!force && helperStatusCache.data && now - helperStatusCache.checkedAt < 15000) {
    return helperStatusCache.data;
  }
  const data = await probeNativeHost();
  helperStatusCache = { checkedAt: now, data };
  return data;
}

async function startJob(id) {
  if (
    startingIds.has(id) ||
    controllers.has(id) ||
    nativeDownloadMap.has(id) ||
    nativeHelperCancels.has(id)
  ) {
    return;
  }
  startingIds.add(id);

  try {
    const jobs = await getJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job || !["queued", "paused"].includes(job.status)) return;

    pausedIds.delete(id);
    const settings = await getSettings();
    const helperSite = isHelperSiteUrl(job.url);
    const wantHelper =
      job.forceHelper ||
      settings.useNativeHelper === true ||
      (settings.useNativeHelper !== false && helperSite);

    if (wantHelper) {
      const st = await refreshHelperStatus(true);
      if (st?.connected) {
        await updateJob(id, {
          status: "downloading",
          error: null,
          speed: 0,
          mode: helperSite ? "ytdlp" : "native-helper",
          filename: sanitizeFilename(
            job.filename || guessFilename(job.url, null)
          ),
        });
        await startHelperJob(id, settings, helperSite ? "ytdlp" : "auto");
        return;
      }
      if (helperSite) {
        await updateJob(id, {
          status: "error",
          error:
            "Cần PulseDM Helper + yt-dlp. Xem Options → Native Helper (install-mac.sh).",
        });
        return;
      }
      // fall through to browser modes
    }

    let probed = null;
    try {
      probed = await probe(job.url);
    } catch {
      probed = null;
    }
    const isHls =
      job.kind === "hls" ||
      isProbablyHls(job.url) ||
      guessMediaKind(job.url, probed?.contentType || "") === "hls";

    const mode = isHls
      ? "hls"
      : chooseMode(
          settings,
          probed?.size || job.total || 0,
          Boolean(probed?.ranged)
        );

    await updateJob(id, {
      status: "downloading",
      error: null,
      speed: 0,
      mode,
      kind: isHls ? "hls" : job.kind,
      total: probed?.size || job.total || 0,
      filename: sanitizeFilename(
        job.filename || probed?.filename || guessFilename(job.url, null)
      ),
    });

    if (mode === "hls") {
      await startHlsJob(id, settings);
    } else if (mode === "native") {
      await startNativeJob(id);
    } else {
      await startAcceleratedJob(id, settings);
    }
  } finally {
    startingIds.delete(id);
  }
}

/**
 * Native host download (multi-conn disk / yt-dlp). Promise resolves when done/error.
 */
function startHelperJob(id, settings, engine = "auto") {
  return new Promise(async (resolve) => {
    const job = (await getJobs()).find((j) => j.id === id);
    if (!job) {
      resolve();
      return;
    }

    const handle = startNativePortJob(
      {
        type: "download",
        jobId: id,
        url: job.url,
        filename: job.filename,
        connections: settings.connections,
        engine,
        outDir: settings.helperDownloadDir || "",
      },
      async (msg) => {
        if (!msg) return;
        if (msg.type === "progress") {
          const patch = {
            status: "downloading",
            mode: msg.mode || engine,
            speed: 0,
          };
          if (msg.loaded != null) patch.loaded = msg.loaded;
          if (msg.total != null) patch.total = msg.total;
          if (msg.percent != null && !msg.total) {
            patch.loaded = Math.round(msg.percent);
            patch.total = 100;
          }
          if (msg.message) patch.error = null;
          scheduleProgressWrite(id, patch);
          return;
        }
        if (msg.type === "done" && msg.ok) {
          nativeHelperCancels.delete(id);
          const doneJob = await updateJob(id, {
            status: "completed",
            loaded: msg.size || job.total || 0,
            total: msg.size || job.total || 0,
            speed: 0,
            eta: 0,
            filename: sanitizeFilename(msg.filename || job.filename),
            mode: msg.mode || "native-helper",
            localPath: msg.path || null,
            completedAt: Date.now(),
            error: null,
          });
          await pushHistory(doneJob);
          if (settings.showNotifications) {
            chrome.notifications.create(`done_${id}`, {
              type: "basic",
              iconUrl: chrome.runtime.getURL("icons/icon128.png"),
              title: "PulseDM Helper — Tải xong",
              message: doneJob.filename,
            });
          }
          // File already on disk (default ~/Downloads/PulseDM)
          pumpQueue();
          resolve();
          return;
        }
        if (msg.type === "error") {
          nativeHelperCancels.delete(id);
          await updateJob(id, {
            status: "error",
            speed: 0,
            error: msg.error || "Native helper lỗi",
          });
          pumpQueue();
          resolve();
        }
      }
    );
    nativeHelperCancels.set(id, () => handle.cancel());
  });
}

async function startNativeJob(id) {
  const job = (await getJobs()).find((j) => j.id === id);
  if (!job) return;
  try {
    const downloadId = await chrome.downloads.download({
      url: job.url,
      filename: sanitizeFilename(job.filename),
      conflictAction: "uniquify",
      saveAs: false,
    });
    nativeDownloadMap.set(id, downloadId);
    await updateJob(id, {
      chromeDownloadId: downloadId,
      mode: "native",
      connections: 1,
    });
  } catch (err) {
    await updateJob(id, {
      status: "error",
      speed: 0,
      error: err?.message || String(err),
    });
    pumpQueue();
  }
}

async function startHlsJob(id, settings) {
  const job = (await getJobs()).find((j) => j.id === id);
  if (!job) return;

  const controller = new AbortController();
  controllers.set(id, controller);

  try {
    const result = await downloadHlsToBuffer({
      playlistUrl: job.url,
      headers: {},
      signal: controller.signal,
      onProgress: (p) => {
        scheduleProgressWrite(id, {
          loaded: p.loaded,
          total: p.total || 0,
          speed: p.speed,
          eta: p.eta,
          connections: 1,
          parts: p.parts,
          status: "downloading",
          mode: "hls",
          hlsProgress: p.hls,
        });
      },
    });

    const fname = sanitizeFilename(
      job.filename?.replace(/\.m3u8$/i, ".ts") || result.filenameHint
    );
    await putSegment(id, 0, result.buffer, {
      start: 0,
      end: result.size - 1,
    });

    await ensureOffscreen();
    let saveRes;
    let lastErr;
    for (let i = 0; i < 4; i++) {
      try {
        saveRes = await sendToOffscreen({
          type: "offscreen-save-job",
          jobId: id,
          filename: fname,
          mimeType: result.contentType,
          totalSize: result.size,
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
        await ensureOffscreen();
      }
    }
    if (lastErr) throw lastErr;

    const doneJob = await updateJob(id, {
      status: "completed",
      loaded: saveRes.size || result.size,
      total: saveRes.size || result.size,
      speed: 0,
      eta: 0,
      connections: 1,
      filename: saveRes.filename || fname,
      category: "video",
      ext: "ts",
      chromeDownloadId: saveRes.downloadId,
      completedAt: Date.now(),
      error: null,
      mode: "hls",
    });
    await pushHistory(doneJob);
    if (settings.showNotifications) {
      chrome.notifications.create(`done_${id}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "PulseDM — HLS xong",
        message: doneJob.filename,
      });
    }
  } catch (err) {
    if (err?.name === "AbortError" || pausedIds.has(id)) {
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

async function startAcceleratedJob(id, settings) {
  const job = (await getJobs()).find((j) => j.id === id);
  if (!job) return;

  const controller = new AbortController();
  controllers.set(id, controller);

  try {
    const result = await downloadMulti({
      jobId: id,
      url: job.url,
      headers: {},
      connections: settings.connections,
      speedLimit: Number(settings.speedLimit) || 0,
      signal: controller.signal,
      partsMeta: job.parts || [],
      preferredFilename: job.filename,
      assembleBlob: false,
      shouldContinue: () => !pausedIds.has(id),
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
          mode: "accelerate",
        });
      },
    });

    await ensureOffscreen();
    // Offscreen may need a tick after createDocument
    let saveRes;
    let lastErr;
    for (let i = 0; i < 4; i++) {
      try {
        saveRes = await sendToOffscreen({
          type: "offscreen-save-job",
          jobId: id,
          filename: result.filename,
          mimeType: result.contentType,
          totalSize: result.size,
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
        await ensureOffscreen();
      }
    }
    if (lastErr) throw lastErr;

    const doneJob = await updateJob(id, {
      status: "completed",
      loaded: saveRes.size || result.size,
      total: saveRes.size || result.size,
      speed: 0,
      eta: 0,
      connections: result.connections,
      filename: saveRes.filename || result.filename,
      category: result.category,
      ext: fileExtension(saveRes.filename || result.filename),
      parts: result.parts || [],
      chromeDownloadId: saveRes.downloadId,
      completedAt: Date.now(),
      error: null,
      mode: "accelerate",
    });

    await pushHistory(doneJob);

    if (settings.showNotifications) {
      chrome.notifications.create(`done_${id}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "PulseDM — Tải xong",
        message: doneJob.filename,
      });
    }
  } catch (err) {
    if (err?.name === "AbortError" || pausedIds.has(id)) {
      const current = (await getJobs()).find((j) => j.id === id);
      if (current && current.status !== "cancelled") {
        await updateJob(id, { status: "paused", speed: 0, eta: null });
      }
    } else {
      // Fallback: try native if accelerate failed
      const msg = err?.message || String(err);
      if (/HTTP|truy cập|Part |thiếu dữ liệu|CORS|Failed to fetch/i.test(msg)) {
        try {
          await updateJob(id, {
            mode: "native",
            error: null,
            status: "downloading",
          });
          await startNativeJob(id);
          return;
        } catch {
          /* fall through */
        }
      }
      await updateJob(id, {
        status: "error",
        speed: 0,
        eta: null,
        error: msg,
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
  pausedIds.add(id);
  const c = controllers.get(id);
  if (c) c.abort();

  const helperCancel = nativeHelperCancels.get(id);
  if (helperCancel) {
    helperCancel();
    nativeHelperCancels.delete(id);
  }

  const nativeId = nativeDownloadMap.get(id);
  if (nativeId != null) {
    try {
      await chrome.downloads.pause(nativeId);
    } catch {
      try {
        await chrome.downloads.cancel(nativeId);
      } catch {
        /* ignore */
      }
    }
  }
  await updateJob(id, { status: "paused", speed: 0, eta: null });
}

async function resumeJob(id) {
  pausedIds.delete(id);
  const job = (await getJobs()).find((j) => j.id === id);
  if (!job) return;

  const nativeId = nativeDownloadMap.get(id) || job.chromeDownloadId;
  if (job.mode === "native" && nativeId != null) {
    try {
      await chrome.downloads.resume(nativeId);
      nativeDownloadMap.set(id, nativeId);
      await updateJob(id, { status: "downloading", error: null, speed: 0 });
      return;
    } catch {
      nativeDownloadMap.delete(id);
    }
  }

  await updateJob(id, {
    status: "queued",
    scheduledAt: null,
    error: null,
    speed: 0,
  });
  pumpQueue();
}

async function cancelJob(id) {
  pausedIds.add(id);
  const c = controllers.get(id);
  if (c) c.abort();

  const helperCancel = nativeHelperCancels.get(id);
  if (helperCancel) {
    helperCancel();
    nativeHelperCancels.delete(id);
  }

  const nativeId = nativeDownloadMap.get(id);
  if (nativeId != null) {
    try {
      await chrome.downloads.cancel(nativeId);
    } catch {
      /* ignore */
    }
    nativeDownloadMap.delete(id);
  }

  await clearJobSegments(id);
  await updateJob(id, {
    status: "cancelled",
    speed: 0,
    eta: null,
    parts: [],
  });
  controllers.delete(id);
  pausedIds.delete(id);
  pumpQueue();
}

async function removeJob(id, { silent } = {}) {
  pausedIds.add(id);
  const c = controllers.get(id);
  if (c) c.abort();
  controllers.delete(id);
  const nativeId = nativeDownloadMap.get(id);
  if (nativeId != null) {
    try {
      await chrome.downloads.cancel(nativeId);
    } catch {
      /* ignore */
    }
    nativeDownloadMap.delete(id);
  }
  await clearJobSegments(id);
  const jobs = (await getJobs()).filter((j) => j.id !== id);
  if (silent) {
    await chrome.storage.local.set({ [STORAGE_KEY]: jobs });
    updateBadge(jobs);
  } else {
    await saveJobs(jobs);
  }
  pausedIds.delete(id);
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
  await pauseJob(id);
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
  return { version: 2, exportedAt: Date.now(), jobs, history, settings };
}

async function importData(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Dữ liệu không hợp lệ");
  }
  if (payload.settings) {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...defaultSettings, ...payload.settings },
    });
  }
  if (Array.isArray(payload.jobs)) await saveJobs(payload.jobs);
  if (Array.isArray(payload.history)) await saveHistory(payload.history);
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
  // Offscreen handles its own message type
  if (msg?.type === "offscreen-save-job") return false;

  (async () => {
    switch (msg?.type) {
      case "get-state": {
        const [jobs, settings, history, helper] = await Promise.all([
          getJobs(),
          getSettings(),
          getHistory(),
          refreshHelperStatus(false),
        ]);
        return {
          jobs,
          settings,
          history,
          helper,
          extensionId: chrome.runtime.id,
        };
      }
      case "native-status":
        return refreshHelperStatus(true);
      case "add-page-with-helper": {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.url) throw new Error("Không lấy được URL tab");
        return enqueueDownload({
          url: tab.url,
          filename: sanitizeFilename(tab.title || "page-video"),
          referrer: tab.url,
          forceHelper: true,
        });
      }
      case "add-download":
        return enqueueDownload({
          ...(msg.payload || {}),
          forceHelper: Boolean(msg.payload?.forceHelper),
        });
      case "add-batch":
        return enqueueBatch(msg.urls || [], msg.extras || {});
      case "get-tab-media": {
        const tabId = Number(msg.tabId);
        return { items: listTabMedia(tabId) };
      }
      case "clear-tab-media": {
        clearTabMedia(Number(msg.tabId));
        return { ok: true };
      }
      case "report-dom-media": {
        const tabId = Number(msg.tabId ?? _sender?.tab?.id);
        if (tabId >= 0) {
          return { items: reportDomMedia(tabId, msg.items || []) };
        }
        return { items: [] };
      }
      case "download-tab-media": {
        const tabId = Number(msg.tabId);
        const items = listTabMedia(tabId);
        const urls = (msg.urls || items.map((i) => i.url)).filter(Boolean);
        const pageUrl = msg.referrer || _sender?.tab?.url || "";
        return enqueueBatch(urls, { referrer: pageUrl });
      }
      case "get-active-tab-media": {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id) return { tabId: null, items: [] };
        return { tabId: tab.id, items: listTabMedia(tab.id), title: tab.title };
      }
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

getJobs().then(updateBadge).catch(() => {});
resetStaleDownloads().then(() => pumpQueue()).catch(() => {});
