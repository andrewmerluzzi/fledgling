// Downloads freely-licensed reference recordings + a photo for each species
// from Wikimedia Commons / Wikipedia into raw/<id>/ (gitignored).
// Usage: node tools/fetch.mjs [speciesId ...]
import { SPECIES } from './species.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'raw');
const UA = 'FledglingBirdApp/0.1 (personal hobby project)';
const MAX_FILES = 4;
const sleep = ms => new Promise(res => setTimeout(res, ms));
let last = 0;
// Polite, rate-limited fetch with back-off on 429/5xx.
async function politeFetch(url) {
  for (let i = 0; i < 7; i++) {
    const wait = last + 2500 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return r;
    if (r.status !== 429 && r.status < 500) throw new Error(`${r.status} ${url}`);
    const ra = +r.headers.get('retry-after') || 0;
    const back = Math.max(ra * 1000, 10000 * 2 ** i);
    console.warn(`  ${r.status}, backing off ${Math.round(back / 1000)}s`);
    await sleep(back);
  }
  throw new Error('gave up ' + url);
}

async function api(host, params) {
  const url = `https://${host}/w/api.php?` + new URLSearchParams({ format: 'json', ...params });
  return (await politeFetch(url)).json();
}

const strip = s => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function searchAudio(sp) {
  const term = sp.q || `"${sp.sci}"`;
  const d = await api('commons.wikimedia.org', {
    action: 'query', generator: 'search', gsrsearch: `filetype:audio ${term}`,
    gsrnamespace: '6', gsrlimit: '40', prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiextmetadatafilter: 'LicenseShortName|Artist|ImageDescription|LicenseUrl',
  });
  const pages = Object.values(d.query?.pages || {});
  const seenXC = new Set();
  const out = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii) continue;
    const title = p.title;
    if (!/^audio\/(mpeg|ogg|wav|x-wav|flac)|^application\/ogg/.test(ii.mime)) continue;
    const dur = ii.duration || 0;
    if (dur < 2 || dur > 240) continue;
    // Skip non-vocal sounds & obviously-other-species compilations
    if (/wing|drum|feather|bill.?clap|mechanical|spectrogram/i.test(title)) continue;
    const xc = (title.match(/XC\s?(\d+)/i) || [])[1];
    if (xc) { if (seenXC.has(xc)) continue; seenXC.add(xc); }
    const em = ii.extmetadata || {};
    const lic = em.LicenseShortName?.value || '';
    if (/\bNC\b|\bND\b/.test(lic)) continue;
    out.push({
      title, url: ii.url, page: ii.descriptionurl, mime: ii.mime, dur, size: ii.size,
      license: lic, licenseUrl: em.LicenseUrl?.value || '', artist: strip(em.Artist?.value), xc,
    });
  }
  // Prefer files that name the species, moderate length, and xeno-canto sourced (curated).
  const nameHit = f => new RegExp(sp.sci.split(' ')[1], 'i').test(f.title) || new RegExp(sp.name.split(' ').pop(), 'i').test(f.title);
  out.sort((a, b) => (nameHit(b) - nameHit(a)) || (!!b.xc - !!a.xc) || (Math.abs(Math.log(a.dur / 40)) - Math.abs(Math.log(b.dur / 40))));
  return out.filter(nameHit).slice(0, MAX_FILES);
}

async function photo(sp) {
  const d = await api('en.wikipedia.org', {
    action: 'query', titles: sp.wiki, prop: 'pageimages', piprop: 'name', redirects: '1',
  });
  const pg = Object.values(d.query?.pages || {})[0];
  const file = pg?.pageimage;
  if (!file) return null;
  const c = await api('commons.wikimedia.org', {
    action: 'query', titles: 'File:' + file, prop: 'imageinfo',
    iiprop: 'url|extmetadata', iiurlwidth: '480',
    iiextmetadatafilter: 'LicenseShortName|Artist|LicenseUrl',
  });
  const ii = Object.values(c.query?.pages || {})[0]?.imageinfo?.[0];
  if (!ii) return null; // non-free enwiki-local image: skip
  const em = ii.extmetadata || {};
  return {
    url: ii.thumburl || ii.url, page: ii.descriptionurl, file,
    license: em.LicenseShortName?.value || '', licenseUrl: em.LicenseUrl?.value || '', artist: strip(em.Artist?.value),
  };
}

async function download(url, dest) {
  try { await fs.access(dest); return; } catch {}
  const r = await politeFetch(url.split('?')[0]);
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
}

const only = process.argv.slice(2);
for (const sp of SPECIES) {
  if (only.length && !only.includes(sp.id)) continue;
  const dir = path.join(RAW, sp.id);
  await fs.mkdir(dir, { recursive: true });
  try { const m = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')); if (m.files.length >= 3 && m.photo) { console.log(sp.id, 'cached'); continue; } } catch {}
  const files = await searchAudio(sp);
  const meta = { id: sp.id, files: [], photo: null };
  for (const [i, f] of files.entries()) {
    const ext = f.mime.includes('mpeg') ? 'mp3' : f.mime.includes('flac') ? 'flac' : f.mime.includes('wav') ? 'wav' : 'ogg';
    const local = `rec${i}.${ext}`;
    try { await download(f.url, path.join(dir, local)); meta.files.push({ ...f, local }); }
    catch (e) { console.warn('  skip', f.title, e.message); }
  }
  try {
    const ph = await photo(sp);
    if (ph) { await download(ph.url, path.join(dir, 'photo' + path.extname(new URL(ph.url).pathname).toLowerCase())); meta.photo = ph; }
  } catch (e) { console.warn('  photo fail', sp.id, e.message); }
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`${sp.id.padEnd(20)} ${meta.files.length} recordings ${meta.files.map(f => Math.round(f.dur) + 's').join(',')}  photo:${meta.photo ? meta.photo.license : 'none'}`);
}
