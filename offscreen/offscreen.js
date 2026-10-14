/**
 * Offscreen page: assemble IDB segments → blob URL → chrome.downloads.
 * Service workers cannot use URL.createObjectURL (MV3).
 */

import { listSegments, clearJobSegments } from "../lib/idb.js";
import { sanitizeFilename } from "../lib/filename.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "offscreen-save-job") return false;
  (async () => {
    const { jobId, filename, mimeType, totalSize } = msg;
    const rows = await listSegments(jobId);
    if (!rows.length) throw new Error("Không có segment để lưu");

    rows.sort((a, b) => a.partIndex - b.partIndex);
    const parts = rows.map((r) => {
      const buf = r.buffer;
      if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
      if (buf?.buffer instanceof ArrayBuffer) {
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
      return new Uint8Array(buf);
    });

    const blob = new Blob(parts, {
      type: mimeType || "application/octet-stream",
    });
    if (totalSize && blob.size < totalSize * 0.95) {
      throw new Error(
        `File lắp thiếu dữ liệu (${blob.size}/${totalSize} bytes)`
      );
    }

    const safeName = sanitizeFilename(filename);
    const objectUrl = URL.createObjectURL(blob);
    try {
      const downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename: safeName,
        saveAs: false,
        conflictAction: "uniquify",
      });
      await clearJobSegments(jobId);
      // Keep URL alive briefly so Chrome can read it
      setTimeout(() => URL.revokeObjectURL(objectUrl), 120_000);
      return { ok: true, downloadId, size: blob.size, filename: safeName };
    } catch (e) {
      URL.revokeObjectURL(objectUrl);
      throw e;
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: e?.message || String(e) }));
  return true;
});
