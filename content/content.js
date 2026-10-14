(() => {
  const MEDIA_EXT =
    /\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m3u8|mp3|m4a|aac|flac|ogg|wav|opus|zip|rar|7z|pdf|exe|dmg|apk)(?:$|\?|#)/i;

  let panel = null;
  let settingsCache = {
    snifferEnabled: true,
    snifferAutoShow: false,
    networkSnifferEnabled: true,
  };
  let lastNetworkItems = [];

  chrome.runtime.sendMessage({ type: "get-state" }, (state) => {
    if (chrome.runtime.lastError) return;
    if (state?.settings) settingsCache = { ...settingsCache, ...state.settings };
  });

  function esc(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function isDownloadish(href) {
    if (!href) return false;
    try {
      const u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return false;
      if (MEDIA_EXT.test(u.pathname) || MEDIA_EXT.test(u.href)) return true;
      if (/[?&](download|file|attachment)=/i.test(u.search)) return true;
      return false;
    } catch {
      return false;
    }
  }

  function guessName(url) {
    try {
      const path = new URL(url, location.href).pathname;
      return decodeURIComponent(path.split("/").filter(Boolean).pop() || url);
    } catch {
      return url;
    }
  }

  function collectDomMedia() {
    const urls = [];
    const nodes = document.querySelectorAll(
      "a[href], video[src], audio[src], source[src], video source, audio source"
    );
    for (const el of nodes) {
      const href = el.currentSrc || el.href || el.src;
      if (href && (isDownloadish(href) || /\.m3u8(?:$|[?#])/i.test(href))) {
        urls.push(href);
      }
    }
    for (const v of document.querySelectorAll("video, audio")) {
      try {
        if (v.currentSrc) urls.push(v.currentSrc);
      } catch {
        /* ignore */
      }
    }
    const og = document.querySelector(
      'meta[property="og:video"], meta[property="og:video:url"]'
    );
    if (og?.content) urls.push(og.content);

    return [...new Set(urls)]
      .filter((u) => /^https?:/i.test(u))
      .slice(0, 40)
      .map((url) => ({
        url,
        name: guessName(url),
        filename: guessName(url),
        kind: /\.m3u8/i.test(url) ? "hls" : "video",
        source: "dom",
      }));
  }

  function sendDownload(url) {
    chrome.runtime.sendMessage({
      type: "add-download",
      payload: { url, referrer: location.href },
    });
  }

  function toast(text) {
    document.getElementById("pulsedm-toast")?.remove();
    const t = document.createElement("div");
    t.id = "pulsedm-toast";
    t.textContent = text;
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  function ensureRoot() {
    let root = document.getElementById("pulsedm-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "pulsedm-root";
      document.documentElement.appendChild(root);
    }
    return root;
  }

  function kindLabel(k) {
    if (k === "hls") return "HLS";
    if (k === "audio") return "Audio";
    if (k === "video") return "Video";
    return k || "file";
  }

  function mergeItems(network, dom) {
    const map = new Map();
    for (const it of [...(network || []), ...(dom || [])]) {
      if (!it?.url) continue;
      const prev = map.get(it.url);
      map.set(it.url, {
        ...prev,
        ...it,
        name: it.filename || it.name || guessName(it.url),
        sizeLabel: it.sizeLabel || prev?.sizeLabel || "",
      });
    }
    return [...map.values()].slice(0, 50);
  }

  function showPanel(items) {
    if (!settingsCache.snifferEnabled) return;
    const root = ensureRoot();
    root.innerHTML = "";
    panel = document.createElement("div");
    panel.className = "panel";
    const list = items.length
      ? items
          .map(
            (it, i) => `
          <div class="item" data-i="${i}">
            <div>
              <div class="name" title="${esc(it.name)}">${esc(it.name)}</div>
              <div class="meta">${esc(kindLabel(it.kind))}${it.sizeLabel ? " · " + esc(it.sizeLabel) : ""}${it.source ? " · " + esc(it.source) : ""}</div>
            </div>
            <button class="dl" data-act="one" data-i="${i}">Tải</button>
          </div>`
          )
          .join("")
      : `<div class="meta" style="padding:10px">Chưa bắt được media. Phát video trên trang rồi bấm lại Cmd/Ctrl+Shift+Y.</div>`;

    panel.innerHTML = `
      <div class="head">
        <div class="title">PulseDM · ${items.length} media</div>
        <button type="button" data-act="close">Đóng</button>
      </div>
      <div class="body">${list}</div>
      <div class="foot">
        <button class="primary" data-act="all" ${items.length ? "" : "disabled"}>Tải tất cả</button>
        <button class="ghost" data-act="refresh">Quét lại</button>
        <button class="ghost" data-act="manager">Manager</button>
        <button class="ghost" data-act="close">Ẩn</button>
      </div>
    `;
    panel.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "close") {
        root.innerHTML = "";
        panel = null;
        return;
      }
      if (act === "manager") {
        chrome.runtime.sendMessage({ type: "open-manager" });
        return;
      }
      if (act === "refresh") {
        openGrabber();
        return;
      }
      if (act === "all") {
        items.forEach((it) => sendDownload(it.url));
        toast(`Đã thêm ${items.length} mục vào PulseDM`);
        root.innerHTML = "";
        panel = null;
        return;
      }
      if (act === "one") {
        const it = items[Number(btn.dataset.i)];
        if (it) {
          sendDownload(it.url);
          toast("Đã xếp hàng tải");
        }
      }
    });
    root.appendChild(panel);
  }

  function reportDom() {
    const dom = collectDomMedia();
    chrome.runtime.sendMessage(
      { type: "report-dom-media", items: dom },
      () => void chrome.runtime.lastError
    );
    return dom;
  }

  function openGrabber() {
    const dom = reportDom();
    chrome.runtime.sendMessage({ type: "get-active-tab-media" }, (res) => {
      if (chrome.runtime.lastError) {
        showPanel(dom);
        return;
      }
      lastNetworkItems = res?.items || [];
      const merged = mergeItems(lastNetworkItems, dom);
      showPanel(merged);
      if (!merged.length) toast("Chưa thấy media — phát video rồi thử lại");
    });
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!e.altKey) return;
      const a = e.target.closest?.("a[href]");
      if (!a || !isDownloadish(a.href)) return;
      e.preventDefault();
      e.stopPropagation();
      sendDownload(a.href);
      toast("PulseDM đang xếp hàng tải…");
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!(mod && e.shiftKey && (e.key === "Y" || e.key === "y"))) return;
    e.preventDefault();
    openGrabber();
  });

  // Watch video elements for src changes
  const mo = new MutationObserver(() => {
    reportDom();
  });
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "href"],
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "tab-media-updated") {
      lastNetworkItems = msg.items || [];
      if (panel) {
        showPanel(mergeItems(lastNetworkItems, collectDomMedia()));
      } else if (
        settingsCache.snifferAutoShow &&
        lastNetworkItems.length === 1
      ) {
        showPanel(mergeItems(lastNetworkItems, collectDomMedia()));
      }
    }
    if (msg?.type === "ping-dom-media") {
      reportDom();
      return;
    }
    if (msg?.type === "open-grabber") openGrabber();
  });

  // Periodic DOM report while videos play
  setInterval(() => {
    if (!settingsCache.networkSnifferEnabled && !settingsCache.snifferEnabled) {
      return;
    }
    reportDom();
  }, 4000);

  if (document.readyState === "complete") setTimeout(reportDom, 800);
  else window.addEventListener("load", () => setTimeout(reportDom, 800));
})();
