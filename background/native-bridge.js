/**
 * Bridge to PulseDM native host (com.pulsedm.host).
 */

export const NATIVE_HOST = "com.pulsedm.host";

const SITE_HOST_RE =
  /(^|\.)(youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|vimeo\.com)$/i;

export function isHelperSiteUrl(url) {
  try {
    const host = new URL(url).hostname;
    return SITE_HOST_RE.test(host);
  } catch {
    return false;
  }
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
        error: "Native host timeout — chạy install-mac.sh với Extension ID",
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
    if (msg?.type === "done" || msg?.type === "error") {
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
  });

  return {
    cancel() {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}
