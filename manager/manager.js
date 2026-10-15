import { formatBytes, formatSpeed, formatEta, formatTime, escapeHtml } from "../lib/format.js";
import { bytesPerSecToMbps, formatMbps } from "../lib/net-meter.js";
import { CATEGORY_LABELS } from "../lib/settings.js";

const tbody = document.getElementById("tbody");
const historyBody = document.getElementById("historyBody");
const ledgerBody = document.getElementById("ledgerBody");
const empty = document.getElementById("empty");
const historyEmpty = document.getElementById("historyEmpty");
const ledgerEmpty = document.getElementById("ledgerEmpty");
const addForm = document.getElementById("addForm");
const urlInput = document.getElementById("urlInput");
const scheduleInput = document.getElementById("scheduleInput");
const clearFinished = document.getElementById("clearFinished");
const catsEl = document.getElementById("cats");
const searchEl = document.getElementById("search");
const tabs = document.getElementById("tabs");
const bigSpeed = document.getElementById("bigSpeed");
const bigMbps = document.getElementById("bigMbps");
const probeMbps = document.getElementById("probeMbps");
const probeNetBtn = document.getElementById("probeNetBtn");
const probeHint = document.getElementById("probeHint");
const bigActive = document.getElementById("bigActive");
const bigQueued = document.getElementById("bigQueued");
const bigDone = document.getElementById("bigDone");
const scheduleDialog = document.getElementById("scheduleDialog");
const scheduleJobId = document.getElementById("scheduleJobId");
const scheduleWhen = document.getElementById("scheduleWhen");

let filter = "all";
let tab = "downloads";
let jobs = [];
let history = [];
let ledger = [];
let query = "";

const statusLabel = {
  queued: "Chờ",
  downloading: "Đang tải",
  paused: "Tạm dừng",
  completed: "Hoàn tất",
  error: "Lỗi",
  cancelled: "Đã hủy",
  scheduled: "Đã lên lịch",
};

const catOrder = [
  "all",
  "downloading",
  "scheduled",
  "completed",
  "video",
  "audio",
  "archive",
  "document",
  "program",
  "image",
  "other",
];

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function toLocalInputValue(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderCats() {
  catsEl.innerHTML = catOrder
    .map((c) => {
      const label = CATEGORY_LABELS[c] || c;
      return `<button type="button" data-cat="${c}" class="${filter === c ? "active" : ""}">${label}</button>`;
    })
    .join("");
}

function filteredJobs() {
  let list = jobs;
  if (filter === "downloading") {
    list = list.filter((j) =>
      ["downloading", "queued", "paused"].includes(j.status)
    );
  } else if (filter === "scheduled") {
    list = list.filter((j) => j.status === "scheduled");
  } else if (filter === "completed") {
    list = list.filter((j) => j.status === "completed");
  } else if (filter !== "all") {
    list = list.filter((j) => j.category === filter);
  }
  if (query) {
    const q = query.toLowerCase();
    list = list.filter(
      (j) =>
        j.filename?.toLowerCase().includes(q) ||
        j.url?.toLowerCase().includes(q)
    );
  }
  return list;
}

function partsHtml(j) {
  const parts = j.parts || [];
  if (!parts.length) {
    const pct = j.total ? Math.min(100, Math.round((j.loaded / j.total) * 100)) : 0;
    return `<div class="bar"><i style="width:${pct}%"></i></div><div class="pct">${pct}%</div>`;
  }
  const pct = j.total ? Math.min(100, Math.round((j.loaded / j.total) * 100)) : 0;
  return `
    <div class="parts">
      ${parts
        .map((p) => {
          const size = p.end - p.start + 1;
          const w = size > 0 ? Math.min(100, Math.round((p.loaded / size) * 100)) : 0;
          return `<span title="part ${p.index}"><i style="width:${p.done ? 100 : w}%"></i></span>`;
        })
        .join("")}
    </div>
    <div class="pct">${pct}% · ${parts.length} phần</div>`;
}

function renderDownloads() {
  const active = jobs.filter((j) => j.status === "downloading");
  const queued = jobs.filter((j) => j.status === "queued");
  const done = jobs.filter((j) => j.status === "completed");
  const speedSum = active.reduce((s, j) => s + (j.speed || 0), 0);
  bigSpeed.textContent = formatSpeed(speedSum);
  if (bigMbps) bigMbps.textContent = formatMbps(bytesPerSecToMbps(speedSum));
  bigActive.textContent = String(active.length);
  bigQueued.textContent = String(queued.length);
  bigDone.textContent = String(done.length);

  const rows = filteredJobs();
  empty.classList.toggle("hidden", rows.length > 0);

  tbody.innerHTML = rows
    .map((j) => {
      return `
      <tr data-id="${j.id}">
        <td>
          <div class="fname" title="${escapeHtml(j.filename)}">${escapeHtml(j.filename)}</div>
          <span class="suburl" title="${escapeHtml(j.url)}">${escapeHtml(j.url)}</span>
        </td>
        <td class="progress">${partsHtml(j)}</td>
        <td>${formatBytes(j.loaded)}${j.total ? " / " + formatBytes(j.total) : ""}</td>
        <td>
          ${j.status === "downloading" ? formatSpeed(j.speed) : "—"}
          <div class="pct">${j.status === "downloading" ? "ETA " + formatEta(j.eta) : j.status === "scheduled" ? formatTime(j.scheduledAt) : ""}</div>
        </td>
        <td>
          <div class="prio">
            <button type="button" data-act="prio-down" title="Giảm">−</button>
            <span>${j.priority || 0}</span>
            <button type="button" data-act="prio-up" title="Tăng">+</button>
          </div>
        </td>
        <td class="status ${j.status}">
          ${statusLabel[j.status] || j.status}
          ${j.connections ? `<div class="pct">${j.connections} kết nối</div>` : ""}
          ${j.error ? `<div class="pct">${escapeHtml(j.error)}</div>` : ""}
        </td>
        <td>
          <div class="row-actions">
            ${
              j.status === "downloading"
                ? `<button data-act="pause">Pause</button>`
                : ["paused", "error", "queued"].includes(j.status)
                  ? `<button data-act="resume">Resume</button>`
                  : j.status === "scheduled"
                    ? `<button data-act="resume">Chạy ngay</button>`
                    : ""
            }
            ${
              !["completed", "cancelled"].includes(j.status)
                ? `<button data-act="schedule">Lịch</button><button data-act="cancel">Hủy</button>`
                : ""
            }
            ${
              j.status === "completed"
                ? `<button data-act="open">Mở</button><button data-act="folder">Thư mục</button>`
                : ""
            }
            <button data-act="remove">Xóa</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");
}

function renderHistory() {
  let list = history;
  if (query) {
    const q = query.toLowerCase();
    list = list.filter(
      (h) =>
        h.filename?.toLowerCase().includes(q) ||
        h.url?.toLowerCase().includes(q)
    );
  }
  historyEmpty.classList.toggle("hidden", list.length > 0);
  historyBody.innerHTML = list
    .map(
      (h) => `
    <tr data-id="${h.id}">
      <td>
        <div class="fname">${escapeHtml(h.filename)}</div>
        <span class="suburl">${escapeHtml(h.url)}</span>
      </td>
      <td>${formatBytes(h.size)}</td>
      <td>${formatTime(h.completedAt)}</td>
      <td>
        <div class="row-actions">
          <button data-act="redownload">Tải lại</button>
          <button data-act="open">Mở</button>
          <button data-act="folder">Thư mục</button>
        </div>
      </td>
    </tr>`
    )
    .join("");
}

function renderLedger() {
  let list = ledger;
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((e) => {
      const hay = [
        e.filename,
        e.url,
        e.referrer,
        e.pageTitle,
        e.mode,
        e.source,
        e.fingerprint,
        e.localPath,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }
  if (ledgerEmpty) ledgerEmpty.classList.toggle("hidden", list.length > 0);
  if (!ledgerBody) return;
  ledgerBody.innerHTML = list
    .map((e) => {
      const src = [e.mode || e.source, e.fingerprint ? `#${e.fingerprint}` : ""]
        .filter(Boolean)
        .join(" · ");
      return `
    <tr data-id="${e.id}">
      <td>
        <div class="fname" title="${escapeHtml(e.pageTitle || e.filename)}">${escapeHtml(e.filename)}</div>
        <span class="suburl">${escapeHtml(e.url)}</span>
      </td>
      <td><span class="suburl">${escapeHtml(src)}</span></td>
      <td>${formatBytes(e.size)}</td>
      <td>${formatTime(e.completedAt)}</td>
      <td>
        <div class="row-actions">
          <button data-act="redownload">Tải lại</button>
          <button data-act="open">Mở</button>
          <button data-act="folder">Thư mục</button>
          <button data-act="remove-ledger">Xóa</button>
        </div>
      </td>
    </tr>`;
    })
    .join("");
}

function render() {
  renderCats();
  renderDownloads();
  renderHistory();
  renderLedger();
}

function showTab(name) {
  tab = name;
  tabs.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.getElementById("panel-downloads").classList.toggle("hidden", name !== "downloads");
  document.getElementById("panel-batch").classList.toggle("hidden", name !== "batch");
  document.getElementById("panel-history").classList.toggle("hidden", name !== "history");
  const ledgerPanel = document.getElementById("panel-ledger");
  if (ledgerPanel) ledgerPanel.classList.toggle("hidden", name !== "ledger");
  if (name === "batch") document.getElementById("batchUrls").focus();
}

async function refresh() {
  const state = await send("get-state");
  jobs = state?.jobs || [];
  history = state?.history || [];
  ledger = state?.ledger || [];
  render();
}

catsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cat]");
  if (!btn) return;
  filter = btn.dataset.cat;
  showTab("downloads");
  render();
});

tabs.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  showTab(btn.dataset.tab);
});

searchEl.addEventListener("input", () => {
  query = searchEl.value.trim();
  render();
});

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  const scheduledAt = scheduleInput.value
    ? new Date(scheduleInput.value).getTime()
    : null;
  await send("add-download", { payload: { url, scheduledAt } });
  urlInput.value = "";
  scheduleInput.value = "";
  refresh();
});

clearFinished.addEventListener("click", async () => {
  await send("clear-finished");
  refresh();
});

document.getElementById("openOptions").addEventListener("click", () => {
  send("open-options");
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

document.getElementById("batchAdd").addEventListener("click", async () => {
  const urls = document
    .getElementById("batchUrls")
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const scheduledAt = document.getElementById("batchSchedule").value
    ? new Date(document.getElementById("batchSchedule").value).getTime()
    : null;
  const res = await send("add-batch", {
    urls,
    extras: scheduledAt ? { scheduledAt } : {},
  });
  const ok = (res || []).filter((r) => r?.id).length;
  const fail = (res || []).filter((r) => r?.error).length;
  document.getElementById("batchResult").textContent =
    `Đã thêm ${ok} mục` + (fail ? `, ${fail} lỗi` : "");
  document.getElementById("batchUrls").value = "";
  showTab("downloads");
  refresh();
});

document.getElementById("pasteClipboard").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    const ta = document.getElementById("batchUrls");
    ta.value = ta.value ? ta.value + "\n" + text : text;
  } catch {
    document.getElementById("batchResult").textContent =
      "Không đọc được clipboard — dán thủ công (Ctrl+V).";
  }
});

document.getElementById("clearLedger")?.addEventListener("click", async () => {
  if (!confirm("Xóa toàn bộ Kho media?")) return;
  await send("clear-ledger");
  refresh();
});

document.getElementById("clearHistory").addEventListener("click", async () => {
  await send("clear-history");
  refresh();
});

tbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest("tr")?.dataset.id;
  if (!id) return;
  const act = btn.dataset.act;
  const job = jobs.find((j) => j.id === id);
  if (act === "pause") await send("pause", { id });
  if (act === "resume") await send("resume", { id });
  if (act === "cancel") await send("cancel", { id });
  if (act === "remove") await send("remove", { id });
  if (act === "open") await send("open-file", { id });
  if (act === "folder") await send("show-folder", { id });
  if (act === "prio-up") {
    await send("set-priority", { id, priority: (job?.priority || 0) + 1 });
  }
  if (act === "prio-down") {
    await send("set-priority", { id, priority: (job?.priority || 0) - 1 });
  }
  if (act === "schedule") {
    scheduleJobId.value = id;
    scheduleWhen.value = toLocalInputValue(
      job?.scheduledAt && job.scheduledAt > Date.now()
        ? job.scheduledAt
        : Date.now() + 3600_000
    );
    scheduleDialog.showModal();
    return;
  }
  refresh();
});

ledgerBody?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest("tr")?.dataset.id;
  if (!id) return;
  const act = btn.dataset.act;
  const entry = ledger.find((x) => x.id === id);
  if (act === "redownload" && entry?.url) {
    await send("add-download", {
      payload: {
        url: entry.url,
        filename: entry.filename,
        referrer: entry.referrer || "",
      },
    });
    showTab("downloads");
  }
  if (act === "open") await send("open-file", { id });
  if (act === "folder") await send("show-folder", { id });
  if (act === "remove-ledger") await send("remove-ledger", { id });
  refresh();
});

historyBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest("tr")?.dataset.id;
  if (!id) return;
  const act = btn.dataset.act;
  if (act === "redownload") await send("redownload-history", { id });
  if (act === "open") await send("open-file", { id });
  if (act === "folder") await send("show-folder", { id });
  refresh();
});

document.getElementById("scheduleSave").addEventListener("click", async (e) => {
  e.preventDefault();
  const id = scheduleJobId.value;
  const ts = new Date(scheduleWhen.value).getTime();
  await send("schedule", { id, scheduledAt: ts });
  scheduleDialog.close();
  refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "ledger-updated") {
    ledger = msg.ledger || [];
    renderLedger();
  }
  if (msg?.type === "jobs-updated") {
    jobs = msg.jobs || [];
    renderDownloads();
  }
  if (msg?.type === "history-updated") {
    history = msg.history || [];
    renderHistory();
  }
});

// Hash routes: #batch #history #scheduled #completed
function applyHash() {
  const hash = (location.hash || "").replace("#", "");
  if (hash === "batch") showTab("batch");
  else if (hash === "history") showTab("history");
  else if (hash === "ledger") showTab("ledger");
  else if (hash === "scheduled") {
    filter = "scheduled";
    showTab("downloads");
  } else if (hash === "completed") {
    filter = "completed";
    showTab("downloads");
  } else {
    showTab("downloads");
  }
  render();
}

probeNetBtn?.addEventListener("click", async () => {
  probeNetBtn.disabled = true;
  probeNetBtn.textContent = "Đang đo…";
  if (probeHint) probeHint.textContent = "Đang tải mẫu ~1.5MB để ước lượng bandwidth…";
  try {
    const res = await send("probe-bandwidth", { bytes: 1_500_000 });
    if (res?.error) throw new Error(res.error);
    if (probeMbps) probeMbps.textContent = formatMbps(res.mbps);
    if (probeHint) {
      probeHint.textContent = `Đo xong: ↓ ${formatMbps(res.mbps)} (peak ${formatMbps(res.peakMbps)}) · ${Number(res.elapsed || 0).toFixed(1)}s`;
    }
  } catch (e) {
    if (probeHint) probeHint.textContent = e?.message || "Đo mạng thất bại";
    if (probeMbps) probeMbps.textContent = "err";
  } finally {
    probeNetBtn.disabled = false;
    probeNetBtn.textContent = "Đo ngay";
  }
});

window.addEventListener("hashchange", applyHash);
renderCats();
applyHash();
refresh();
setInterval(refresh, 1200);
