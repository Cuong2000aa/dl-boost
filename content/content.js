(() => {
  const MEDIA_EXT =
    /\.(mp4|mkv|avi|mov|webm|mp3|flac|wav|zip|rar|7z|pdf|exe|msi|dmg|apk|iso)(?:$|\?)/i;

  function isDownloadish(href) {
    if (!href) return false;
    try {
      const u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return false;
      return MEDIA_EXT.test(u.pathname) || MEDIA_EXT.test(u.search);
    } catch {
      return false;
    }
  }

  function sendDownload(url) {
    chrome.runtime.sendMessage({
      type: "add-download",
      payload: { url, referrer: location.href },
    });
  }

  // Soft grabber on long-press / Alt+click for media-like links
  document.addEventListener(
    "click",
    (e) => {
      if (!e.altKey) return;
      const a = e.target.closest?.("a[href]");
      if (!a || !isDownloadish(a.href)) return;
      e.preventDefault();
      e.stopPropagation();
      sendDownload(a.href);
      flashToast("PulseDM đang xếp hàng tải…");
    },
    true
  );

  // Sniffer banner when page has obvious downloadable media
  function scanAndOffer() {
    const candidates = [
      ...document.querySelectorAll("a[href], video[src], audio[src], source[src]"),
    ]
      .map((el) => el.href || el.src)
      .filter(isDownloadish);

    if (!candidates.length) return;
    const unique = [...new Set(candidates)].slice(0, 5);
    showSniffer(unique);
  }

  let snifferEl = null;
  function showSniffer(urls) {
    if (snifferEl) return;
    snifferEl = document.createElement("div");
    snifferEl.id = "pulsedm-sniffer";
    snifferEl.innerHTML = `
      <style>
        #pulsedm-sniffer {
          all: initial;
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483646;
          font-family: "Segoe UI", system-ui, sans-serif;
          color: #e2e8f0;
        }
        #pulsedm-sniffer .card {
          background: #0f172a;
          border: 1px solid #1e293b;
          border-radius: 12px;
          padding: 12px 14px;
          width: min(320px, calc(100vw - 32px));
          box-shadow: 0 18px 40px rgba(2, 6, 23, 0.45);
        }
        #pulsedm-sniffer .title {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.02em;
          color: #2dd4bf;
          margin-bottom: 6px;
          display: block;
        }
        #pulsedm-sniffer .sub {
          font-size: 12px;
          color: #94a3b8;
          margin-bottom: 10px;
          display: block;
          line-height: 1.4;
        }
        #pulsedm-sniffer button {
          all: unset;
          cursor: pointer;
          display: inline-block;
          font-size: 12px;
          font-weight: 600;
          padding: 7px 10px;
          border-radius: 8px;
          margin-right: 6px;
          margin-top: 4px;
        }
        #pulsedm-sniffer .primary {
          background: #14b8a6;
          color: #042f2e;
        }
        #pulsedm-sniffer .ghost {
          color: #94a3b8;
        }
      </style>
      <div class="card">
        <span class="title">PulseDM phát hiện tệp</span>
        <span class="sub">${urls.length} liên kết tải có thể thêm vào hàng đợi.</span>
        <div>
          <button class="primary" data-act="all">Tải tất cả</button>
          <button class="ghost" data-act="close">Đóng</button>
        </div>
      </div>
    `;
    snifferEl.querySelector('[data-act="all"]').addEventListener("click", () => {
      urls.forEach(sendDownload);
      flashToast(`Đã thêm ${urls.length} mục vào PulseDM`);
      snifferEl.remove();
      snifferEl = null;
    });
    snifferEl.querySelector('[data-act="close"]').addEventListener("click", () => {
      snifferEl.remove();
      snifferEl = null;
    });
    document.documentElement.appendChild(snifferEl);
  }

  function flashToast(text) {
    const t = document.createElement("div");
    t.textContent = text;
    Object.assign(t.style, {
      position: "fixed",
      left: "50%",
      bottom: "72px",
      transform: "translateX(-50%)",
      background: "#0f172a",
      color: "#5eead4",
      padding: "10px 14px",
      borderRadius: "999px",
      fontFamily: "Segoe UI, system-ui, sans-serif",
      fontSize: "13px",
      zIndex: "2147483647",
      border: "1px solid #134e4a",
      boxShadow: "0 10px 30px rgba(0,0,0,.35)",
    });
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  if (document.readyState === "complete") scanAndOffer();
  else window.addEventListener("load", () => setTimeout(scanAndOffer, 800));
})();
