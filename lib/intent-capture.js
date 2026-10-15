/**
 * Intent Capture — pick "what the user is watching" from DOM + network session.
 */

import { formatBytesShort } from "./media-detect.js";

/**
 * Score a candidate media item. Higher = more likely "what's playing".
 * @param {object} it
 * @param {object} [ctx]
 */
export function scoreIntentCandidate(it, ctx = {}) {
  if (!it?.url) return -1;
  let s = 0;
  const kind = it.kind || "";

  if (it.playing) s += 1000;
  if (it.paused === false && it.readyState >= 2) s += 400;
  if (it.currentTime > 0.5) s += 200;
  if (it.source === "dom") s += 80;
  if (it.source === "network") s += 40;
  if (kind === "video" || kind === "hls") s += 120;
  if (kind === "audio") s += 40;
  if (kind === "hls") s += 60;

  const size = Number(it.size) || 0;
  if (size > 0) s += Math.min(300, Math.log10(size) * 40);

  const w = Number(it.videoWidth) || 0;
  const h = Number(it.videoHeight) || 0;
  if (w * h > 0) s += Math.min(200, Math.sqrt(w * h) / 20);

  // Prefer URL that matches active player currentSrc
  if (ctx.activeSrc && urlsLooselyEqual(ctx.activeSrc, it.url)) s += 800;

  // Recency
  const age = Date.now() - (it.timeStamp || 0);
  if (age >= 0 && age < 60_000) s += 50;
  if (age >= 0 && age < 10_000) s += 40;

  // Deprioritize tiny progressive chunks
  if (kind !== "hls" && size > 0 && size < 200 * 1024) s -= 200;

  return s;
}

export function urlsLooselyEqual(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.origin === ub.origin &&
      ua.pathname === ub.pathname &&
      (ua.search === ub.search || !ua.search || !ub.search)
    );
  } catch {
    return a === b;
  }
}

/**
 * Merge DOM playing probes + network sniff into ranked candidates.
 * @returns {{ candidates: object[], best: object|null, activeSrc: string }}
 */
export function resolveIntent(domProbes = [], networkItems = []) {
  const active = (domProbes || []).find((p) => p.playing) ||
    (domProbes || []).find((p) => p.currentSrc) ||
    null;
  const activeSrc = active?.currentSrc || "";

  const map = new Map();
  const upsert = (it) => {
    if (!it?.url || !/^https?:/i.test(it.url)) return;
    if (it.url.startsWith("blob:")) return;
    const prev = map.get(it.url);
    map.set(it.url, {
      ...prev,
      ...it,
      size: it.size || prev?.size || 0,
      playing: Boolean(it.playing || prev?.playing),
      referrer: it.referrer || prev?.referrer || "",
    });
  };

  for (const p of domProbes || []) {
    if (p.currentSrc) {
      upsert({
        url: p.currentSrc,
        kind: p.kind || (/\.m3u8/i.test(p.currentSrc) ? "hls" : "video"),
        source: "dom",
        playing: p.playing,
        paused: p.paused,
        currentTime: p.currentTime,
        duration: p.duration,
        videoWidth: p.videoWidth,
        videoHeight: p.videoHeight,
        readyState: p.readyState,
        filename: p.filename,
        timeStamp: Date.now(),
        referrer: p.pageUrl || "",
      });
    }
    for (const u of p.sources || []) upsert({
      url: u,
      kind: /\.m3u8/i.test(u) ? "hls" : "video",
      source: "dom",
      playing: p.playing,
      referrer: p.pageUrl || "",
      timeStamp: Date.now(),
    });
  }

  for (const n of networkItems || []) upsert(n);

  const ctx = { activeSrc };
  const candidates = [...map.values()]
    .map((it) => ({
      ...it,
      score: scoreIntentCandidate(it, ctx),
      sizeLabel: it.sizeLabel || formatBytesShort(it.size),
      label: qualityLabel(it),
    }))
    .filter((it) => it.score >= 0)
    .sort((a, b) => b.score - a.score);

  return {
    candidates,
    best: candidates[0] || null,
    activeSrc,
    playing: Boolean(active?.playing),
    pageTitle: active?.pageTitle || "",
  };
}

export function qualityLabel(it) {
  const bits = [];
  if (it.resolution) bits.push(it.resolution);
  else if (it.videoHeight) bits.push(`${it.videoHeight}p`);
  if (it.bandwidth) bits.push(`${Math.round(it.bandwidth / 1000)}kbps`);
  if (it.kind) bits.push(String(it.kind).toUpperCase());
  if (it.sizeLabel) bits.push(it.sizeLabel);
  if (it.playing) bits.push("đang phát");
  return bits.join(" · ") || "Auto";
}

/**
 * Build quality options from HLS master variants + progressive fallbacks.
 */
export function buildQualityOptions({ variants = [], best, candidates = [] }) {
  const opts = [];
  if (variants?.length) {
    const sorted = [...variants].sort(
      (a, b) => (b.bandwidth || 0) - (a.bandwidth || 0)
    );
    for (const v of sorted) {
      const h = /x(\d+)$/i.exec(v.resolution || "")?.[1];
      opts.push({
        id: `hls:${v.bandwidth || 0}:${v.url}`,
        url: v.url,
        kind: "hls",
        resolution: v.resolution || "",
        bandwidth: v.bandwidth || 0,
        label: [h ? `${h}p` : v.resolution, v.bandwidth ? `${Math.round(v.bandwidth / 1000)}k` : "", "HLS"]
          .filter(Boolean)
          .join(" · "),
      });
    }
  }

  // Progressive / sniffed alternatives (dedupe)
  const seen = new Set(opts.map((o) => o.url));
  for (const c of candidates.slice(0, 8)) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    opts.push({
      id: `cand:${c.url}`,
      url: c.url,
      kind: c.kind || "video",
      label: c.label || qualityLabel(c),
      size: c.size || 0,
    });
  }

  if (!opts.length && best?.url) {
    opts.push({
      id: "best",
      url: best.url,
      kind: best.kind || "video",
      label: "Tốt nhất (tự chọn)",
    });
  }

  // Prepend auto = best / highest variant
  if (opts.length) {
    const autoUrl = opts[0].url;
    return [
      {
        id: "auto",
        url: autoUrl,
        kind: opts[0].kind,
        label: `Tự động · ${opts[0].label}`,
      },
      ...opts,
    ];
  }
  return [];
}
