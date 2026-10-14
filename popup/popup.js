import { formatBytes, formatSpeed } from "../lib/download-engine.js";

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const form = document.getElementById("addForm");
const urlInput = document.getElementById("urlInput");
const openManager = document.getElementById("openManager");
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
      const pct = j.total ? Math.min(100, Math.round((j.loaded / j.total) * 100)) : 0;
      return `
      <li class="item" data-id="${j.id}">
        <div class="item-top">
          <div class="name" title="${escapeHtml(j.filename)}">${escapeHtml(j.filename)}</div>
          <div class="badge ${j.status}">${statusLabel[j.status] || j.status}</div>
        </div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="meta">
          <span>${formatBytes(j.loaded)}${j.total ? " / " + formatBytes(j.total) : ""}</span>
          <span>${j.status === "downloading" ? formatSpeed(j.speed) : pct ? pct + "%" : ""}</span>
        </div>
        <div class="actions">
          ${
            j.status === "downloading"
              ? `<button data-act="pause">Tạm dừng</button>`
              : j.status === "paused" || j.status === "error" || j.status === "queued"
                ? `<button data-act="resume">Tiếp tục</button>`
                : ""
          }
          ${
            j.status !== "completed" && j.status !== "cancelled"
              ? `<button data-act="cancel">Hủy</button>`
              : ""
          }
          <button data-act="remove">Xóa</button>
        </div>
        ${j.error ? `<div class="meta" style="color:#fb7185;margin-top:6px">${escapeHtml(j.error)}</div>` : ""}
      </li>`;
    })
    .join("");

  emptyEl.classList.toggle("hidden", jobs.length > 0);
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
  refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "jobs-updated") render(msg.jobs || []);
});

refresh();
setInterval(refresh, 1000);
