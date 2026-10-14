(() => {
  const MEDIA_EXT =
    /\.(mp4|mkv|avi|mov|webm|m4v|mp3|flac|wav|aac|ogg|zip|rar|7z|tar|gz|iso|pdf|exe|msi|dmg|apk|epub)(?:$|\?|#)/i;

  let panel = null;
  let settingsCache = { snifferEnabled: true, snifferAutoShow: true };

  chrome.runtime.sendMessage({ type: "get-state" }, (state) => {
    if (state?.settings) settingsCache = { ...settingsCache, ...state.settings };
  });

  function isDownloadish(href) {
    if (!href) return false;
    try {
      const u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return false;
      if (MEDIA_EXT.test(u.pathname) || MEDIA_EXT.test(u.href)) return true;
      // query hints
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

  function collectCandidates() {
    const nodes = [
      ...document.querySelectorAll(
        "a[href], video[src], audio[src], source[src], video source, audio source"
      ),
    ];
    const urls = [];
    for (const el of nodes) {
      const href = el.href || el.src;
      if (isDownloadish(href)) urls.push(href);
    }
    // og:video
    const og = document.querySelector('meta[property="og:video"], meta[property="og:video:url"]');
    if (og?.content && isDownloadish(og.content)) urls.push(og.content);

    return [...new Set(urls)].slice(0, 30).map((url) => ({
      url,
      name: guessName(url),
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

  function showPanel(items) {
    if (!settingsCache.snifferEnabled) return;
    const root = ensureRoot();
    root.innerHTML = "";
    panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="head">
        <div class="title">PulseDM · ${items.length} tệp</div>
        <button type="button" data-act="close">Đóng</button>
      </div>
      <div class="body">
        ${items
          .map(
            (it, i) => `
          <div class="item" data-i="${i}">
            <div>
              <div class="name" title="${it.name}">${it.name}</div>
              <div class="meta">${it.url.slice(0, 64)}${it.url.length > 64 ? "…" : ""}</div>
            </div>
            <button class="dl" data-act="one" data-i="${i}">Tải</button>
          </div>`
          )
          .join("")}
      </div>
      <div class="foot">
        <button class="primary" data-act="all">Tải tất cả</button>
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

  // Ctrl+Shift+Y — toggle grabber (IDM-like hotkey spirit)
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey && e.shiftKey && (e.key === "Y" || e.key === "y"))) return;
    e.preventDefault();
    const items = collectCandidates();
    if (!items.length) {
      toast("Không thấy liên kết tải trên trang");
      return;
    }
    showPanel(items);
  });

  function autoScan() {
    if (!settingsCache.snifferEnabled || !settingsCache.snifferAutoShow) return;
    const items = collectCandidates();
    if (items.length >= 1) showPanel(items);
  }

  if (document.readyState === "complete") setTimeout(autoScan, 900);
  else window.addEventListener("load", () => setTimeout(autoScan, 900));

  // Re-scan on SPA-ish mutations (debounced)
  let moTimer = null;
  const mo = new MutationObserver(() => {
    if (!settingsCache.snifferAutoShow) return;
    clearTimeout(moTimer);
    moTimer = setTimeout(() => {
      if (panel) return;
      const items = collectCandidates();
      if (items.length >= 2) showPanel(items);
    }, 1500);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
