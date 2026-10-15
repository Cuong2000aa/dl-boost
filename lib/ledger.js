/**
 * Media Ledger — durable catalog of completed downloads (searchable “kho”).
 */

export const LEDGER_KEY = "pulsedm_ledger";
export const LEDGER_MAX = 800;

/** Stable content id (not cryptographic file hash — URL+size+name fingerprint). */
export async function contentFingerprint({ url = "", filename = "", size = 0 }) {
  const raw = `${String(url).split("?")[0]}|${filename}|${size || 0}`;
  try {
    const data = new TextEncoder().encode(raw);
    const dig = await crypto.subtle.digest("SHA-256", data);
    const hex = [...new Uint8Array(dig)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex.slice(0, 16);
  } catch {
    return `fp_${String(filename).slice(0, 24)}_${size || 0}`;
  }
}

export function ledgerEntryFromJob(job, extra = {}) {
  if (!job) return null;
  return {
    id: job.id,
    fingerprint: extra.fingerprint || null,
    url: job.url || "",
    referrer: job.referrer || "",
    filename: job.filename || "",
    category: job.category || "other",
    mode: job.mode || null,
    kind: job.kind || null,
    size: job.total || job.size || 0,
    localPath: job.localPath || null,
    chromeDownloadId: job.chromeDownloadId ?? null,
    pageTitle: extra.pageTitle || job.pageTitle || "",
    source: extra.source || job.source || job.mode || "download",
    completedAt: job.completedAt || Date.now(),
  };
}

export async function loadLedger() {
  const data = await chrome.storage.local.get(LEDGER_KEY);
  return Array.isArray(data[LEDGER_KEY]) ? data[LEDGER_KEY] : [];
}

export async function saveLedger(entries) {
  const list = (entries || []).slice(0, LEDGER_MAX);
  await chrome.storage.local.set({ [LEDGER_KEY]: list });
  return list;
}

export async function upsertLedgerEntry(entry) {
  if (!entry?.id) return null;
  if (!entry.fingerprint) {
    entry.fingerprint = await contentFingerprint(entry);
  }
  const list = await loadLedger();
  const idx = list.findIndex(
    (e) => e.id === entry.id || (e.fingerprint && e.fingerprint === entry.fingerprint)
  );
  if (idx >= 0) list.splice(idx, 1);
  list.unshift(entry);
  await saveLedger(list);
  return entry;
}

export function searchLedger(entries, query) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return entries || [];
  return (entries || []).filter((e) => {
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
