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

async function refresh() {
  const state = await send("get-state");
  if (state?.settings) {
    captureToggle.checked = Boolean(state.settings.captureBrowserDownloads);
  }
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "jobs-updated") render(msg.jobs || []);
});

refresh();
setInterval(refresh, 1000);
