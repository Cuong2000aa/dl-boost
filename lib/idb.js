/**
 * IndexedDB helpers for durable segment storage (true pause/resume).
 */

const DB_NAME = "pulsedm_v2";
const DB_VERSION = 1;
const STORE = "segments";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "key" });
        os.createIndex("jobId", "jobId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("aborted"));
  });
}

export function segmentKey(jobId, partIndex) {
  return `${jobId}::${partIndex}`;
}

export async function putSegment(jobId, partIndex, buffer, meta = {}) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({
    key: segmentKey(jobId, partIndex),
    jobId,
    partIndex,
    buffer,
    byteLength: buffer.byteLength,
    updatedAt: Date.now(),
    ...meta,
  });
  await txDone(tx);
  db.close();
}

export async function getSegment(jobId, partIndex) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const req = tx.objectStore(STORE).get(segmentKey(jobId, partIndex));
  const row = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  db.close();
  return row;
}

export async function listSegments(jobId) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const idx = tx.objectStore(STORE).index("jobId");
  const req = idx.getAll(jobId);
  const rows = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  db.close();
  return rows.sort((a, b) => a.partIndex - b.partIndex);
}

export async function clearJobSegments(jobId) {
  const rows = await listSegments(jobId);
  if (!rows.length) return;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const row of rows) store.delete(row.key);
  await txDone(tx);
  db.close();
}

export async function clearAllSegments() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  await txDone(tx);
  db.close();
}
