// Downloads reference recordings from xeno-canto (quality A, several
// different recordists per species) into raw/<id>/ (gitignored).
// Usage: node tools/fetch_xc.mjs [speciesId ...]
import { SPECIES } from './species.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'raw');
const UA = 'FledglingBirdApp/0.1 (personal hobby project)';
const WANT = 6;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;

async function get(url) {
  for (let i = 0; i < 5; i++) {
    const wait = last + 2000 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return r;
    if (r.status !== 429 && r.status < 500) throw new Error(`${r.status} ${url}`);
    const back = Math.max((+r.headers.get('retry-after') || 0) * 1000, 15000 * 2 ** i);
    console.warn(`  ${r.status}; backing off ${back / 1000}s`);
    await sleep(back);
  }
  throw new Error('gave up ' + url);
}

const decode = s => s.replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();

function parseRows(html) {
  const rows = html.match(/<tr\s*>[\s\S]*?<\/tr>/g) || [];
  const out = [];
  for (const r of rows) {
    const src = (r.match(/<audio[^>]*src='([^']+)'/) || [])[1];
    const id = (r.match(/xeno-canto\.org\/(\d+)\/download/) || [])[1];
    if (!src || !id) continue;
    const tds = (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(decode);
    const lenTxt = tds[2] || '';
    const [mm, ss] = lenTxt.split(':').map(Number);
    const q = (r.match(/<li id='rating-\d+-\d' class='selected'><span>([A-E])/) || [])[1] || '?';
    const lic = (r.match(/<span title="(Creative Commons[^"]+)"><a href="([^"]+)"/) || []);
    out.push({
      xc: id, src, dur: mm * 60 + ss, recordist: tds[3], date: tds[4], country: tds[6],
      type: tds[9] || '', quality: q, license: lic[1] || '', licenseUrl: lic[2] || '',
      page: `https://xeno-canto.org/${id}`,
    });
  }
  return out;
}

const only = process.argv.slice(2);
for (const sp of SPECIES) {
  if (only.length && !only.includes(sp.id)) continue;
  const dir = path.join(RAW, sp.id);
  await fs.mkdir(dir, { recursive: true });
  let meta = { id: sp.id, files: [], photo: null };
  try { meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch {}
  const NONVOCAL = /wing|mechanical|non-vocal|instrument|clap|snap|feet|bill/i;
  meta.files = meta.files.filter(f => f.source === 'xc' && !NONVOCAL.test(f.type));
  if (meta.files.length >= WANT) { console.log(sp.id.padEnd(20), 'cached'); continue; }

  const seenRec = new Set(), seenType = new Set();
  const slug = sp.sci.replace(' ', '-');
  let rows = [];
  for (const query of ['q:A len:3-90', 'q:">B" len:3-120']) {
    const html = await (await get(`https://xeno-canto.org/species/${slug}?query=${encodeURIComponent(query)}`)).text();
    rows.push(...parseRows(html));
    if (rows.filter(r => !/NoDerivs/i.test(r.license)).length >= WANT * 2) break;
  }
  const have = new Set(meta.files.map(f => f.xc));
  rows = rows.filter(r => r.license && !/NoDerivs/i.test(r.license) && r.dur >= 3 && r.dur <= 120 && !NONVOCAL.test(r.type) && !have.has(r.xc));
  for (const f of meta.files) { seenRec.add(f.recordist); seenType.add(f.type.split(',')[0]); }
  // Diversity: different recordists first, mix call types.
  const picked = [];
  for (const pass of [0, 1, 2]) {
    for (const r of rows) {
      if (picked.length + meta.files.length >= WANT) break;
      if (picked.includes(r)) continue;
      const t = r.type.split(',')[0];
      if (pass === 0 && (seenRec.has(r.recordist) || seenType.has(t))) continue;
      if (pass === 1 && seenRec.has(r.recordist)) continue;
      picked.push(r); seenRec.add(r.recordist); seenType.add(t);
    }
  }
  for (const r of picked) {
    const local = `xc${r.xc}.mp3`;
    try {
      try { await fs.access(path.join(dir, local)); }
      catch { await fs.writeFile(path.join(dir, local), Buffer.from(await (await get(r.src)).arrayBuffer())); }
      meta.files.push({ ...r, local, source: 'xc' });
    } catch (e) { console.warn('  skip', r.xc, e.message); }
  }
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(sp.id.padEnd(20), `${meta.files.length} recs [${meta.files.map(f => f.quality + ' ' + f.type.split(',')[0]).join(' | ')}]`);
}
