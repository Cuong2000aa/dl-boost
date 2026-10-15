/**
 * Build download headers (Referer + optional Cookie) for sniffed / page URLs.
 * Browser fetch may strip some forbidden headers; native helper applies them fully.
 * Use with credentials:"include" and declarativeNetRequest Referer rules when needed.
 */

export async function getTabUrl(tabId) {
  if (tabId == null || tabId < 0) return "";
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || "";
  } catch {
    return "";
  }
}

export async function cookieHeaderForUrl(url) {
  if (!chrome.cookies?.getAll) return "";
  try {
    const list = await chrome.cookies.getAll({ url });
    if (!list?.length) return "";
    return list.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

/**
 * @param {{ url: string, referrer?: string, useCookies?: boolean }} opts
 * @returns {Promise<Record<string,string>>}
 */
export async function buildDownloadHeaders({
  url,
  referrer = "",
  useCookies = true,
}) {
  const headers = {};
  const ref = String(referrer || "").trim();
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    headers.Referer = ref;
    try {
      headers.Origin = new URL(ref).origin;
    } catch {
      /* ignore */
    }
  }
  if (useCookies) {
    const cookie = await cookieHeaderForUrl(url);
    if (cookie) headers.Cookie = cookie;
  }
  return headers;
}

let dnrRuleSeq = 9000;

/**
 * Temporary DNR rule so extension fetch gets Referer (MV3 strips Referer on fetch).
 * @returns {Promise<number|null>} ruleId to remove later
 */
export async function installRefererRule(url, referrer) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return null;
  if (!referrer || !url) return null;
  const ruleId = dnrRuleSeq++;
  if (dnrRuleSeq > 9900) dnrRuleSeq = 9000;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "referer", operation: "set", value: referrer },
            ],
          },
          condition: {
            urlFilter: `|${url.split("?")[0]}`,
            resourceTypes: ["xmlhttprequest", "other", "media"],
          },
        },
      ],
    });
    return ruleId;
  } catch {
    return null;
  }
}

export async function removeRefererRule(ruleId) {
  if (ruleId == null || !chrome.declarativeNetRequest?.updateSessionRules) {
    return;
  }
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
    });
  } catch {
    /* ignore */
  }
}
