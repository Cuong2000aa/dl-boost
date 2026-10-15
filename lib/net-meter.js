/**
 * Realtime network / download throughput helpers.
 */

/** Exponential moving average for live B/s. */
export function createEma(alpha = 0.35) {
  let value = 0;
  let primed = false;
  return {
    push(sample) {
      const n = Math.max(0, Number(sample) || 0);
      if (!primed) {
        value = n;
        primed = true;
      } else {
        value = alpha * n + (1 - alpha) * value;
      }
      return value;
    },
    value() {
      return value;
    },
    reset() {
      value = 0;
      primed = false;
    },
  };
}

export function bytesPerSecToMbps(bps) {
  return ((Number(bps) || 0) * 8) / 1_000_000;
}

export function formatMbps(mbps, digits = 1) {
  const n = Number(mbps) || 0;
  if (n < 0.05) return "0 Mbps";
  if (n < 10) return `${n.toFixed(Math.max(1, digits))} Mbps`;
  return `${n.toFixed(0)} Mbps`;
}

/** Ring buffer of recent B/s samples for sparkline (0–1 normalized later). */
export function createSampleRing(size = 24) {
  const buf = new Array(size).fill(0);
  let i = 0;
  let filled = 0;
  return {
    push(v) {
      buf[i] = Math.max(0, Number(v) || 0);
      i = (i + 1) % size;
      filled = Math.min(size, filled + 1);
    },
    values() {
      if (!filled) return [];
      const out = [];
      for (let k = 0; k < filled; k++) {
        out.push(buf[(i - filled + k + size) % size]);
      }
      return out;
    },
    max() {
      return Math.max(1, ...this.values(), 1);
    },
  };
}

/**
 * Short download probe (Cloudflare speed endpoint).
 * @returns {Promise<{bytes:number, elapsed:number, avgBps:number, peakBps:number, mbps:number, peakMbps:number}>}
 */
export async function probeDownloadBandwidth({
  bytes = 1_500_000,
  signal,
} = {}) {
  const url = `https://speed.cloudflare.com/__down?bytes=${Math.max(256_000, bytes)}&measId=${Date.now()}`;
  const t0 =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    signal,
  });
  if (!res.ok) {
    throw new Error(`Probe HTTP ${res.status}`);
  }
  if (!res.body) {
    const ab = await res.arrayBuffer();
    const elapsed =
      ((typeof performance !== "undefined" ? performance.now() : Date.now()) -
        t0) /
      1000;
    const avgBps = ab.byteLength / Math.max(0.001, elapsed);
    return {
      bytes: ab.byteLength,
      elapsed,
      avgBps,
      peakBps: avgBps,
      mbps: bytesPerSecToMbps(avgBps),
      peakMbps: bytesPerSecToMbps(avgBps),
    };
  }

  const reader = res.body.getReader();
  let loaded = 0;
  let lastT = t0;
  let lastLoaded = 0;
  let peakBps = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const dt = (now - lastT) / 1000;
    if (dt >= 0.2) {
      const inst = (loaded - lastLoaded) / dt;
      if (inst > peakBps) peakBps = inst;
      lastT = now;
      lastLoaded = loaded;
    }
  }

  const elapsed =
    ((typeof performance !== "undefined" ? performance.now() : Date.now()) -
      t0) /
    1000;
  const avgBps = loaded / Math.max(0.001, elapsed);
  if (peakBps < avgBps) peakBps = avgBps;

  return {
    bytes: loaded,
    elapsed,
    avgBps,
    peakBps,
    mbps: bytesPerSecToMbps(avgBps),
    peakMbps: bytesPerSecToMbps(peakBps),
  };
}

/** Sum live speeds from job list. */
export function sumJobThroughput(jobs = []) {
  return (jobs || [])
    .filter((j) => j.status === "downloading")
    .reduce((s, j) => s + (Number(j.speed) || 0), 0);
}
