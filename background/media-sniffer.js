/**
 * Network media sniffer (IDM-style): watch webRequest for video/audio/HLS.
 */

import {
  headerMap,
  isSniffableMedia,
  guessMediaKind,
  mediaFilename,
  formatBytesShort,
} from "../lib/media-detect.js";

/** @type {Map<number, Map<string, object>>} tabId -> url -> item */
const tabMedia = new Map();
const MAX_PER_TAB = 80;

function getSettingsSnifferEnabled(getSettings) {
  return getSettings().then((s) => s.networkSnifferEnabled !== false);
}

export function initMediaSniffer({ getSettings, onTabMediaChanged }) {
  const emit = (tabId) => {
    const items = listTabMedia(tabId);
    onTabMediaChanged?.(tabId, items);
  };

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      handleHeaders(details, getSettings, emit).catch(() => {});
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      handleCompleted(details, getSettings, emit).catch(() => {});
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabMedia.delete(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" && changeInfo.url) {
      tabMedia.delete(tabId);
      emit(tabId);
    }
  });
}

async function handleHeaders(details, getSettings, emit) {
  if (!(await getSettingsSnifferEnabled(getSettings))) return;
  if (details.tabId < 0) return;
  if (details.initiator?.startsWith("chrome-extension://")) return;

  const headers = headerMap(details.responseHeaders);
  const ct = headers["content-type"] || "";
  const len = Number(headers["content-length"]) || 0;
  const url = details.url;
  if (!isSniffableMedia(url, ct, len)) return;

  upsert(details.tabId, {
    url,
    kind: guessMediaKind(url, ct),
    contentType: ct.split(";")[0],
    size: len,
    filename: mediaFilename(url, ct),
    method: details.method,
    statusCode: details.statusCode,
    timeStamp: details.timeStamp || Date.now(),
    source: "network",
  });
  emit(details.tabId);
}

async function handleCompleted(details, getSettings, emit) {
  if (!(await getSettingsSnifferEnabled(getSettings))) return;
  if (details.tabId < 0) return;
  const headers = headerMap(details.responseHeaders);
  const ct = headers["content-type"] || "";
  const len = Number(headers["content-length"]) || details.totalBytes || 0;
  if (!isSniffableMedia(details.url, ct, len)) return;
  upsert(details.tabId, {
    url: details.url,
    kind: guessMediaKind(details.url, ct),
    contentType: ct.split(";")[0],
    size: len,
    filename: mediaFilename(details.url, ct),
    statusCode: details.statusCode,
    timeStamp: details.timeStamp || Date.now(),
    source: "network",
  });
  emit(details.tabId);
}

function upsert(tabId, item) {
  if (!tabMedia.has(tabId)) tabMedia.set(tabId, new Map());
  const map = tabMedia.get(tabId);
  const prev = map.get(item.url);
  map.set(item.url, {
    ...prev,
    ...item,
    size: item.size || prev?.size || 0,
    seen: (prev?.seen || 0) + 1,
  });
  // Cap
  if (map.size > MAX_PER_TAB) {
    const keys = [...map.keys()];
    for (let i = 0; i < keys.length - MAX_PER_TAB; i++) map.delete(keys[i]);
  }
}

export function listTabMedia(tabId) {
  const map = tabMedia.get(tabId);
  if (!map) return [];
  return [...map.values()]
    .sort((a, b) => (b.timeStamp || 0) - (a.timeStamp || 0))
    .map((it) => ({
      ...it,
      sizeLabel: formatBytesShort(it.size),
    }));
}

export function clearTabMedia(tabId) {
  tabMedia.delete(tabId);
}

export function reportDomMedia(tabId, items = []) {
  for (const it of items) {
    if (!it?.url) continue;
    if (!isSniffableMedia(it.url, it.contentType || "", it.size || 0)) {
      // still allow video src even without headers
      if (!/\.(mp4|webm|m3u8|mp3|m4a)(?:$|[?#])/i.test(it.url)) continue;
    }
    upsert(tabId, {
      url: it.url,
      kind: guessMediaKind(it.url, it.contentType || "") || "video",
      contentType: it.contentType || "",
      size: it.size || 0,
      filename: it.filename || mediaFilename(it.url, it.contentType || ""),
      timeStamp: Date.now(),
      source: "dom",
    });
  }
  return listTabMedia(tabId);
}

export function mediaCount(tabId) {
  return tabMedia.get(tabId)?.size || 0;
}
