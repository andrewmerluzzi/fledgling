// Builds data/birds.json (reference fingerprints + honest calibration) and
// audio/<id>.m4a (one short real call per bird for the field guide).
//
//   node tools/build.mjs            build with current params
//   node tools/build.mjs --tune     random-search matcher params first
//
// Honesty check: leave-one-recording-out. For every recording, its calls are
// identified against references built WITHOUT that recording, so a bird never
// gets to "recognise itself".
import { SPECIES } from './species.mjs';
import { Analyzer, SR } from '../js/analysis.js';
import { DEFAULT_PARAMS, traits, combine, TRAITS, rarity } from '../js/match.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'raw');
const HASH = crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, 'js/analysis.js'))).digest('hex').slice(0, 8);
const PEAK_MIN = 8;       // dB: only clear, focal calls become references
const MIN_DUR = 0.15;     // s: shorter blips carry too little information (same rule in the app)
const PER_REC = 12;       // candidate calls per recording (loudest first)
const KEEP_FRAC = 0.6;    // consensus filter keeps the best-supported 60%
const MAX_REFS = 40;
const args = process.argv.slice(2);

// ---------- extraction (cached per analysis.js version) ----------
function decode(file, maxSec = 90) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-t', String(maxSec), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

export function extractFile(file) {
  const x = decode(file);
  const an = new Analyzer();
  an.seedNoise(x.subarray(0, Math.min(x.length, 30 * SR)));
  const segs = [];
  for (let i = 0; i < x.length; i += 8192) segs.push(...an.push(x.subarray(i, i + 8192)));
  const fl = an.flush();
  if (fl) segs.push(fl);
  return segs.filter(s => s.feat).map(s => ({ t0: s.t0, t1: s.t1, peak: s.peak, feat: s.feat }));
}

function loadSpecies(sp) {
  const dir = path.join(RAW, sp.id);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; }
  const files = meta.files.filter(f => f.source === 'xc');
  if (!files.length) return null;
  const cacheFile = path.join(dir, `segs-${HASH}.json`);
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  let dirty = false;
  const recs = files.map((f, ri) => {
    if (!cache[f.local]) { cache[f.local] = extractFile(path.join(dir, f.local)); dirty = true; }
    const segs = cache[f.local]
      .filter(s => s.peak >= PEAK_MIN && s.feat.dur >= MIN_DUR)
      .sort((a, b) => b.peak - a.peak)
      .slice(0, PER_REC)
      .map(s => ({ ...s, rec: ri }));
    return { file: f, segs };
  });
  if (dirty) fs.writeFileSync(cacheFile, JSON.stringify(cache));
  return { sp, meta, recs, all: recs.flatMap(r => r.segs) };
}

// ---------- consensus filter ----------
// A candidate reference call is kept only if it resembles calls from OTHER
// recordings (other recordists/places) of the same species. Background birds
// that wander into one recording don't get that support.
function consensus(all, excludeRec = -1, P = DEFAULT_PARAMS) {
  const segs = all.filter(s => s.rec !== excludeRec);
  const recSet = new Set(segs.map(s => s.rec));
  if (recSet.size < 2) return segs.slice(0, MAX_REFS);
  const scored = segs.map(s => {
    const sims = [];
    for (const o of segs) if (o.rec !== s.rec) sims.push(combine(traits(s.feat, o.feat, P), P));
    sims.sort((a, b) => b - a);
    const k = Math.min(3, sims.length);
    return { s, sup: sims.slice(0, k).reduce((a, b) => a + b, 0) / k };
  });
  scored.sort((a, b) => b.sup - a.sup);
  const keep = scored.slice(0, Math.max(4, Math.ceil(scored.length * KEEP_FRAC)));
  return keep.slice(0, MAX_REFS).map(x => Object.assign(x.s, { sup: x.sup }));
}

function birdScore(q, refs, P) {
  const s = [];
  for (const r of refs) s.push(combine(traits(q, r.feat, P), P));
  s.sort((a, b) => b - a);
  const k = Math.min(P.topK, s.length);
  return s.slice(0, k).reduce((a, b) => a + b, 0) / k;
}

// ---------- evaluation ----------
let refCache = null;
function evaluate(data, P, { full = false } = {}) {
  refCache = refCache || {
    full: data.map(d => consensus(d.all, -1, DEFAULT_PARAMS)),
    loo: data.map(d => d.recs.map((_, ri) => consensus(d.all, ri, DEFAULT_PARAMS))),
  };
  const fullRefs = refCache.full, looRefs = refCache.loo;
  let correct = 0, top3 = 0, n = 0;
  const perSpecies = [];
  const genuine = data.map(() => []);
  const impostor = data.map(() => []);
  const rows = [];
  for (let a = 0; a < data.length; a++) {
    let ca = 0, na = 0;
    for (let ri = 0; ri < data[a].recs.length; ri++) {
      if (data[a].recs.length < 2) continue;
      const refsA = looRefs[a][ri];
      if (!refsA.length) continue;
      for (const q of data[a].recs[ri].segs.slice(0, 6)) {
        const scores = data.map((_, b) => b === a ? birdScore(q.feat, refsA, P) : birdScore(q.feat, fullRefs[b], P));
        const sa = scores[a];
        const rank = scores.filter(s => s > sa).length;
        if (full && process.env.CONFUSION) {
          const top = scores.indexOf(Math.max(...scores));
          (data[a].conf = data[a].conf || {})[data[top].sp.id] = (data[a].conf[data[top].sp.id] || 0) + 1;
        }
        if (rank === 0) { correct++; ca++; }
        if (rank < 3) top3++;
        n++; na++;
        genuine[a].push(sa);
        if (full) rows.push({ a, scores });
        if (full) scores.forEach((s, b) => { if (b !== a) impostor[b].push(s); });
      }
    }
    if (na) perSpecies.push(ca / na);
    if (full && na && process.env.CONFUSION) console.log('      ->', Object.entries(data[a].conf || {}).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => k + ' ' + v).join(', '));
    if (full && na) console.log(`    ${data[a].sp.id.padEnd(20)} ${String(Math.round(ca / na * 100)).padStart(3)}%  (${na} calls)`);
  }
  const balanced = perSpecies.reduce((x, y) => x + y, 0) / perSpecies.length;
  return { acc: correct / n, top3: top3 / n, balanced, n, genuine, impostor, fullRefs, rows };
}

function quantiles(arr, k = 21) {
  if (!arr.length) return [];
  const s = arr.slice().sort((a, b) => a - b);
  return Array.from({ length: k }, (_, i) => +s[Math.min(s.length - 1, Math.round(i / (k - 1) * (s.length - 1)))].toFixed(4));
}

const TAIL = [0, .1, .2, .3, .4, .5, .6, .7, .8, .9, .95, .97, .98, .99, .995, .998, 1];
function tailQuantiles(arr) {
  if (!arr.length) return [];
  const s = arr.slice().sort((a, b) => a - b);
  return TAIL.map(l => [l, +s[Math.min(s.length - 1, Math.round(l * (s.length - 1)))].toFixed(4)]);
}

function tune(data, base) {
  let best = { P: base, ...evaluate(data, base) };
  console.log(`base: top1 ${(best.acc * 100).toFixed(1)}%  balanced ${(best.balanced * 100).toFixed(1)}%  top3 ${(best.top3 * 100).toFixed(1)}%`);
  const keys = ['sPitch', 'sShape', 'sRange', 'sCnt', 'sMd', 'sFl', 'sBw', 'sVf', 'sDur', 'sSp'];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let it = 0; it < 70; it++) {
    const P = JSON.parse(JSON.stringify(best.P));
    const k = keys[Math.floor(rnd() * keys.length)];
    P[k] *= 2 ** ((rnd() - 0.5) * 1.2);
    if (rnd() < 0.5) {
      const t = TRAITS[Math.floor(rnd() * TRAITS.length)];
      P.w[t] = Math.max(0.03, P.w[t] * 2 ** ((rnd() - 0.5) * 1.2));
    }
    if (rnd() < 0.15) P.topK = 1 + Math.floor(rnd() * 5);
    const r = evaluate(data, P);
    const obj = r.balanced + 0.5 * r.acc;
    if (obj > best.balanced + 0.5 * best.acc + 0.002) {
      best = { P, ...r };
      console.log(`  it ${it}: top1 ${(r.acc * 100).toFixed(1)}%  balanced ${(r.balanced * 100).toFixed(1)}%  top3 ${(r.top3 * 100).toFixed(1)}%  (${k})`);
    }
  }
  return best.P;
}

// ---------- playback clip ----------
function makeClip(d, refs, outDir) {
  // best-supported loud call; prefer files without NoDerivs licences (all are)
  const cand = refs.slice().sort((a, b) => (b.sup ?? 0) * 2 + b.peak / 30 - ((a.sup ?? 0) * 2 + a.peak / 30))[0];
  if (!cand) return null;
  const f = d.recs[cand.rec].file;
  const start = Math.max(0, cand.t0 - 0.4);
  const len = Math.min(8, Math.max(3, cand.t1 - cand.t0 + 2));
  const out = path.join(outDir, `${d.sp.id}.m4a`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(start), '-t', String(len), '-i', path.join(RAW, d.sp.id, f.local),
    '-af', `highpass=f=100,afade=t=in:d=0.05,afade=t=out:st=${(len - 0.35).toFixed(2)}:d=0.35,loudnorm=I=-18:TP=-1.5`,
    '-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '64k', out]);
  return { start: +start.toFixed(2), len: +len.toFixed(2), xc: f.xc, recordist: f.recordist, license: f.license, licenseUrl: f.licenseUrl, page: f.page, country: f.country };
}

// ---------- main ----------
const data = SPECIES.map(loadSpecies).filter(d => d && d.all.length >= 4);
const missing = SPECIES.filter(s => !data.find(d => d.sp.id === s.id)).map(s => s.id);
console.log(`species with usable recordings: ${data.length}/${SPECIES.length}${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`);

const paramsFile = path.join(ROOT, 'tools/params.json');
let P = DEFAULT_PARAMS;
try { P = JSON.parse(fs.readFileSync(paramsFile, 'utf8')); } catch {}
if (args.includes('--tune')) {
  P = tune(data, P);
  fs.writeFileSync(paramsFile, JSON.stringify(P, null, 2));
}
const ev = evaluate(data, P, { full: true });
console.log(`\nLeave-one-recording-out over ${ev.n} real calls from ${data.length} species:`);
console.log(`  top-1 correct: ${(ev.acc * 100).toFixed(1)}%   (chance: ${(100 / data.length).toFixed(1)}%)`);
console.log(`  in top-3:      ${(ev.top3 * 100).toFixed(1)}%`);
console.log(`  balanced top-1 (per-species avg): ${(ev.balanced * 100).toFixed(1)}%`);
const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const allG = ev.genuine.flat(), allI = ev.impostor.flat();
console.log(`  median score, right bird: ${(med(allG) * 100).toFixed(0)}%   wrong birds: ${(med(allI) * 100).toFixed(0)}%`);

// ---------- label calibration ----------
// "Absent" = the caller's species is removed from the guide, so the top
// match is wrong by construction: exactly the baby's situation. Labels are
// set so that such sounds rarely earn them.
const IQ = ev.impostor.map(a => tailQuantiles(a));
const absRar = [], present = [];
for (const r of ev.rows) {
  let tb = -1, ts = -1, ta = -1, tsa = -1;
  r.scores.forEach((s, b) => { if (s > ts) { ts = s; tb = b; } if (b !== r.a && s > tsa) { tsa = s; ta = b; } });
  absRar.push(rarity(tsa, IQ[ta]));
  present.push({ rar: rarity(ts, IQ[tb]), ok: tb === r.a });
  // alternative ranking: by rarity instead of raw score
  let rb = -1, rr = 2;
  r.scores.forEach((s, b) => { const x = rarity(s, IQ[b]); if (x < rr) { rr = x; rb = b; } });
  (ev.altOk = ev.altOk || []).push(rb === r.a);
}
console.log(`  (ranking by rarity instead of raw score: top-1 ${(ev.altOk.filter(Boolean).length / ev.altOk.length * 100).toFixed(1)}%)`);
absRar.sort((x, y) => x - y);
const at = q => absRar[Math.floor(q * (absRar.length - 1))];
const LEVELS = { strong: +at(0.05).toFixed(4), good: +at(0.15).toFixed(4), possible: +at(0.40).toFixed(4) };
const prec = th => { const sel = present.filter(p => p.rar <= th); return { n: sel.length, frac: sel.length / present.length, prec: sel.filter(p => p.ok).length / Math.max(1, sel.length) }; };
console.log('\nLabel thresholds (rarity of top bird), calibrated on absent-species calls:');
for (const [k, th] of Object.entries(LEVELS)) {
  const p = prec(th);
  console.log(`  ${k.padEnd(9)} rarity <= ${th.toFixed(4)}   real birds: ${(p.frac * 100).toFixed(0)}% of calls get it, top pick right ${(p.prec * 100).toFixed(0)}% of the time`);
}
const LABEL_STATS = Object.fromEntries(Object.entries(LEVELS).map(([k, th]) => [k, { falseAlarm: { strong: 0.05, good: 0.15, possible: 0.4 }[k], precision: +prec(th).prec.toFixed(3), coverage: +prec(th).frac.toFixed(3) }]));

if (args.includes('--dry')) process.exit(0);

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'audio'), { recursive: true });
let blurbs = {};
try { blurbs = (await import('./blurbs.mjs')).BLURBS; } catch {}
const birds = data.map((d, i) => {
  const refs = ev.fullRefs[i];
  const clip = makeClip(d, refs, path.join(ROOT, 'audio'));
  const photo = d.meta.photo && fs.existsSync(path.join(ROOT, 'img', d.sp.id + '.jpg')) ? d.meta.photo : null;
  console.log(`${d.sp.id.padEnd(20)} refs ${String(refs.length).padStart(2)}  genuine med ${(med(ev.genuine[i]) * 100 || 0).toFixed(0)}%  impostor p95 ${(IQ[i][10][1] * 100).toFixed(0)}%`);
  return {
    id: d.sp.id, name: d.sp.name, sci: d.sp.sci, emoji: d.sp.emoji, wiki: d.sp.wiki,
    ...(blurbs[d.sp.id] || {}),
    refs: refs.map(r => r.feat),
    genuine: quantiles(ev.genuine[i]),
    impostor: IQ[i],
    clip, photo: photo && { artist: photo.artist, license: photo.license, licenseUrl: photo.licenseUrl, page: photo.page },
    recordings: d.recs.map(r => ({ xc: r.file.xc, recordist: r.file.recordist, license: r.file.license, page: r.file.page })),
  };
});
const out = {
  version: HASH, built: new Date().toISOString().slice(0, 10), params: P,
  eval: { calls: ev.n, species: data.length, top1: +ev.acc.toFixed(3), top3: +ev.top3.toFixed(3), balanced: +ev.balanced.toFixed(3), labels: LABEL_STATS },
  levels: LEVELS,
  birds,
};
fs.writeFileSync(path.join(ROOT, 'data/birds.json'), JSON.stringify(out));
console.log(`\nwrote data/birds.json (${(fs.statSync(path.join(ROOT, 'data/birds.json')).size / 1024).toFixed(0)} KB)`);

// ---------- credits ----------
const lines = ['# Credits', '', 'Bird recordings come from [xeno-canto](https://xeno-canto.org) and are used under their Creative Commons licences; each short clip in `audio/` is an excerpt of the recording named as that bird\u2019s field guide clip and is shared under that recording\u2019s licence. Photos are from Wikimedia Commons.', ''];
for (const b of birds) {
  lines.push(`## ${b.name} (*${b.sci}*)`, '');
  if (b.clip) lines.push(`- Field guide clip: ${b.clip.recordist}, [XC${b.clip.xc}](${b.clip.page}), ${b.clip.license}`);
  lines.push(`- Reference recordings: ${b.recordings.map(r => `[XC${r.xc}](${r.page}) ${r.recordist} (${r.license.replace('Creative Commons ', 'CC ')})`).join('; ')}`);
  if (b.photo) lines.push(`- Photo: ${b.photo.artist}, [${b.photo.license}](${b.photo.page})`);
  lines.push('');
}
fs.writeFileSync(path.join(ROOT, 'CREDITS.md'), lines.join('\n'));
console.log('wrote CREDITS.md');
