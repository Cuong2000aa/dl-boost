import { formatBytes, formatSpeed } from "../lib/download-engine.js";

const tbody = document.getElementById("tbody");
const empty = document.getElementById("empty");
const addForm = document.getElementById("addForm");
const urlInput = document.getElementById("urlInput");
const clearFinished = document.getElementById("clearFinished");
const cats = document.getElementById("cats");
const captureToggle = document.getElementById("captureToggle");
const connInput = document.getElementById("connInput");
const bigSpeed = document.getElementById("bigSpeed");
const bigActive = document.getElementById("bigActive");
const bigQueued = document.getElementById("bigQueued");
const bigDone = document.getElementById("bigDone");

let filter = "all";
let jobs = [];

const statusLabel = {
  queued: "Chờ",
  downloading: "Đang tải",
  paused: "Tạm dừng",
  completed: "Hoàn tất",
  error: "Lỗi",
  cancelled: "Đã hủy",
};

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function filteredJobs() {
  if (filter === "all") return jobs;
  if (filter === "downloading") {
    return jobs.filter((j) =>
      ["downloading", "queued", "paused"].includes(j.status)
    );
  }
  if (filter === "completed") {
    return jobs.filter((j) => j.status === "completed");
  }
  return jobs.filter((j) => j.category === filter);
}

function render() {
  const active = jobs.filter((j) => j.status === "downloading");
  const queued = jobs.filter((j) => j.status === "queued");
  const done = jobs.filter((j) => j.status === "completed");
  bigSpeed.textContent = formatSpeed(
    active.reduce((s, j) => s + (j.speed || 0), 0)
  );
  bigActive.textContent = String(active.length);
  bigQueued.textContent = String(queued.length);
  bigDone.textContent = String(done.length);

  const rows = filteredJobs();
  empty.classList.toggle("hidden", rows.length > 0);

  tbody.innerHTML = rows
    .map((j) => {
      const pct = j.total
        ? Math.min(100, Math.round((j.loaded / j.total) * 100))
        : j.status === "completed"
          ? 100
          : 0;
      return `
      <tr data-id="${j.id}">
        <td>
          <div class="fname" title="${escapeHtml(j.filename)}">${escapeHtml(j.filename)}</div>
          <span class="suburl" title="${escapeHtml(j.url)}">${escapeHtml(j.url)}</span>
        </td>
        <td class="progress">
          <div class="bar"><i style="width:${pct}%"></i></div>
          <div class="pct">${pct}%</div>
        </td>
        <td>${formatBytes(j.loaded)}${j.total ? " / " + formatBytes(j.total) : ""}</td>
        <td>${j.status === "downloading" ? formatSpeed(j.speed) : "—"}</td>
        <td class="status ${j.status}">${statusLabel[j.status] || j.status}${j.connections ? ` · ${j.connections} kết nối` : ""}${j.error ? `<div class="pct">${escapeHtml(j.error)}</div>` : ""}</td>
        <td>
          <div class="row-actions">
            ${
              j.status === "downloading"
                ? `<button data-act="pause">Pause</button>`
                : ["paused", "error", "queued"].includes(j.status)
                  ? `<button data-act="resume">Resume</button>`
                  : ""
            }
            ${
              !["completed", "cancelled"].includes(j.status)
                ? `<button data-act="cancel">Hủy</button>`
                : ""
            }
            <button data-act="remove">Xóa</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");
}

async function refresh() {
  const state = await send("get-state");
  jobs = state?.jobs || [];
  if (state?.settings) {
    captureToggle.checked = Boolean(state.settings.captureBrowserDownloads);
    connInput.value = state.settings.connections || 8;
  }
  render();
}

cats.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cat]");
  if (!btn) return;
  filter = btn.dataset.cat;
  cats.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  render();
});

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  await send("add-download", { payload: { url } });
  urlInput.value = "";
  refresh();
});

clearFinished.addEventListener("click", async () => {
  await send("clear-finished");
  refresh();
});

captureToggle.addEventListener("change", async () => {
  await send("save-settings", {
    settings: { captureBrowserDownloads: captureToggle.checked },
  });
});

connInput.addEventListener("change", async () => {
  const n = Math.max(1, Math.min(16, Number(connInput.value) || 8));
  connInput.value = n;
  await send("save-settings", { settings: { connections: n } });
});

tbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest("tr")?.dataset.id;
  if (!id) return;
  const act = btn.dataset.act;
  if (act === "pause") await send("pause", { id });
  if (act === "resume") await send("resume", { id });
  if (act === "cancel") await send("cancel", { id });
  if (act === "remove") await send("remove", { id });
  refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "jobs-updated") {
    jobs = msg.jobs || [];
    render();
  }
});

refresh();
setInterval(refresh, 1000);
