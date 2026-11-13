// Fetches one freely-licensed photo per species (Wikipedia lead image via
// Wikimedia Commons), slowly, into img/<id>.jpg; credits into raw/<id>/meta.json.
import { SPECIES } from './species.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'FledglingBirdApp/0.1 (personal hobby project)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
let last = 0;

async function get(url, gap = 1500) {
  for (let i = 0; i < 6; i++) {
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return r;
    if (r.status !== 429 && r.status < 500) throw new Error(`${r.status} ${url}`);
    const back = Math.max((+r.headers.get('retry-after') || 0) * 1000, 20000 * 2 ** i);
    console.warn(`  ${r.status}; waiting ${Math.round(back / 1000)}s`);
    await sleep(back);
  }
  throw new Error('gave up ' + url);
}
const api = async (host, p) => (await get(`https://${host}/w/api.php?` + new URLSearchParams({ format: 'json', ...p }))).json();

await fs.mkdir(path.join(ROOT, 'img'), { recursive: true });
for (const sp of SPECIES) {
  const out = path.join(ROOT, 'img', sp.id + '.jpg');
  const metaPath = path.join(ROOT, 'raw', sp.id, 'meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  try { await fs.access(out); if (meta.photo) { console.log(sp.id, 'cached'); continue; } } catch {}
  try {
    const d = await api('en.wikipedia.org', { action: 'query', titles: sp.wiki, prop: 'pageimages', piprop: 'name', redirects: '1' });
    const file = Object.values(d.query?.pages || {})[0]?.pageimage;
    if (!file) { console.log(sp.id, 'no lead image'); continue; }
    const c = await api('commons.wikimedia.org', { action: 'query', titles: 'File:' + file, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '640', iiextmetadatafilter: 'LicenseShortName|Artist|LicenseUrl' });
    const ii = Object.values(c.query?.pages || {})[0]?.imageinfo?.[0];
    if (!ii) { console.log(sp.id, 'lead image not on Commons (skipped)'); continue; }
    const em = ii.extmetadata || {};
    const lic = em.LicenseShortName?.value || '';
    if (/fair use|non-free/i.test(lic)) { console.log(sp.id, 'non-free, skipped'); continue; }
    const tmp = out + '.dl';
    await fs.writeFile(tmp, Buffer.from(await (await get(ii.thumburl || ii.url, 6000)).arrayBuffer()));
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '78', '-Z', '640', tmp, '--out', out], { stdio: 'ignore' });
    await fs.unlink(tmp);
    meta.photo = { file, page: ii.descriptionurl, license: lic, licenseUrl: em.LicenseUrl?.value || '', artist: strip(em.Artist?.value) };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    console.log(sp.id.padEnd(20), lic, '|', meta.photo.artist.slice(0, 40));
  } catch (e) { console.warn(sp.id, 'failed:', e.message); }
}
