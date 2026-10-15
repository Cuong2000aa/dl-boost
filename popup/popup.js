import { formatBytes, formatSpeed, formatEta, escapeHtml } from "../lib/format.js";
import {
  createEma,
  createSampleRing,
  sumJobThroughput,
  bytesPerSecToMbps,
  formatMbps,
} from "../lib/net-meter.js";
import {
  buildInstallCommands,
  buildInstallScriptFile,
  downloadTextFile,
  isWindowsUa,
} from "../lib/install-helper.js";

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const form = document.getElementById("addForm");
const urlInput = document.getElementById("urlInput");
const openManager = document.getElementById("openManager");
const openOptions = document.getElementById("openOptions");
const captureToggle = document.getElementById("captureToggle");
const statActive = document.getElementById("statActive");
const mediaList = document.getElementById("mediaList");
const mediaEmpty = document.getElementById("mediaEmpty");
const netLiveSpeed = document.getElementById("netLiveSpeed");
const netLiveMbps = document.getElementById("netLiveMbps");
const netBarFill = document.getElementById("netBarFill");
const netSpark = document.getElementById("netSpark");
const netProbeResult = document.getElementById("netProbeResult");
const probeNetBtn = document.getElementById("probeNetBtn");

const speedEma = createEma(0.4);
const speedRing = createSampleRing(28);
let peakLiveBps = 1;
let lastProbe = null;

let activeTabId = null;
let mediaItems = [];
let extensionId = "";
let helperInfo = null;
let lastIntentProbe = null;

const intentBtn = document.getElementById("intentBtn");
const intentHint = document.getElementById("intentHint");
const intentQualities = document.getElementById("intentQualities");
const qualitySelect = document.getElementById("qualitySelect");
const intentConfirm = document.getElementById("intentConfirm");

const statusLabel = {
  queued: "chờ",
  downloading: "đang tải",
  paused: "tạm dừng",
  completed: "xong",
  error: "lỗi",
  cancelled: "hủy",
  scheduled: "lịch",
};

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function renderNetMeter(jobs) {
  const active = jobs.filter((j) => j.status === "downloading");
  const raw = sumJobThroughput(jobs);
  const smooth = speedEma.push(raw);
  if (smooth > peakLiveBps) peakLiveBps = smooth;
  // Decay peak slowly so bar stays meaningful
  peakLiveBps = Math.max(smooth, peakLiveBps * 0.995, 64 * 1024);
  speedRing.push(smooth);

  if (netLiveSpeed) netLiveSpeed.textContent = formatSpeed(smooth);
  if (netLiveMbps) {
    netLiveMbps.textContent = formatMbps(bytesPerSecToMbps(smooth));
  }
  if (statActive) {
    statActive.textContent = `${active.length} đang tải`;
  }
  if (netProbeResult && lastProbe && !probeNetBtn?.disabled) {
    netProbeResult.hidden = false;
    netProbeResult.textContent = `Đo mạng: ↓ ${formatMbps(lastProbe.mbps)} · peak ${formatMbps(lastProbe.peakMbps)}`;
  }
}

function render(jobs) {
  renderNetMeter(jobs);

  const show = jobs.slice(0, 8);
  listEl.innerHTML = show
    .map((j) => {
      const pct = j.total
        ? Math.min(100, Math.round((j.loaded / j.total) * 100))
        : j.status === "completed"
          ? 100
          : 0;
      return `
      <li class="item" data-id="${j.id}">
        <div class="item-top">
          <div class="name" title="${escapeHtml(j.filename)}">${escapeHtml(j.filename)}</div>
          <div class="badge ${j.status}">${statusLabel[j.status] || j.status}</div>
        </div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="meta">
          <span>${formatBytes(j.loaded)}${j.total ? " / " + formatBytes(j.total) : ""}</span>
          <span>${
            j.status === "downloading"
              ? formatSpeed(j.speed) + " · " + formatEta(j.eta)
              : pct
                ? pct + "%"
                : ""
          }</span>
        </div>
        <div class="actions">
          ${
            j.status === "downloading"
              ? `<button data-act="pause">Tạm dừng</button>`
              : ["paused", "error", "queued", "scheduled"].includes(j.status)
                ? `<button data-act="resume">Tiếp tục</button>`
                : ""
          }
          ${
            !["completed", "cancelled"].includes(j.status)
              ? `<button data-act="cancel">Hủy</button>`
              : `<button data-act="open">Mở</button>`
          }
          <button data-act="remove">Xóa</button>
        </div>
        ${j.error ? `<div class="meta" style="color:#fb7185;margin-top:6px">${escapeHtml(j.error)}</div>` : ""}
      </li>`;
    })
    .join("");

  emptyEl.classList.toggle("hidden", jobs.length > 0);
}

function renderMedia(items) {
  mediaItems = items || [];
  const box = document.getElementById("mediaBox");
  if (box) box.hidden = mediaItems.length === 0;
  if (mediaEmpty) mediaEmpty.hidden = true;
  mediaList.innerHTML = mediaItems
    .slice(0, 8)
    .map((it, i) => {
      const label = it.filename || it.name || it.url;
      const meta = [it.kind || "media", it.sizeLabel]
        .filter(Boolean)
        .join(" · ");
      return `
      <li class="media-item" data-i="${i}">
        <div class="media-info">
          <div class="name" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
          <span class="meta">${escapeHtml(meta)}</span>
        </div>
        <button type="button" data-act="dl">Tải</button>
      </li>`;
    })
    .join("");
}

async function refreshMedia() {
  // Ask content script to report DOM media first
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      activeTabId = tab.id;
      chrome.tabs.sendMessage(tab.id, { type: "ping-dom-media" }, () => {
        void chrome.runtime.lastError;
      });
      setTimeout(async () => {
        const res = await send("get-tab-media", { tabId: tab.id });
        renderMedia(res?.items || []);
      }, 300);
      const res = await send("get-active-tab-media");
      activeTabId = res?.tabId ?? tab.id;
      renderMedia(res?.items || []);
      return;
    }
  } catch {
    /* ignore */
  }
  const res = await send("get-active-tab-media");
  activeTabId = res?.tabId;
  renderMedia(res?.items || []);
}

function renderHelper(helper, extId) {
  helperInfo = helper;
  extensionId = extId || extensionId || chrome.runtime.id;
  const el = document.getElementById("helperStatus");
  const bar = document.getElementById("helperBar");
  const idLine = document.getElementById("extIdLine");
  if (!el || !bar) return;
  if (helper?.connected && helper?.ok !== false) {
    bar.classList.add("ok");
    bar.classList.remove("bad");
    el.textContent = helper.ytdlpReady
      ? `Helper OK · yt-dlp ${helper.ytdlpVersion || ""}`.trim()
      : "Helper OK · chưa có yt-dlp";
    if (idLine) idLine.hidden = true;
  } else {
    bar.classList.add("bad");
    bar.classList.remove("ok");
    const short = helper?.error
      ? String(helper.error).replace(
          /Specified native messaging host not found\.?/i,
          "chưa cài host"
        )
      : "chưa cài";
    el.textContent = `Helper: ${short.slice(0, 40)}`;
    if (idLine) {
      idLine.hidden = false;
      idLine.textContent = `ID: ${extensionId} · Copy lệnh hoặc tải Script → lưu vào native-host → chạy`;
    }
  }
}

async function refresh() {
  const state = await send("get-state");
  if (state?.settings) {
    captureToggle.checked = Boolean(state.settings.captureBrowserDownloads);
  }
  if (state?.extensionId) extensionId = state.extensionId;
  renderHelper(state?.helper, state?.extensionId);
  render(state?.jobs || []);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  await send("add-download", { payload: { url } });
  urlInput.value = "";
  refresh();
});

openManager.addEventListener("click", () => send("open-manager"));
openOptions.addEventListener("click", () => send("open-options"));
document.getElementById("batchBtn").addEventListener("click", () => {
  send("open-manager", { hash: "batch" });
});
document.getElementById("refreshMedia").addEventListener("click", () => {
  refreshMedia();
});
document.getElementById("helperPageBtn").addEventListener("click", async () => {
  const res = await send("add-page-with-helper");
  if (res?.error) {
    alert(res.error);
    return;
  }
  refresh();
});

function fillQualities(probe) {
  lastIntentProbe = probe;
  const qs = (probe?.qualities || []).filter((q) => q?.id && q?.label);
  if (!qs.length) {
    intentQualities.hidden = true;
    qualitySelect.innerHTML = "";
    return;
  }
  qualitySelect.innerHTML = qs
    .map(
      (q) =>
        `<option value="${escapeHtml(q.id)}">${escapeHtml(q.label)}</option>`
    )
    .join("");
  intentQualities.hidden = false;
  const bestLabel = probe.best?.label || qs[0]?.label || "";
  intentHint.className = "intent-hint ok";
  if (probe.mseBlob) {
    intentHint.textContent = `MSE/blob · ${bestLabel || "Helper trang"}`;
  } else if (probe.playing) {
    intentHint.textContent = `Đang phát · ${bestLabel}`;
  } else {
    intentHint.textContent = `Gợi ý · ${bestLabel}`;
  }
}

async function runIntentCapture(qualityId = "auto") {
  intentBtn.disabled = true;
  intentBtn.classList.add("busy");
  intentBtn.textContent = "Đang bắt…";
  intentHint.className = "intent-hint";
  intentHint.textContent = "Đang phân tích tab…";
  try {
    const res = await send("intent-capture", {
      tabId: activeTabId,
      qualityId,
    });
    if (res?.error) {
      intentHint.className = "intent-hint warn";
      intentHint.textContent = res.error;
      // Still show qualities if probe partially worked
      if (res.probe?.qualities?.length) fillQualities(res.probe);
      else if (res.probe) {
        const probe = await send("probe-intent", { tabId: activeTabId });
        if (probe?.ok) fillQualities(probe);
      }
      return;
    }
    intentHint.className = "intent-hint ok";
    intentHint.textContent = res.message || "Đã xếp hàng";
    intentQualities.hidden = true;
    refresh();
  } catch (e) {
    intentHint.className = "intent-hint warn";
    intentHint.textContent = e?.message || String(e);
  } finally {
    intentBtn.disabled = false;
    intentBtn.classList.remove("busy");
    intentBtn.textContent = "Tải đang phát";
  }
}

intentBtn.addEventListener("click", async () => {
  // First probe — if multiple qualities, show picker; else capture auto
  intentBtn.disabled = true;
  intentBtn.classList.add("busy");
  intentHint.textContent = "Đang phân tích tab…";
  try {
    const probe = await send("probe-intent", { tabId: activeTabId });
    if (!probe?.ok) {
      intentHint.className = "intent-hint warn";
      intentHint.textContent = probe?.error || "Không phân tích được tab";
      return;
    }
    fillQualities(probe);
    const qCount = probe.qualities?.length || 0;
    // Auto nếu ít lựa chọn / helper site / MSE blob (cần trang + yt-dlp)
    if (qCount <= 2 || probe.helperSite || probe.needsHelper || probe.mseBlob) {
      await runIntentCapture("auto");
    } else {
      intentHint.className = "intent-hint ok";
      intentHint.textContent = probe.playing
        ? "Đang phát — chọn chất lượng rồi Xác nhận"
        : "Chọn chất lượng (chưa thấy playing rõ) rồi Xác nhận";
    }
  } catch (e) {
    intentHint.className = "intent-hint warn";
    intentHint.textContent = e?.message || String(e);
  } finally {
    intentBtn.disabled = false;
    intentBtn.classList.remove("busy");
    intentBtn.textContent = "Tải đang phát";
  }
});

intentConfirm.addEventListener("click", async () => {
  const qid = qualitySelect.value || "auto";
  await runIntentCapture(qid);
});
document.getElementById("copyInstall").addEventListener("click", async () => {
  const id = extensionId || (await send("get-state"))?.extensionId || chrome.runtime.id;
  if (!id) {
    alert("Không lấy được Extension ID — reload extension rồi thử lại");
    return;
  }
  const repoHint = isWindowsUa()
    ? "PATH\\TO\\dl-boost"
    : "/Users/it/dl-boost/dl-boost";
  const full = buildInstallCommands(id, { repoHint });
  try {
    await navigator.clipboard.writeText(full);
    alert(
      isWindowsUa()
        ? "Đã copy lệnh PowerShell.\nSửa PATH\\TO\\dl-boost rồi chạy."
        : "Đã copy lệnh Terminal (Mac).\nDán rồi Enter."
    );
  } catch {
    prompt("Copy lệnh này:", full);
  }
});

document.getElementById("downloadInstall")?.addEventListener("click", async () => {
  const id = extensionId || (await send("get-state"))?.extensionId || chrome.runtime.id;
  const file = buildInstallScriptFile(id);
  downloadTextFile(file);
  alert(
    `Đã tải ${file.filename}\n\n1) Chuyển file vào thư mục native-host trong repo\n2) Chạy file đó (double-click / PowerShell)\n3) Reload PulseDM`
  );
});
document.getElementById("dlAllMedia").addEventListener("click", async () => {
  if (!mediaItems.length) return;
  await send("download-tab-media", {
    tabId: activeTabId,
    urls: mediaItems.map((i) => i.url),
  });
  refresh();
});

document.getElementById("pasteBtn").addEventListener("click", async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return;
    if (text.includes("\n")) {
      const urls = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      await send("add-batch", { urls });
    } else {
      await send("add-download", { payload: { url: text } });
    }
    refresh();
  } catch {
    urlInput.focus();
    urlInput.placeholder = "Dán URL vào đây…";
  }
});

captureToggle.addEventListener("change", async () => {
  await send("save-settings", {
    settings: { captureBrowserDownloads: captureToggle.checked },
  });
});

probeNetBtn?.addEventListener("click", async () => {
  probeNetBtn.disabled = true;
  probeNetBtn.textContent = "…";
  if (netProbeResult) {
    netProbeResult.hidden = false;
    netProbeResult.textContent = "Đang đo bandwidth…";
  }
  try {
    const res = await send("probe-bandwidth", { bytes: 1_500_000 });
    if (res?.error) throw new Error(res.error);
    lastProbe = res;
    netProbeResult.hidden = false;
    netProbeResult.textContent = `Đo: ↓ ${formatMbps(res.mbps)} · peak ${formatMbps(res.peakMbps)}`;
    speedEma.push(res.avgBps);
    if (res.avgBps > peakLiveBps) peakLiveBps = res.avgBps;
    if (netLiveSpeed) netLiveSpeed.textContent = formatSpeed(res.avgBps);
    if (netLiveMbps) netLiveMbps.textContent = formatMbps(res.mbps);
  } catch (e) {
    if (netProbeResult) {
      netProbeResult.hidden = false;
      netProbeResult.textContent = e?.message || "Đo mạng thất bại";
    }
  } finally {
    probeNetBtn.disabled = false;
    probeNetBtn.textContent = "Đo";
  }
});

listEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest(".item")?.dataset.id;
  if (!id) return;
  const act = btn.dataset.act;
  if (act === "pause") await send("pause", { id });
  if (act === "resume") await send("resume", { id });
  if (act === "cancel") await send("cancel", { id });
  if (act === "remove") await send("remove", { id });
  if (act === "open") await send("open-file", { id });
  refresh();
});

mediaList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act='dl']");
  if (!btn) return;
  const i = Number(btn.closest(".media-item")?.dataset.i);
  const it = mediaItems[i];
  if (!it) return;
  await send("add-download", {
    payload: {
      url: it.url,
      filename: it.filename || "",
      referrer: it.referrer || "",
    },
  });
  refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "jobs-updated") render(msg.jobs || []);
  if (msg?.type === "tab-media-updated" && msg.tabId === activeTabId) {
    renderMedia(msg.items || []);
  }
});

refresh();
refreshMedia();
setInterval(refresh, 1000);
