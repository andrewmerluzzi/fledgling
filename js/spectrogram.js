// Scrolling live spectrogram + static clip spectrograms.
import { Analyzer, DF, NB, FPS, SR } from './analysis.js';

const FMAX = 10000;
const mel = f => 2595 * Math.log10(1 + f / 700);
const imel = m => 700 * (10 ** (m / 2595) - 1);
export const yOfFreq = f => 1 - mel(f) / mel(FMAX); // 0 = top, 1 = bottom

// Night-field palette: deep green-black -> moss -> amber -> cream.
const STOPS = [[0, [10, 20, 16]], [0.25, [24, 58, 44]], [0.5, [64, 122, 82]], [0.75, [226, 164, 58]], [1, [255, 246, 222]]];
const LUT = new Uint8ClampedArray(256 * 3);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  let k = 0;
  while (k < STOPS.length - 2 && v > STOPS[k + 1][0]) k++;
  const [v0, c0] = STOPS[k], [v1, c1] = STOPS[k + 1];
  const t = (v - v0) / (v1 - v0);
  for (let j = 0; j < 3; j++) LUT[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * t;
}

function rowMap(H) {
  const m = new Float32Array(H);
  for (let y = 0; y < H; y++) m[y] = Math.min(NB - 2, imel((1 - (y + 0.5) / H) * mel(FMAX)) / DF);
  return m;
}

function paintColumn(data, W, x, H, rows, P, Ndb) {
  for (let y = 0; y < H; y++) {
    const b = rows[y], i0 = b | 0, fr = b - i0;
    const p = P[i0] * (1 - fr) + P[i0 + 1] * fr;
    const nd = Ndb[i0] * (1 - fr) + Ndb[i0 + 1] * fr;
    const db = 10 * Math.log10(p) - nd;
    let v = (db + 3) / 36;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    const c = (v * 255) | 0, o = (y * W + x) * 4;
    data[o] = LUT[c * 3]; data[o + 1] = LUT[c * 3 + 1]; data[o + 2] = LUT[c * 3 + 2]; data[o + 3] = 255;
  }
}

export class LiveSpectrogram {
  constructor(canvas, overlay, seconds = 6) {
    this.c = canvas; this.o = overlay;
    this.W = Math.round(seconds * FPS); this.H = 160;
    canvas.width = this.W; canvas.height = this.H;
    this.ctx = canvas.getContext('2d');
    this.octx = overlay.getContext('2d');
    this.rows = rowMap(this.H);
    this.last = -1;
    this.marks = [];
    this.clear();
  }
  clear() {
    this.ctx.fillStyle = 'rgb(10,20,16)';
    this.ctx.fillRect(0, 0, this.W, this.H);
    this.last = -1;
    this.marks = [];
  }
  mark(a, b, label, strong, kind = 'call') { this.marks.push({ a, b, label, strong, kind }); if (this.marks.length > 40) this.marks.shift(); }
  label(a, b, label, strong) {
    const m = this.marks.find(m => m.a === a && m.b === b);
    if (m) { m.label = label; m.strong = strong; } else this.mark(a, b, label, strong);
  }

  update(an) {
    const cur = an.frame;
    if (this.last < 0) this.last = cur - 1;
    let n = cur - 1 - this.last;
    if (n > 0) {
      if (n > this.W) { this.last = cur - 1 - this.W; n = this.W; }
      const { ctx, W, H } = this;
      ctx.drawImage(this.c, n, 0, W - n, H, 0, 0, W - n, H);
      const img = ctx.createImageData(n, H);
      for (let k = 0; k < n; k++) {
        const P = an.frameAt(this.last + 1 + k);
        if (P) paintColumn(img.data, n, k, H, this.rows, P, an.Ndb);
      }
      ctx.putImageData(img, W - n, 0);
      this.last = cur - 1;
    }
    this.drawOverlay(an);
  }

  drawOverlay(an) {
    const o = this.o, dpr = window.devicePixelRatio || 1;
    const cw = o.clientWidth, ch = o.clientHeight;
    if (o.width !== Math.round(cw * dpr) || o.height !== Math.round(ch * dpr)) { o.width = Math.round(cw * dpr); o.height = Math.round(ch * dpr); }
    const g = this.octx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const cur = an ? an.frame : 0;
    const xOf = f => cw - (cur - f) * (cw / this.W);
    const seg = an && an.current();
    if (seg) {
      const x0 = xOf(seg.a), x1 = cw;
      g.fillStyle = 'rgba(255,246,222,0.08)';
      g.fillRect(x0, 0, x1 - x0, ch);
    }
    g.font = '600 12px -apple-system, system-ui, sans-serif';
    g.textBaseline = 'top';
    const rowEnd = [-1e9, -1e9, -1e9];
    for (const m of this.marks) {
      const x0 = xOf(m.a), x1 = xOf(m.b + 1);
      if (x1 < 0) continue;
      g.strokeStyle = m.strong ? 'rgba(255,214,140,0.95)' : m.kind === 'ignored' ? 'rgba(255,246,222,0.22)' : 'rgba(255,246,222,0.55)';
      g.lineWidth = 1.5;
      g.setLineDash(m.kind === 'ignored' ? [2, 3] : []);
      g.beginPath();
      g.moveTo(x0, ch - 6); g.lineTo(x0, ch - 2); g.lineTo(x1, ch - 2); g.lineTo(x1, ch - 6);
      g.stroke();
      g.setLineDash([]);
      if (m.label) {
        const tw = g.measureText(m.label).width;
        const lx = Math.max(4, Math.min(cw - tw - 12, x0));
        const row = rowEnd.findIndex(e => lx > e + 4);
        if (row < 0) continue;
        rowEnd[row] = lx + tw + 10;
        const ly = 6 + row * 22;
        g.fillStyle = m.strong ? 'rgba(255,214,140,0.95)' : 'rgba(255,246,222,0.8)';
        g.beginPath();
        g.roundRect ? g.roundRect(lx, ly, tw + 10, 18, 9) : g.rect(lx, ly, tw + 10, 18);
        g.fill();
        g.fillStyle = '#10201a';
        g.fillText(m.label, lx + 5, ly + 3);
      }
    }
  }
}

// Static spectrogram of a short clip (24 kHz samples) into a canvas.
// sel = [t0, t1] seconds to highlight (the part that was matched).
export function drawClip(canvas, samples, sel) {
  const an = new Analyzer({ ringSeconds: samples.length / SR + 1, onDb: 99 });
  an.seedNoise(samples);
  an.push(samples);
  const W = Math.max(1, an.frame), H = 120;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const rows = rowMap(H);
  for (let f = 0; f < W; f++) {
    const P = an.frameAt(f);
    if (P) paintColumn(img.data, W, f, H, rows, P, an.Ndb);
  }
  ctx.putImageData(img, 0, 0);
  if (sel) {
    const x0 = Math.max(0, Math.round(sel[0] * FPS)), x1 = Math.min(W, Math.round(sel[1] * FPS));
    ctx.fillStyle = 'rgba(10,20,16,0.6)';
    ctx.fillRect(0, 0, x0, H);
    ctx.fillRect(x1, 0, W - x1, H);
    ctx.fillStyle = 'rgba(255,214,140,0.95)';
    ctx.fillRect(x0, H - 3, Math.max(1, x1 - x0), 3);
  }
}
