/**
 * Per-domain routing: helper | accelerate | native | hls | auto
 */

const HELPER_SITE_RE =
  /(^|\.)(youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|vimeo\.com)$/i;

export function isHelperSiteHost(hostname) {
  return HELPER_SITE_RE.test(String(hostname || ""));
}

export function isHelperSiteUrl(url) {
  try {
    return isHelperSiteHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function isProbablyHlsUrl(url) {
  return /\.m3u8(?:$|[?#])/i.test(url || "");
}

/**
 * @param {string} hostname
 * @param {string} pattern  e.g. "youtube.com", "*.cdn.example.com"
 */
export function hostMatches(hostname, pattern) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  let p = String(pattern || "")
    .toLowerCase()
    .trim();
  if (!p || !host) return false;
  p = p.replace(/^https?:\/\//, "").split("/")[0];
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === p || host.endsWith("." + p);
}

/**
 * @param {string} url
 * @param {Array<{host:string, mode:string}>} rules
 */
export function matchDomainRule(url, rules = []) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  for (const rule of rules || []) {
    if (!rule?.host || !rule?.mode) continue;
    if (hostMatches(host, rule.host)) {
      return String(rule.mode).toLowerCase();
    }
  }
  return null;
}

/**
 * @returns {'helper'|'accelerate'|'native'|'hls'|'auto'}
 */
export function resolveRoute({
  url,
  settings,
  forceHelper = false,
  kind = null,
  probedSize = 0,
  ranged = false,
  helperConnected = false,
}) {
  if (forceHelper) return "helper";

  const ruled = matchDomainRule(url, settings?.domainRules);
  if (ruled && ruled !== "auto") {
    if (ruled === "helper" && !helperConnected && !isHelperSiteUrl(url)) {
      /* try other modes below */
    } else {
      return ruled;
    }
  }

  if (settings?.useNativeHelper !== false && isHelperSiteUrl(url)) {
    return "helper";
  }

  if (kind === "hls" || isProbablyHlsUrl(url)) {
    if (helperConnected && settings?.useNativeHelper !== false) {
      return "helper";
    }
    return "hls";
  }

  const offloadMB = Number(settings?.helperOffloadMinMB);
  const offloadBytes =
    (Number.isFinite(offloadMB) ? offloadMB : 200) * 1024 * 1024;
  if (
    helperConnected &&
    settings?.useNativeHelper !== false &&
    probedSize > 0 &&
    probedSize >= offloadBytes
  ) {
    return "helper";
  }

  if (settings?.downloadMode === "native") return "native";
  if (settings?.downloadMode === "accelerate") return "accelerate";

  const ACCEL_MIN = 1 * 1024 * 1024;
  const ACCEL_MAX = 512 * 1024 * 1024;
  if (
    settings?.downloadMode === "auto" &&
    ranged &&
    probedSize >= ACCEL_MIN &&
    probedSize <= ACCEL_MAX
  ) {
    return "accelerate";
  }

  return "native";
}

export const DEFAULT_DOMAIN_RULES = [
  { host: "youtube.com", mode: "helper" },
  { host: "youtu.be", mode: "helper" },
  { host: "facebook.com", mode: "helper" },
  { host: "fb.watch", mode: "helper" },
  { host: "instagram.com", mode: "helper" },
  { host: "tiktok.com", mode: "helper" },
  { host: "x.com", mode: "helper" },
  { host: "twitter.com", mode: "helper" },
  { host: "vimeo.com", mode: "helper" },
];
