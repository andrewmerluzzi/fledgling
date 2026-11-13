// Fledgling matcher: compares one call's fingerprint against every bird's
// reference calls. Shared by the app and the calibration tools.
//
// Each comparison yields five trait similarities in 0..1 (pitch, pitch shape,
// rhythm, tone, length); the overall match is their weighted geometric mean,
// so one badly-mismatched trait drags the score down (no free points).
// A bird's score = mean of its top-K closest reference calls.

export const TRAITS = ['pitch', 'shape', 'rhythm', 'tone', 'length'];
export const TRAIT_LABELS = {
  pitch: 'Pitch', shape: 'Pitch shape', rhythm: 'Rhythm', tone: 'Tone', length: 'Length',
};

export const DEFAULT_PARAMS = {
  sPitch: 0.6,    // octaves
  sShape: 2.5,    // semitones RMS (DTW)
  sRange: 5,      // semitones
  sCnt: 0.7,      // log2 syllable-count ratio
  sMd: 5,         // dB envelope depth
  sFl: 0.08,      // spectral entropy (0..1)
  sBw: 0.35,      // octaves
  sVf: 0.3,       // voiced fraction
  sSp: 9,         // dB RMS between timbre profiles
  sDur: 0.55,     // ln duration ratio
  w: { pitch: 0.15, shape: 0.25, rhythm: 0.25, tone: 0.2, length: 0.15 },
  topK: 3,
};

const g = (d, s) => Math.exp(-0.5 * (d / s) ** 2);

// "Is this clearly a baby vocalising?" Only calls that pass are identified.
// Same rule is applied to the bird calls used for label calibration.
export const GATE = { peak: 10, dur: 0.2, vf: 0.35, fmin: 150, fmax: 2500 };
export function clearCall(peak, f) {
  if (!f || peak < GATE.peak || f.dur < GATE.dur || f.vf < GATE.vf) return false;
  const hz = 2 ** f.p;
  return hz >= GATE.fmin && hz <= GATE.fmax;
}

const DTW_D = new Float64Array(33 * 33), DTW_L = new Float64Array(33 * 33);
function dtw(a, b, band = 3) {
  const n = a.length, m = b.length, W = m + 1, INF = 1e18;
  DTW_D.fill(INF, 0, (n + 1) * W);
  DTW_D[0] = 0; DTW_L[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(1, i - band); j <= Math.min(m, i + band); j++) {
      const c = (a[i - 1] - b[j - 1]) ** 2;
      let k = (i - 1) * W + j - 1, best = DTW_D[k];
      if (DTW_D[(i - 1) * W + j] < best) { k = (i - 1) * W + j; best = DTW_D[k]; }
      if (DTW_D[i * W + j - 1] < best) { k = i * W + j - 1; best = DTW_D[k]; }
      DTW_D[i * W + j] = best + c;
      DTW_L[i * W + j] = DTW_L[k] + 1;
    }
  }
  return Math.sqrt(DTW_D[n * W + m] / DTW_L[n * W + m]);
}

export function traits(q, r, P = DEFAULT_PARAMS) {
  const pitch = g(q.p - r.p, P.sPitch);
  let shape;
  if (q.c && r.c) shape = g(dtw(q.c, r.c), P.sShape) ** 0.7 * g(q.rg - r.rg, P.sRange) ** 0.3;
  else if (!q.c && !r.c) shape = 0.6;   // neither has a clear pitch: comparable, not identical
  else shape = 0.25;                    // one tonal, one not
  let l1 = 0;
  for (let i = 0; i < q.m.length; i++) l1 += Math.abs(q.m[i] - r.m[i]);
  const rhythm = Math.max(0, 1 - 0.5 * l1) ** 0.5
    * g(Math.log2((q.n + 1) / (r.n + 1)), P.sCnt) ** 0.3
    * g(q.md - r.md, P.sMd) ** 0.2;
  let sd = 0;
  for (let i = 0; i < q.sp.length; i++) sd += (q.sp[i] - r.sp[i]) ** 2;
  const tone = g(q.fl - r.fl, P.sFl) ** 0.2 * g(q.bw - r.bw, P.sBw) ** 0.15 * g(q.vf - r.vf, P.sVf) ** 0.2
    * g(Math.sqrt(sd / q.sp.length), P.sSp) ** 0.45;
  const length = g(Math.log(q.dur / r.dur), P.sDur);
  return { pitch, shape, rhythm, tone, length };
}

export function combine(t, P = DEFAULT_PARAMS) {
  let s = 0, ws = 0;
  for (const k of TRAITS) { s += P.w[k] * Math.log(Math.max(t[k], 0.01)); ws += P.w[k]; }
  return Math.exp(s / ws);
}

// Score one bird: mean of its K best-matching reference calls.
export function scoreBird(q, refs, P = DEFAULT_PARAMS, skip = null) {
  const all = [];
  for (let i = 0; i < refs.length; i++) {
    if (skip && skip(refs[i], i)) continue;
    const t = traits(q, refs[i], P);
    all.push({ i, t, s: combine(t, P) });
  }
  if (!all.length) return null;
  all.sort((x, y) => y.s - x.s);
  const top = all.slice(0, P.topK);
  const t = {};
  for (const k of TRAITS) t[k] = top.reduce((a, x) => a + x.t[k], 0) / top.length;
  return { score: top.reduce((a, x) => a + x.s, 0) / top.length, traits: t, best: top[0].i };
}

// Rank all birds for a query fingerprint. `birds` = [{id, refs, impostor}]
export function rankBirds(q, birds, P = DEFAULT_PARAMS) {
  const out = [];
  for (const b of birds) {
    const r = scoreBird(q, b.refs, P);
    if (r) out.push({ id: b.id, ...r, rarity: rarity(r.score, b.impostor) });
  }
  out.sort((x, y) => y.score - x.score);
  return out;
}

// Fraction of OTHER species' real calls that scored at least this high
// against this bird (from calibration). Small = genuinely distinctive match.
// q: ascending [level, score] pairs (CDF of other-species scores).
export function rarity(score, q) {
  if (!q || !q.length) return null;
  if (score <= q[0][1]) return 1;
  const last = q[q.length - 1];
  if (score >= last[1]) {
    // beyond the highest other-species score seen: extrapolate gently
    const prev = q[q.length - 2];
    const slope = (last[0] - prev[0]) / Math.max(1e-6, last[1] - prev[1]);
    return Math.max(0, (1 - last[0]) - slope * (score - last[1])) * 0.5;
  }
  for (let i = 1; i < q.length; i++) {
    if (score <= q[i][1]) {
      const [l0, v0] = q[i - 1], [l1, v1] = q[i];
      const fr = (score - v0) / (v1 - v0 || 1);
      return 1 - (l0 + fr * (l1 - l0));
    }
  }
  return 0;
}

// Score at which rarity drops to r (for "what counts as a strong match").
export function scoreAtRarity(r, q) {
  if (!q || !q.length) return 1;
  const lvl = 1 - r;
  for (let i = 1; i < q.length; i++) {
    if (lvl <= q[i][0]) {
      const [l0, v0] = q[i - 1], [l1, v1] = q[i];
      return v0 + (lvl - l0) / (l1 - l0 || 1) * (v1 - v0);
    }
  }
  return q[q.length - 1][1];
}
