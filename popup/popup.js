import { formatBytes, formatSpeed, formatEta, escapeHtml } from "../lib/format.js";

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const form = document.getElementById("addForm");
const urlInput = document.getElementById("urlInput");
const openManager = document.getElementById("openManager");
const openOptions = document.getElementById("openOptions");
const captureToggle = document.getElementById("captureToggle");
const statActive = document.getElementById("statActive");
const statSpeed = document.getElementById("statSpeed");
const mediaList = document.getElementById("mediaList");
const mediaEmpty = document.getElementById("mediaEmpty");

let activeTabId = null;
let mediaItems = [];
let extensionId = "";
let helperInfo = null;

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

function render(jobs) {
  const active = jobs.filter((j) => j.status === "downloading");
  const speedSum = active.reduce((s, j) => s + (j.speed || 0), 0);
  statActive.textContent = `${active.length} đang tải`;
  statSpeed.textContent = formatSpeed(speedSum);

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
  mediaEmpty.style.display = mediaItems.length ? "none" : "block";
  mediaList.innerHTML = mediaItems
    .slice(0, 12)
    .map((it, i) => {
      const label = it.filename || it.name || it.url;
      const meta = [it.kind || "media", it.sizeLabel, it.source]
        .filter(Boolean)
        .join(" · ");
      return `
      <li class="media-item" data-i="${i}">
        <div class="media-info">
          <div class="name" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
          <div class="meta">${escapeHtml(meta)}</div>
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
  extensionId = extId || extensionId;
  const el = document.getElementById("helperStatus");
  const bar = document.getElementById("helperBar");
  if (!el || !bar) return;
  if (helper?.connected && helper?.ok !== false) {
    bar.classList.add("ok");
    bar.classList.remove("bad");
    el.textContent = helper.ytdlpReady
      ? `OK · yt-dlp ${helper.ytdlpVersion || ""}`.trim()
      : "OK · chưa có yt-dlp (brew install yt-dlp)";
  } else {
    bar.classList.add("bad");
    bar.classList.remove("ok");
    el.textContent = helper?.error
      ? `chưa cài (${helper.error.slice(0, 42)}…)`
      : "chưa cài — bấm Copy lệnh cài";
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
document.getElementById("copyInstall").addEventListener("click", async () => {
  const id = extensionId || (await send("get-state"))?.extensionId;
  if (!id) {
    alert("Không lấy được Extension ID — reload extension rồi thử lại");
    return;
  }
  const ua = navigator.userAgent || "";
  const isWin = /Windows/i.test(ua);
  const full = isWin
    ? [
        "cd PATH\\TO\\dl-boost",
        "Set-ExecutionPolicy -Scope Process Bypass",
        `.\\native-host\\install-win.ps1 -ExtensionId ${id}`,
        "winget install yt-dlp.yt-dlp",
      ].join("\n")
    : [
        "cd /Users/it/dl-boost/dl-boost",
        "chmod +x native-host/install-mac.sh",
        `./native-host/install-mac.sh ${id}`,
        "brew install yt-dlp",
      ].join("\n");
  try {
    await navigator.clipboard.writeText(full);
    alert(
      isWin
        ? "Đã copy lệnh Windows (PowerShell).\nSửa PATH\\TO\\dl-boost rồi chạy.\n(Không cần cài Python — dùng .exe sẵn.)"
        : "Đã copy lệnh Mac (Terminal).\nDán rồi Enter."
    );
  } catch {
    prompt("Copy lệnh này:", full);
  }
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
  await send("add-download", { payload: { url: it.url } });
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
