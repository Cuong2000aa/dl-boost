/**
 * Bridge to PulseDM native host (com.pulsedm.host).
 */

import { isHelperSiteUrl as domainHelperSite } from "../lib/domain-rules.js";

export const NATIVE_HOST = "com.pulsedm.host";

export function isHelperSiteUrl(url) {
  return domainHelperSite(url);
}

export function probeNativeHost() {
  return new Promise((resolve) => {
    let done = false;
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      resolve({
        ok: false,
        connected: false,
        error: e?.message || String(e),
      });
      return;
    }

    const finish = (payload) => {
      if (done) return;
      done = true;
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      resolve(payload);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        connected: false,
        error: "Native host timeout — chạy install script với Extension ID",
      });
    }, 4000);

    port.onMessage.addListener((msg) => {
      clearTimeout(timer);
      if (msg?.type === "status" || msg?.type === "error") {
        finish({
          ok: Boolean(msg.ok ?? msg.ytdlpReady !== undefined),
          connected: true,
          ...msg,
        });
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError?.message;
      finish({
        ok: false,
        connected: false,
        error: err || "Native host disconnect",
      });
    });

    try {
      port.postMessage({ type: "status" });
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, connected: false, error: e?.message || String(e) });
    }
  });
}

/**
 * Start a native download; calls onEvent for progress/done/error.
 * @returns {{ cancel: () => void }}
 */
export function startNativeJob(payload, onEvent) {
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    onEvent?.({
      type: "error",
      error: e?.message || String(e),
      jobId: payload.jobId,
    });
    return { cancel() {} };
  }

  port.onMessage.addListener((msg) => {
    onEvent?.(msg);
    if (msg?.type === "done" || msg?.type === "error" || msg?.type === "cancelled") {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    if (err) {
      onEvent?.({
        type: "error",
        error: err,
        jobId: payload.jobId,
      });
    }
  });

  port.postMessage({
    type: payload.type || "download",
    jobId: payload.jobId,
    url: payload.url,
    filename: payload.filename,
    outDir: payload.outDir,
    connections: payload.connections,
    engine: payload.engine || "auto",
    ytdlpArgs: payload.ytdlpArgs,
    headers: payload.headers || {},
    referrer: payload.referrer || "",
    path: payload.path,
    reveal: payload.reveal,
  });

  return {
    cancel() {
      try {
        port.postMessage({ type: "cancel", jobId: payload.jobId });
      } catch {
        /* ignore */
      }
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Open or reveal a file path via native host. */
export function openNativePath(path, reveal = false) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: "timeout" });
    }, 5000);
    port.onMessage.addListener((msg) => {
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      resolve(msg?.ok ? { ok: true, path } : { ok: false, error: msg?.error || "fail" });
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
    });
    try {
      port.postMessage({
        type: reveal ? "reveal-path" : "open-path",
        path,
        reveal,
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
}

/** Remux .ts → .mp4 via ffmpeg on host. */
export function remuxNativePath(path) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: "timeout" });
    }, 120000);
    port.onMessage.addListener((msg) => {
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      if (msg?.type === "done" && msg.ok) resolve({ ok: true, ...msg });
      else resolve({ ok: false, error: msg?.error || "remux fail" });
    });
    try {
      port.postMessage({ type: "remux", path });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });
}
