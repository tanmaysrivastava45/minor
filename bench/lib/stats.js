/**
 * Small-sample statistics so we never claim a difference the data cannot support.
 */

function rng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Percentile bootstrap 95% CI of the mean. */
export function bootstrapCI(xs, { iters = 2000, seed = 1 } = {}) {
  if (!xs.length) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
  const r = rng(seed);
  const means = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[Math.floor(r() * xs.length)];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  return { mean: mean(xs), lo: means[Math.floor(0.025 * iters)], hi: means[Math.floor(0.975 * iters)], n: xs.length };
}

/** Paired bootstrap CI for mean(a - b) over the same questions. */
export function pairedBootstrap(a, b, opts) {
  const d = a.map((x, i) => x - b[i]);
  return bootstrapCI(d, opts);
}

/** Exact two-sided McNemar test on paired binary outcomes. */
export function mcnemar(a, b) {
  let onlyA = 0;
  let onlyB = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && !b[i]) onlyA++;
    else if (!a[i] && b[i]) onlyB++;
  }
  const n = onlyA + onlyB;
  if (n === 0) return { onlyA, onlyB, p: 1 };
  const k = Math.min(onlyA, onlyB);
  let logC = 0; // log C(n, 0)
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return { onlyA, onlyB, p: Math.min(1, 2 * tail) };
}

export function pct(x, digits = 1) {
  return Number.isFinite(x) ? `${(100 * x).toFixed(digits)}%` : "n/a";
}

export function fmtCI(ci) {
  return `${pct(ci.mean)} [${pct(ci.lo)}, ${pct(ci.hi)}] (n=${ci.n})`;
}
