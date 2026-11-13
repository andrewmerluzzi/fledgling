// Fledgling audio analysis: dependency-free and shared by the app (live mic)
// and tools/build.mjs (reference bird recordings), so the baby and the birds
// are measured by exactly the same code.
//
// Pipeline: 24 kHz mono -> 120 Hz high-pass -> STFT (43 ms window, 10 ms hop)
// -> adaptive per-frequency noise floor + spectral subtraction -> "call"
// segmentation (sound rising above the background, gaps < 250 ms merged)
// -> a fingerprint per call: pitch, pitch contour, pitch range, tonal vs.
// raspy, spectral width, rhythm (envelope modulation spectrum), syllables,
// duration.

export const SR = 24000;
export const HOP = 240;              // 10 ms
export const WIN = 1024;             // 42.7 ms
export const NFFT = 2048;            // zero-padded -> 11.7 Hz bins
export const FPS = SR / HOP;         // 100 frames / s
export const DF = SR / NFFT;
export const B0 = Math.ceil(150 / DF);
export const B1 = Math.floor(10000 / DF);
export const NB = B1 + 1;            // bins kept: 0 .. 10 kHz

const GAP = 15;        // frames of quiet that end a call (150 ms)
const MINACT = 8;      // need >= 80 ms of active sound
const MAXLEN = 400;    // force-close calls at 4 s
const WS = 256;        // short window for the level envelope (10.7 ms)
const SB0 = 2, SB1 = Math.floor(10000 / (SR / WS)); // 187 Hz .. 10 kHz
const NBANDS = 8;      // rhythm bands
const MOD_EDGES = Array.from({ length: NBANDS + 1 }, (_, i) => Math.min(50, 1 * 1.68 ** i));

// ---------- small DSP helpers ----------
export function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0, x = i;
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  const cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = Math.sin(2 * Math.PI * i / n); }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cs[k] + im[l] * sn[k];
          const tim = im[l] * cs[k] - re[l] * sn[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

const fft2048 = makeFFT(NFFT);
const fft1024 = makeFFT(1024);
const fft256 = makeFFT(WS);
const HANN_S = Float64Array.from({ length: WS }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WS));
const HANN = new Float64Array(WIN);
let hs = 0;
for (let i = 0; i < WIN; i++) { HANN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WIN); hs += HANN[i]; }
const PNORM = 4 / (hs * hs);
const LOG2F = new Float64Array(NB);
for (let b = 1; b < NB; b++) LOG2F[b] = Math.log2(b * DF);
// Timbre bands: 12 half-octave bands, 150 Hz .. 10 kHz
const NSP = 12;
const SPBAND = new Int8Array(NB).fill(-1);
for (let b = B0; b <= B1; b++) SPBAND[b] = Math.min(NSP - 1, Math.floor(Math.log2(b * DF / 150) / Math.log2(10000 / 150) * NSP));

// 2nd-order Butterworth high-pass at 120 Hz (RBJ cookbook)
const HPF = (() => {
  const w0 = 2 * Math.PI * 120 / SR, c = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + al;
  return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 };
})();

// Subharmonic-summation pitch candidates: 80 Hz .. 6 kHz, 1/48 octave steps
const NK = Math.floor(Math.log2(6000 / 80) * 48) + 1;
const CAND = Float64Array.from({ length: NK }, (_, k) => 80 * 2 ** (k / 48));
const AMP = new Float64Array(NB + 2), SC = new Float64Array(NK), STAMP = new Int32Array(NB);
let stampTok = 1;

function shs(C, tot) {
  for (let b = 0; b < NB; b++) AMP[b] = Math.sqrt(C[b]);
  let best = -1, bk = 0;
  for (let k = 0; k < NK; k++) {
    const f = CAND[k];
    const H = Math.min(8, Math.floor(10000 / f));
    let s = 0, w = 1;
    for (let h = 1; h <= H; h++) {
      const x = h * f / DF, i = x | 0, fr = x - i;
      s += w * (AMP[i] * (1 - fr) + AMP[i + 1] * fr);
      w *= 0.84;
    }
    SC[k] = s;
    if (s > best) { best = s; bk = k; }
  }
  let kk = bk;
  if (bk > 0 && bk < NK - 1) {
    const y0 = SC[bk - 1], y1 = SC[bk], y2 = SC[bk + 1], den = y0 - 2 * y1 + y2;
    if (den < 0) kk += Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den));
  }
  const f0 = 80 * 2 ** (kk / 48);
  // Voicing = share of energy sitting on the harmonic series, above chance.
  const H2 = Math.min(20, Math.floor(10000 / f0));
  const tok = ++stampTok;
  let he = 0, cnt = 0;
  for (let h = 1; h <= H2; h++) {
    const c = Math.round(h * f0 / DF);
    for (let b = c - 3; b <= c + 3; b++) {
      if (b < B0 || b > B1 || STAMP[b] === tok) continue;
      STAMP[b] = tok; he += C[b]; cnt++;
    }
  }
  const base = cnt / (B1 - B0 + 1);
  const voicing = (he / tot - base) / (1 - base);
  return { f0, voicing };
}

function wMedian(pairs, q = 0.5) {
  if (!pairs.length) return NaN;
  const s = pairs.slice().sort((x, y) => x[0] - y[0]);
  const tot = s.reduce((a, p) => a + p[1], 0);
  let acc = 0;
  for (const [v, w] of s) { acc += w; if (acc >= q * tot) return v; }
  return s[s.length - 1][0];
}

function medfilt(arr, k) {
  const h = k >> 1;
  return arr.map((_, i) => {
    const w = arr.slice(Math.max(0, i - h), i + h + 1).sort((a, b) => a - b);
    return w[w.length >> 1];
  });
}

const r3 = v => Math.round(v * 1000) / 1000;

// ---------- streaming analyzer ----------
export class Analyzer {
  constructor(opts = {}) {
    this.onDb = opts.onDb ?? 0;             // call detection threshold (clean/noise dB)
    this.R = Math.round((opts.ringSeconds ?? 10) * FPS);
    this.SRN = this.R * HOP;
    this.samples = new Float32Array(this.SRN);
    this.P = new Float32Array(this.R * NB);  // power spectrum per frame
    this.C = new Float32Array(this.R * NB);  // noise-subtracted power
    this.SNR = new Float32Array(this.R);
    this.ENV = new Float32Array(this.R);     // 10 ms clean level, dB re. noise
    this.Ndb = new Float32Array(NB);
    this.NSdb = new Float32Array(SB1 + 1);   // noise floor for the short STFT
    this.sre = new Float64Array(WS);
    this.sim = new Float64Array(WS);
    this.PS = new Float64Array(SB1 + 1);
    this.seeded = false;
    this.warm = 0;
    this.n = 0;
    this.frame = 0;
    this.hp = [0, 0, 0, 0];
    this.re = new Float64Array(NFFT);
    this.im = new Float64Array(NFFT);
    this.seg = null;
    this.activeRun = 0;
  }

  // Optional: initialise the noise floor from a chunk of audio (20th
  // percentile per frequency). Used for reference recordings and for the
  // first second of live listening.
  seedNoise(x) {
    const tmp = new Analyzer({ ringSeconds: Math.max(1, x.length / SR + 0.1), onDb: 99 });
    tmp.seeded = true; // don't self-seed
    tmp.SPS = new Float32Array(tmp.R * (SB1 + 1)); // keep short-STFT spectra (dB)
    tmp.push(x);
    const nf = Math.min(tmp.frame, tmp.R);
    if (nf < 5) return;
    const col = new Float64Array(nf), envs = [];
    for (let b = 0; b < NB; b++) {
      for (let f = 0; f < nf; f++) col[f] = 10 * Math.log10(tmp.P[f * NB + b]);
      col.sort();
      this.Ndb[b] = col[Math.floor(nf * 0.2)] + 4; // 20th pct -> geometric mean (exp. dist.)
    }
    for (let b = 0; b <= SB1; b++) {
      for (let f = 0; f < nf; f++) col[f] = tmp.SPS[f * (SB1 + 1) + b];
      col.sort();
      this.NSdb[b] = col[Math.floor(nf * 0.2)] + 4;
    }
    this.seeded = true;
    this.warm = 0;
  }

  push(x) {
    const out = [];
    const { b0, b1, b2, a1, a2 } = HPF;
    let [x1, x2, y1, y2] = this.hp;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      let y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      if (Math.abs(y) < 1e-20) y = 0;
      x2 = x1; x1 = xi; y2 = y1; y1 = y;
      this.samples[this.n % this.SRN] = y;
      this.n++;
      if (this.n % HOP === 0) {
        const ev = this._frame();
        if (ev) out.push(ev);
      }
    }
    this.hp = [x1, x2, y1, y2];
    return out;
  }

  flush() {
    const s = this.seg;
    this.seg = null;
    if (s && s.nact >= MINACT) return this._finish(s);
    return null;
  }

  // In-progress call (for live UI), or null.
  current() { return this.seg ? { a: this.seg.a, last: this.seg.last } : null; }

  frameAt(f) { // power spectrum of frame f (if still in the ring)
    if (f < 0 || f >= this.frame || this.frame - f > this.R) return null;
    const r = f % this.R;
    return this.P.subarray(r * NB, (r + 1) * NB);
  }

  // Audio (high-passed, 24 kHz) covering frames a..b plus padding seconds.
  audio(a, b, pad = 0.25) {
    let s0 = (a + 1) * HOP - WIN - Math.round(pad * SR);
    let s1 = (b + 1) * HOP + Math.round(pad * SR);
    s0 = Math.max(s0, this.n - this.SRN + 1, 0);
    s1 = Math.min(s1, this.n);
    const out = new Float32Array(Math.max(0, s1 - s0));
    for (let i = 0; i < out.length; i++) out[i] = this.samples[(s0 + i) % this.SRN];
    return out;
  }

  _frame() {
    const f = this.frame++, r = f % this.R, end = this.n;
    const re = this.re, im = this.im;
    for (let i = 0; i < WIN; i++) {
      const si = end - WIN + i;
      re[i] = si >= 0 ? this.samples[si % this.SRN] * HANN[i] : 0;
    }
    re.fill(0, WIN);
    im.fill(0);
    fft2048(re, im);
    const off = r * NB;
    const P = this.P, C = this.C, Ndb = this.Ndb;
    for (let b = 0; b < NB; b++) P[off + b] = (re[b] * re[b] + im[b] * im[b]) * PNORM + 1e-14;

    // Short STFT (10.7 ms) for a sharp level envelope.
    const sre = this.sre, sim = this.sim, PS = this.PS, NS = this.NSdb;
    for (let i = 0; i < WS; i++) {
      const si = end - WS + i;
      sre[i] = si >= 0 ? this.samples[si % this.SRN] * HANN_S[i] : 0;
    }
    sim.fill(0);
    fft256(sre, sim);
    for (let b = 0; b <= SB1; b++) PS[b] = 10 * Math.log10(sre[b] * sre[b] + sim[b] * sim[b] + 1e-14);
    if (this.SPS) this.SPS.set(PS, r * (SB1 + 1));

    if (!this.seeded) {
      for (let b = 0; b < NB; b++) Ndb[b] = 10 * Math.log10(P[off + b]);
      NS.set(PS);
      this.seeded = true;
      this.warm = 50;
    }
    let sc = 0, sn = 0;
    for (let b = SB0; b <= SB1; b++) {
      const N = 1.78 * 10 ** (NS[b] / 10), c = 10 ** (PS[b] / 10) - 2 * N;
      if (c > 0) sc += c;
      sn += N;
    }
    this.ENV[r] = 10 * Math.log10(sc / sn + 0.01);   // silence ~ -20 dB

    let sumC = 0, sumN = 0;
    for (let b = 0; b < NB; b++) {
      const N = 1.78 * 10 ** (Ndb[b] / 10);       // geometric -> arithmetic mean
      const c = P[off + b] - 2 * N;               // 2x over-subtraction
      C[off + b] = c > 0 ? c : 0;
      if (b >= B0) { sumC += C[off + b]; sumN += N; }
    }
    const snr = 10 * Math.log10(sumC / sumN + 1e-9);
    this.SNR[r] = snr;

    const active = snr > this.onDb;
    this.activeRun = active ? this.activeRun + 1 : 0;
    const rate = this.warm > 0 ? 0.2
      : (!active && !this.seg) ? 0.03
      : this.activeRun > 600 ? 0.03 : 0.002;
    if (this.warm > 0) this.warm--;
    for (let b = 0; b < NB; b++) {
      const d = 10 * Math.log10(P[off + b]) - Ndb[b];
      Ndb[b] += rate * (d > 10 ? 10 : d < -10 ? -10 : d);
    }
    for (let b = 0; b <= SB1; b++) {
      const d = PS[b] - NS[b];
      NS[b] += rate * (d > 10 ? 10 : d < -10 ? -10 : d);
    }

    let ev = null;
    if (!this.seg) {
      if (active) this.seg = { a: f, last: f, nact: 1, peak: snr };
    } else {
      const s = this.seg;
      if (active) { s.last = f; s.nact++; if (snr > s.peak) s.peak = snr; }
      if (f - s.last > GAP || f - s.a >= MAXLEN) {
        this.seg = null;
        if (s.nact >= MINACT) ev = this._finish(s);
      }
    }
    return ev;
  }

  _finish(s) {
    const a = s.a, b = s.last;
    return { a, b, t0: a / FPS, t1: (b + 1) / FPS, peak: r3(s.peak), feat: this.features(a, b) };
  }

  features(a, b) {
    const R = this.R, onLow = this.onDb - 3;
    const n = b - a + 1;
    const st = new Array(n).fill(NaN);
    let wSum = 0, wV = 0, flS = 0, bwS = 0;
    const pkL = [], f0L = [];
    const se = new Float64Array(NSP);
    for (let k = 0; k < n; k++) {
      const f = a + k, r = f % R;
      if (this.SNR[r] < onLow) continue;
      const C = this.C.subarray(r * NB, (r + 1) * NB);
      let tot = 0, mx = 0, mb = B0;
      for (let q = B0; q <= B1; q++) { const v = C[q]; tot += v; if (v > mx) { mx = v; mb = q; } }
      if (tot <= 0) continue;
      // Normalised spectral entropy: ~0 pure whistle, ~1 white noise.
      let ent = 0, m1 = 0;
      for (let q = B0; q <= B1; q++) {
        const v = C[q];
        if (v > 0) { const pr = v / tot; ent -= pr * Math.log(pr); se[SPBAND[q]] += v; }
        m1 += v * LOG2F[q];
      }
      ent /= Math.log(B1 - B0 + 1);
      const mu = m1 / tot;
      let m2 = 0;
      for (let q = B0; q <= B1; q++) { const d = LOG2F[q] - mu; m2 += C[q] * d * d; }
      const bw = Math.sqrt(m2 / tot);
      let pk = mb;
      if (mb > B0 && mb < B1) {
        const y0 = C[mb - 1], y1 = C[mb], y2 = C[mb + 1], den = y0 - 2 * y1 + y2;
        if (den < 0) pk += Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den));
      }
      const { f0, voicing } = shs(C, tot);
      const w = Math.sqrt(tot);
      wSum += w;
      flS += w * ent;
      bwS += w * bw;
      pkL.push([Math.log2(pk * DF), w]);
      if (voicing > 0.4) { wV += w; st[k] = 12 * Math.log2(f0); f0L.push([Math.log2(f0), w]); }
    }
    if (wSum === 0) return null;
    const vf = wV / wSum;
    const voiced = vf >= 0.3 && f0L.length >= 4;
    const p = voiced ? wMedian(f0L) : wMedian(pkL);

    // Pitch contour (semitones relative to the call's median), 16 points.
    let c = null, rg = 0;
    if (voiced) {
      const vi = [], vv = [];
      st.forEach((v, k) => { if (!isNaN(v)) { vi.push(k); vv.push(v); } });
      const sm = medfilt(vv, 5);
      const med = 12 * p;
      const span = vi[vi.length - 1] - vi[0] + 1;
      const series = new Float64Array(span);
      let j = 0;
      for (let t = 0; t < span; t++) {
        const k = vi[0] + t;
        while (j < vi.length - 1 && vi[j + 1] <= k) j++;
        if (vi[j] === k || j === vi.length - 1) series[t] = sm[j];
        else { const fr = (k - vi[j]) / (vi[j + 1] - vi[j]); series[t] = sm[j] * (1 - fr) + sm[j + 1] * fr; }
      }
      c = [];
      for (let i = 0; i < 16; i++) {
        const t0 = Math.floor(i * span / 16), t1 = Math.max(t0 + 1, Math.floor((i + 1) * span / 16));
        let s = 0;
        for (let t = t0; t < t1; t++) s += series[Math.min(t, span - 1)];
        c.push(r3(Math.max(-24, Math.min(24, s / (t1 - t0) - med))));
      }
      const pairs = sm.map((v, i) => [v, f0L[i][1]]);
      rg = wMedian(pairs, 0.9) - wMedian(pairs, 0.1);
    }

    // Rhythm: modulation spectrum of the 10 ms level envelope.
    const pad = 5, ne = n + 2 * pad;
    const env = new Float64Array(ne);
    let emax = -Infinity;
    for (let k = 0; k < ne; k++) {
      const f = a - pad + k;
      env[k] = (f >= 0 && f < this.frame && this.frame - f <= R) ? this.ENV[f % R] : -20;
      if (k >= pad && k < pad + n && env[k] > emax) emax = env[k];
    }
    const floor = Math.max(emax - 30, -10);
    let mean = 0;
    for (let k = 0; k < ne; k++) { env[k] = Math.max(env[k], floor); mean += env[k]; }
    mean /= ne;
    let md = 0;
    for (let k = pad; k < pad + n; k++) md += (env[k] - mean) ** 2;
    md = Math.sqrt(md / n);
    const L = 1024, re = new Float64Array(L), im = new Float64Array(L);
    const len = Math.min(ne, L);
    for (let k = 0; k < len; k++) re[k] = (env[k] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * k / Math.max(1, len - 1)));
    fft1024(re, im);
    const m = new Array(NBANDS).fill(0);
    for (let k = 1; k < L / 2; k++) {
      const hz = k * FPS / L;
      for (let i = 0; i < NBANDS; i++) if (hz >= MOD_EDGES[i] && hz < MOD_EDGES[i + 1]) { m[i] += re[k] * re[k] + im[k] * im[k]; break; }
    }
    const ms = m.reduce((x, y) => x + y, 0);
    const mn = m.map(v => r3(ms > 0 ? v / ms : 1 / NBANDS));

    // Syllable count with hysteresis on the smoothed envelope.
    const hi = Math.max(emax - 15, 3), lo = hi - 6;
    let syl = 0, above = false;
    for (let k = pad; k < pad + n; k++) {
      const v = (env[k - 1] + env[k] + env[k + 1]) / 3;
      if (!above && v > hi) { above = true; syl++; }
      else if (above && v < lo) above = false;
    }

    // Timbre: where the energy sits, dB re. loudest band, floored at -40.
    let smax = 0;
    for (let i = 0; i < NSP; i++) smax = Math.max(smax, se[i]);
    const sp = Array.from(se, v => Math.round(Math.max(-40, 10 * Math.log10((v + 1e-20) / smax)) * 10) / 10);

    return {
      sp,
      dur: r3(n / FPS), vf: r3(vf), p: r3(p), c, rg: r3(rg),
      fl: r3(flS / wSum), bw: r3(bwS / wSum), m: mn, md: r3(md), n: Math.max(1, syl),
    };
  }
}

// Streaming linear-phase resampler (e.g. 48 kHz mic -> 24 kHz).
export class Resampler {
  constructor(from, to = SR) {
    this.ratio = from / to;
    this.pass = from === to;
    const cutoff = 0.45 * Math.min(1, to / from); // normalised to input rate
    const T = 48;
    this.taps = Float64Array.from({ length: T + 1 }, (_, i) => {
      const x = i - T / 2;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      return sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / T) + 0.08 * Math.cos(4 * Math.PI * i / T));
    });
    this.hist = new Float64Array(T + 1);
    this.hi = 0;
    this.prev = 0;      // last filtered sample
    this.pos = 0;       // fractional read position relative to current sample
  }
  process(x) {
    if (this.pass) return x;
    const out = [];
    const T = this.taps.length;
    for (let i = 0; i < x.length; i++) {
      this.hist[this.hi] = x[i];
      this.hi = (this.hi + 1) % T;
      let y = 0;
      for (let k = 0; k < T; k++) y += this.taps[k] * this.hist[(this.hi + k) % T];
      // emit outputs that fall between prev (t=-1) and y (t=0)
      while (this.pos <= 0) {
        const fr = this.pos + 1;
        out.push(this.prev * (1 - fr) + y * fr);
        this.pos += this.ratio;
      }
      this.pos -= 1;
      this.prev = y;
    }
    return Float32Array.from(out);
  }
}
