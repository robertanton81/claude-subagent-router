// Exact one-sided binomial bounds (Clopper-Pearson), by bisection on the
// binomial CDF. The finding-triage bar uses them; see orch-label.mjs.

function binomialCdf(k, n, p) {
  let sum = 0;
  let term = Math.pow(1 - p, n);
  for (let i = 0; i <= k; i += 1) {
    sum += term;
    term = term * ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return sum;
}

// One-sided upper bound: the largest p with P(X <= k | n, p) > alpha.
export function clopperPearsonUpper(k, n, alpha = 0.05) {
  if (n === 0) return 1;
  if (k >= n) return 1;
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 60; step += 1) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(k, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return hi;
}

// One-sided lower bound: the smallest p with P(X >= k | n, p) > alpha.
export function clopperPearsonLower(k, n, alpha = 0.05) {
  if (k === 0) return 0;
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 60; step += 1) {
    const mid = (lo + hi) / 2;
    if (1 - binomialCdf(k - 1, n, mid) > alpha) hi = mid;
    else lo = mid;
  }
  return lo;
}
