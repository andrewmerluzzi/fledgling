import { Analyzer, Resampler, SR } from './analysis.js';
import { rankBirds, TRAITS, TRAIT_LABELS, scoreAtRarity } from './match.js';
import * as store from './store.js';
import { encodeWav, decodeWav } from './wav.js';
import { LiveSpectrogram, drawClip, yOfFreq } from './spectrogram.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = v => Math.round(v * 100);
const LIVE_PEAK_MIN = 6; // dB above background before a sound counts as a call
const MIN_DUR = 0.15;    // s: same minimum call length as the reference birds

const TRAIT_HELP = {
  pitch: 'How high or low (allowing for baby-vs-bird range)',
  shape: 'Does the pitch rise, fall or wobble the same way?',
  rhythm: 'Pulses, rattles and syllable pattern',
  tone: 'Pure whistle vs. raspy vs. harmonic voice',
  length: 'How long the call lasts',
};

// ---------- settings (per-device conveniences) ----------
const DEFAULTS = { name: '', sensitivity: 0, saveClips: true };
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('fledgling.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
})();
const saveSettings = () => { try { localStorage.setItem('fledgling.settings', JSON.stringify(settings)); } catch {} };
const babyName = () => settings.name.trim() || 'Baby';
const poss = n => (/s$/i.test(n) ? n + '’' : n + '’s');

// ---------- state ----------
let DB = null;
const BIRDS = {};
let sightings = [];
const session = new Map();
let latest = null;      // { s, wav }
let listener = null;
let spec = null;
let raf = 0;
let wakeLock = null;
const memClips = new Map(); // sighting id or 'latest' -> ArrayBuffer

// ---------- honest assessment ----------
// rarity = share of OTHER species' real calls that score at least this high
// against the bird. Thresholds come from tools/build.mjs: calls from species
// left out of the guide (like a baby!) earn Strong 5%, Good 15%, Possible 40%
// of the time.
function assess(r) {
  const L = DB.levels, rar = r.rarity ?? 1;
  if (rar <= L.strong) return { level: 3, label: 'Strong match' };
  if (rar <= L.good) return { level: 2, label: 'Good match' };
  if (rar <= L.possible) return { level: 1, label: 'Possible match' };
  return { level: 0, label: 'Unidentified' };
}
const LEVEL_LABEL = ['Unidentified', 'Possible match', 'Good match', 'Strong match'];

function honestLine(s) {
  const b = BIRDS[s.bird], g = b.genuine || [];
  const r = s.rarity ?? 1;
  const share = r < 0.001 ? 'Fewer than 1 in 1,000' : r < 0.01 ? `Only ${(r * 100).toFixed(1)}%` : r >= 0.995 ? 'Nearly all' : `${Math.round(r * 100)}%`;
  return `Real ${esc(b.name)} calls typically score <b>${pct(g[5])}–${pct(g[15])}%</b> here. ` +
    `${share} of other birds’ calls score ${pct(s.score)}% or more.`;
}

// ---------- UI helpers ----------
function avatar(id, cls = '') {
  const b = BIRDS[id];
  if (b.photo) return `<div class="avatar ${cls}"><img src="img/${b.id}.jpg" alt="" loading="lazy"></div>`;
  return `<div class="avatar ${cls}">${b.emoji || '🐦'}</div>`;
}
function ring(score, level, big = false) {
  const r = 30, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(1, score)));
  return `<div class="ring ${big ? 'big' : ''} l${level}"><svg viewBox="0 0 70 70"><circle class="track" cx="35" cy="35" r="${r}" fill="none" stroke-width="7"/>` +
    `<circle class="val" cx="35" cy="35" r="${r}" fill="none" stroke-width="7" stroke-dasharray="${c}" stroke-dashoffset="${off}"/></svg>` +
    `<div class="pct"><div>${pct(score)}<small>%</small></div></div></div>`;
}
const chip = level => `<span class="chip l${level}">${LEVEL_LABEL[level]}</span>`;
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function ago(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400 && new Date(ts).getDate() === new Date().getDate()) return `today ${fmtTime(ts)}`;
  return `${fmtDate(ts)}, ${fmtTime(ts)}`;
}

let toastT = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- views ----------
function showView(v) {
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#listen-dock').classList.toggle('hidden', v !== 'listen');
  if (v === 'life') renderLife();
  if (v === 'guide') renderGuide();
  window.scrollTo({ top: 0 });
}

function lifeMap() {
  const m = new Map();
  for (const s of sightings) {
    if (s.level < 2) continue;
    const e = m.get(s.bird) || { first: s.ts, count: 0, best: s };
    e.first = Math.min(e.first, s.ts);
    e.count++;
    if (s.score > e.best.score) e.best = s;
    m.set(s.bird, e);
  }
  return m;
}

function renderNames() {
  const n = babyName();
  $('#tagline').textContent = settings.name.trim() ? `Sound ID for ${n}` : 'Sound ID for very small birds';
  $('#session-empty').textContent = `Nothing yet. Birds ${n} sounds like will gather here.`;
  $('#life-title').textContent = `${poss(n)} Life List`;
}

function renderSession() {
  const list = $('#session-list');
  const rows = [...session.values()].sort((a, b) => b.last - a.last);
  $('#session-empty').style.display = rows.length ? 'none' : '';
  $('#session-count').textContent = rows.length ? `${rows.length} species` : '';
  list.innerHTML = rows.map(e => {
    const b = BIRDS[e.bird];
    return `<li><button class="bird-row ${e.flash ? 'flash' : ''}" data-sighting="${e.best.id ?? 'latest'}">
      ${avatar(e.bird)}
      <div class="info"><div class="nm">${esc(b.name)}</div><div class="meta">${chip(e.best.level)} &nbsp;×${e.count}</div></div>
      <div class="score">${pct(e.best.score)}%<small>best</small></div></button></li>`;
  }).join('');
  for (const e of rows) e.flash = false;
}

function renderLatest() {
  const el = $('#latest');
  if (!latest) { el.innerHTML = ''; return; }
  const s = latest.s, b = BIRDS[s.bird];
  const myst = s.level === 0;
  el.innerHTML = `<div class="match-card">
    <div class="match-top">
      ${myst ? '<div class="avatar">❔</div>' : avatar(s.bird)}
      <div class="who">
        <div class="eyebrow">${myst ? 'Unidentified call' : `${esc(babyName())} sounds like`}</div>
        <div class="match-name">${myst ? 'Mystery bird' : esc(b.name)}</div>
        ${myst ? `<span class="sci">Closest: ${esc(b.name)}, ${pct(s.score)}%</span>` : chip(s.level)}
      </div>
      ${ring(s.score, s.level)}
    </div>
    <p class="honest">${myst ? `Not distinctive enough to call. ${Math.round((s.rarity ?? 1) * 100)}% of other birds’ calls match ${esc(b.name)} at least this well.` : honestLine(s)}</p>
    ${s.runners?.length ? `<div class="runners"><span class="small muted" style="align-self:center">Also like:</span>${s.runners.slice(0, 3).map(r => `<span class="runner">${esc(BIRDS[r.id].name)} ${pct(r.score)}%</span>`).join('')}</div>` : ''}
    <div class="card-actions">
      <button class="btn" data-act="play-latest">▶ Play</button>
      <button class="btn primary" data-sighting="${s.id ?? 'latest'}">Why ${pct(s.score)}%?</button>
    </div>
  </div>`;
}

function renderLife() {
  const lm = lifeMap();
  const rows = [...lm.entries()].sort((a, b) => b[1].first - a[1].first);
  $('#life-sub').textContent = rows.length
    ? `${rows.length} of ${DB.birds.length} species confirmed · ${sightings.length} sightings logged`
    : `0 of ${DB.birds.length} species confirmed`;
  $('#life-empty').style.display = rows.length ? 'none' : '';
  $('#life-list').innerHTML = rows.map(([id, e]) => `<li><button class="bird-row" data-bird="${id}">
      ${avatar(id)}
      <div class="info"><div class="nm">${esc(BIRDS[id].name)}</div>
      <div class="meta">First heard ${fmtDate(e.first)} · ${e.count} sighting${e.count > 1 ? 's' : ''}</div></div>
      <div class="score">${pct(e.best.score)}%<small>best</small></div></button></li>`).join('');
  const recent = sightings.slice().sort((a, b) => b.ts - a.ts).slice(0, 40);
  $('#recent-empty').style.display = recent.length ? 'none' : '';
  $('#recent-list').innerHTML = recent.map(s => `<li><button class="sighting-row" data-sighting="${s.id}">
      ${avatar(s.bird, 'sm')}
      <div class="info"><div><b>${esc(BIRDS[s.bird].name)}</b> · ${pct(s.score)}%</div><div class="when">${chip(s.level)} ${ago(s.ts)}</div></div>
    </button></li>`).join('');
}

function renderGuide() {
  const lm = lifeMap();
  $('#guide-sub').textContent = `${DB.birds.length} birds, each with real recordings. Tap one to hear it.`;
  const birds = DB.birds.slice().sort((a, b) => a.name.localeCompare(b.name));
  $('#guide-list').innerHTML = birds.map(b => `<li><button class="guide-card" data-bird="${b.id}">
      <div class="ph">${b.photo ? `<img src="img/${b.id}.jpg" alt="" loading="lazy">` : (b.emoji || '🐦')}</div>
      ${lm.has(b.id) ? '<span class="seen">✓ Spotted</span>' : ''}
      <div class="cap"><div class="nm">${esc(b.name)}</div><div class="sci">${esc(b.sci)}</div></div>
    </button></li>`).join('');
}

// ---------- sheet ----------
function openSheet(html, after) {
  stopPlayback();
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
  $('.sheet-panel').scrollTop = 0;
  document.body.style.overflow = 'hidden';
  if (after) after($('#sheet-body'));
}
function closeSheet() {
  stopPlayback();
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
}

function hero(b) {
  const credit = b.photo ? `Photo: ${esc(b.photo.artist || 'Wikimedia Commons')} (${esc(b.photo.license)})` : '';
  return `<div class="hero"><div class="ph">${b.photo ? `<img src="img/${b.id}.jpg" alt="${esc(b.name)}">` : (b.emoji || '🐦')}</div>${credit ? `<div class="credit">${credit}</div>` : ''}</div>`;
}

const PLAY_ICON = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 7h10v10H7z"/></svg>';
function clipBox(label, key) {
  return `<div class="clip" data-clip="${key}"><canvas></canvas><span class="lbl">${esc(label)}</span><div class="playhead"></div>
    <button class="play" aria-label="Play ${esc(label)}">${PLAY_ICON}</button></div>`;
}

async function openSighting(key) {
  let s, wav = null;
  if (key === 'latest') { s = latest?.s; wav = latest?.wav; }
  else { s = sightings.find(x => String(x.id) === String(key)); wav = memClips.get(s?.id) || await store.getClip(s?.id).catch(() => null); }
  if (!s) return;
  const b = BIRDS[s.bird];
  const myst = s.level === 0;
  const traitRows = TRAITS.map(k => `<div class="trait" title="${esc(TRAIT_HELP[k])}"><span>${TRAIT_LABELS[k]}</span><div class="bar"><span style="width:${pct(s.traits[k])}%"></span></div><span class="v">${pct(s.traits[k])}%</span></div>`).join('');
  const html = `${hero(b)}
    <div class="match-top">
      <div class="who">
        <div class="eyebrow">${myst ? 'Closest bird (unconfirmed)' : esc(babyName()) + ' sounded like'}</div>
        <h2 class="title">${esc(b.name)}</h2>
        <div class="sci">${esc(b.sci)}</div>
        <div style="margin-top:6px">${chip(s.level)} <span class="small muted">${ago(s.ts)}</span></div>
      </div>
      ${ring(s.score, s.level, true)}
    </div>
    <div class="block"><h4>Why ${pct(s.score)}%?</h4>
      ${traitRows}
      <p class="honest">${myst ? `Too common a match to count: ${Math.round((s.rarity ?? 1) * 100)}% of other birds’ calls score this high against ${esc(b.name)}.` : honestLine(s)}</p>
    </div>
    <div class="block"><h4>Compare</h4><div class="compare">
      ${wav ? clipBox(babyName(), 'baby') : '<p class="small muted">No clip saved for this sighting.</p>'}
      ${b.clip ? clipBox(`Real ${b.name}`, 'bird') : ''}
    </div></div>
    ${s.runners?.length ? `<div class="block"><h4>Runners-up</h4>${s.runners.map(r => `<div class="trait wide"><span>${esc(BIRDS[r.id].name)}</span><div class="bar"><span style="width:${pct(r.score)}%;background:var(--muted)"></span></div><span class="v">${pct(r.score)}%</span></div>`).join('')}</div>` : ''}
    <div class="row-actions">
      <button class="btn" data-bird="${b.id}">Field guide entry</button>
      ${wav ? '<button class="btn" data-act="share">Share clip</button>' : ''}
      ${s.id ? `<button class="btn danger" data-act="delete" data-id="${s.id}">Delete</button>` : ''}
    </div>`;
  openSheet(html, async body => {
    if (wav) setupClip(body.querySelector('[data-clip="baby"]'), { wav });
    if (b.clip) setupClip(body.querySelector('[data-clip="bird"]'), { url: `audio/${b.id}.m4a` });
    const sh = body.querySelector('[data-act="share"]');
    if (sh) sh.onclick = () => shareClip(wav, `${babyName()} as a ${b.name}`);
    const del = body.querySelector('[data-act="delete"]');
    if (del) del.onclick = async () => {
      if (!confirm('Delete this sighting and its clip?')) return;
      await store.deleteSighting(s.id);
      sightings = sightings.filter(x => x.id !== s.id);
      closeSheet(); renderLife(); toast('Sighting deleted');
    };
  });
}

function openBird(id) {
  const b = BIRDS[id];
  const mine = sightings.filter(s => s.bird === id).sort((a, b2) => b2.score - a.score);
  const best = mine[0];
  const g = b.genuine || [], imp = b.impostor || [];
  const strongAt = scoreAtRarity(DB.levels.strong, imp), goodAt = scoreAtRarity(DB.levels.good, imp);
  const impAt = l => ((imp.find(p => p[0] >= l) || imp[imp.length - 1]) || [0, 0])[1];
  const recs = (b.recordings || []).map(r => `<a href="${esc(r.page)}" target="_blank" rel="noopener">XC${esc(r.xc)}</a> ${esc(r.recordist)}`).join(' · ');
  const html = `${hero(b)}
    <h2 class="title">${esc(b.name)}</h2>
    <div class="sci">${esc(b.sci)}</div>
    <p class="small" style="margin:8px 0 0">${best ? `${chip(best.level)} &nbsp;${esc(babyName())}’s best: <b>${pct(best.score)}%</b> · ${mine.length} sighting${mine.length > 1 ? 's' : ''}` : `<span class="muted">Not heard from ${esc(babyName())} yet.</span>`}</p>
    ${b.clip ? `<div class="block"><h4>Real call</h4>${clipBox(`${b.name} · ${b.clip.country || ''}`, 'bird')}<p class="credits" style="margin-top:6px">Recording: ${esc(b.clip.recordist)}, <a href="${esc(b.clip.page)}" target="_blank" rel="noopener">XC${esc(b.clip.xc)}</a> (${esc(b.clip.license)})</p></div>` : ''}
    ${b.call ? `<div class="block"><h4>Voice</h4><p>${esc(b.call)}</p></div>` : ''}
    ${b.fact ? `<div class="block"><h4>Did you know</h4><p>${esc(b.fact)}</p></div>` : ''}
    ${b.nursery ? `<div class="note"><b>Nursery field notes</b>${esc(b.nursery)}</div>` : ''}
    <div class="block"><h4>What counts as a match</h4>
      <p class="small">Real ${esc(b.name)} calls (from recordings the matcher hadn’t seen) score <b>${pct(g[5])}–${pct(g[15])}%</b>. Other birds’ calls usually score under <b>${pct(impAt(0.9))}%</b>. ${esc(babyName())} needs about <b>${pct(goodAt)}%</b> for a good match and <b>${pct(strongAt)}%</b> for a strong one.</p>
    </div>
    ${mine.length ? `<div class="block"><h4>Sightings</h4><ul class="sighting-list">${mine.slice(0, 20).map(s => `<li><button class="sighting-row" data-sighting="${s.id}"><div class="info"><b>${pct(s.score)}%</b> ${chip(s.level)}<div class="when">${ago(s.ts)}</div></div></button></li>`).join('')}</ul></div>` : ''}
    <p class="credits">Reference recordings from xeno-canto: ${recs}.${b.photo ? ` Photo: ${esc(b.photo.artist)}, <a href="${esc(b.photo.page)}" target="_blank" rel="noopener">${esc(b.photo.license)}</a>.` : ''}</p>`;
  openSheet(html, body => {
    if (b.clip) setupClip(body.querySelector('[data-clip="bird"]'), { url: `audio/${b.id}.m4a` });
  });
}

function openSettings() {
  const ev = DB.eval || {};
  const html = `<h2 class="title" style="margin:6px 0 4px">Settings</h2>
    <div class="field"><label for="set-name">Baby’s name</label>
      <input type="text" id="set-name" value="${esc(settings.name)}" placeholder="Baby" autocomplete="off" maxlength="30">
      <div class="hint">Only stored on this phone.</div></div>
    <div class="field"><label for="set-sens">Sensitivity</label>
      <input type="range" id="set-sens" min="-3" max="8" step="1" value="${-settings.sensitivity}">
      <div class="hint" id="sens-hint"></div></div>
    <div class="field toggle"><label for="set-clips" style="margin:0">Save audio clips of sightings</label>
      <input type="checkbox" id="set-clips" ${settings.saveClips ? 'checked' : ''}></div>
    <div class="block prose"><h4>How the match works</h4>
      <p>Each sound is split into <b>calls</b>. For every call we measure pitch, the shape of the pitch (rising, falling, wobbling), rhythm (pulses, rattles, syllables), tone (whistle vs. rasp) and length, then compare against ${DB.birds.reduce((a, b) => a + b.refs.length, 0)} real bird calls from ${DB.birds.reduce((a, b) => a + (b.recordings?.length || 0), 0)} xeno-canto recordings.</p>
      <p>The percentage is a weighted geometric average of those five similarities, so one big mismatch drags it down hard.</p>
      <p>We tested the same code on real bird calls it had never seen (leaving each recording out in turn):</p>
      <div class="stats">
        <div class="stat"><b>${Math.round((ev.top1 || 0) * 100)}%</b><span>right bird first</span></div>
        <div class="stat"><b>${Math.round((ev.top3 || 0) * 100)}%</b><span>right bird in top 3</span></div>
        <div class="stat"><b>${Math.round(100 / (ev.species || 1))}%</b><span>pure guessing</span></div>
      </div>
      <p>With ${ev.species || 36} birds to choose from, <i>some</i> bird is always closest, so the labels are calibrated the strict way: we removed each species from the guide and checked how often its calls still earned a label for some other bird. That’s exactly ${esc(poss(babyName()))} situation.</p>
      <p><b>Strong match</b>: sounds from outside the guide earn it only 5% of the time. When a real bird earns it, the pick is right ${pct(ev.labels?.strong?.precision ?? 0)}% of the time.<br>
      <b>Good match</b>: 15% of outside sounds (right ${pct(ev.labels?.good?.precision ?? 0)}% for real birds).<br>
      <b>Possible match</b>: 40% (right ${pct(ev.labels?.possible?.precision ?? 0)}%).</p>
      <p>When it’s wrong it’s usually wrong sensibly: crows get called ravens, cardinals get called mockingbirds (which imitate cardinals), turkeys get called peafowl.</p>
    </div>
    <div class="row-actions">
      <button class="btn danger" id="set-clear">Delete all sightings</button>
    </div>
    <p class="credits" style="margin-top:16px">Recordings: xeno-canto contributors (Creative Commons, see each field guide entry). Photos: Wikimedia Commons. Everything ${esc(babyName())} records stays on this phone. Data ${esc(DB.version)} · built ${esc(DB.built)}.</p>`;
  openSheet(html, body => {
    const name = body.querySelector('#set-name');
    name.oninput = () => { settings.name = name.value; saveSettings(); renderNames(); renderSession(); };
    const sens = body.querySelector('#set-sens'), hint = body.querySelector('#sens-hint');
    const upd = () => {
      settings.sensitivity = -Number(sens.value);
      saveSettings();
      if (listener?.analyzer) listener.analyzer.onDb = settings.sensitivity;
      const v = Number(sens.value);
      hint.textContent = v >= 4 ? 'Very sensitive: picks up quiet coos (and the dishwasher).' : v >= 1 ? 'Sensitive: good for a quiet room.' : v <= -2 ? 'Only loud, clear calls.' : 'Balanced (default).';
    };
    sens.oninput = upd; upd();
    body.querySelector('#set-clips').onchange = e => { settings.saveClips = e.target.checked; saveSettings(); };
    body.querySelector('#set-clear').onclick = async () => {
      if (!confirm(`Delete all of ${poss(babyName())} sightings and clips? This can’t be undone.`)) return;
      await store.clearAll();
      sightings = []; session.clear(); latest = null;
      renderSession(); renderLatest(); renderLife(); closeSheet(); toast('All sightings deleted');
    };
  });
}

// ---------- playback ----------
let player = null;
function stopPlayback() {
  if (!player) return;
  try { player.audio.pause(); } catch {}
  if (player.url) URL.revokeObjectURL(player.url);
  player.btn.innerHTML = PLAY_ICON;
  player.head.style.display = 'none';
  cancelAnimationFrame(player.raf);
  player = null;
}

let decodeCtx = null;
async function fetchSamples(src) {
  if (src.wav) { const { samples, rate } = decodeWav(src.wav); return rate === SR ? samples : new Resampler(rate, SR).process(samples); }
  const buf = await (await fetch(src.url)).arrayBuffer();
  decodeCtx = decodeCtx || new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
  const ab = await new Promise((res, rej) => { const p = decodeCtx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
  return new Resampler(ab.sampleRate, SR).process(ab.getChannelData(0));
}

function setupClip(box, src) {
  if (!box) return;
  const canvas = box.querySelector('canvas'), btn = box.querySelector('.play'), head = box.querySelector('.playhead');
  fetchSamples(src).then(x => drawClip(canvas, x)).catch(() => {});
  btn.onclick = async () => {
    if (player && player.btn === btn) { stopPlayback(); return; }
    stopPlayback();
    if (listener) { await stopListening(); toast('Paused listening to play the clip'); }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    const url = src.wav ? URL.createObjectURL(new Blob([src.wav], { type: 'audio/wav' })) : null;
    const audio = new Audio(url || src.url);
    player = { audio, btn, head, url, raf: 0 };
    btn.innerHTML = STOP_ICON;
    head.style.display = 'block';
    const tick = () => {
      if (!player || player.audio !== audio) return;
      const d = audio.duration || 1;
      head.style.left = `${(audio.currentTime / d) * 100}%`;
      player.raf = requestAnimationFrame(tick);
    };
    audio.onended = () => stopPlayback();
    audio.play().then(tick).catch(() => { stopPlayback(); toast('Couldn’t play audio'); });
  };
}

function playLatest() {
  if (!latest?.wav) return;
  const fake = document.createElement('div');
  fake.innerHTML = clipBox('', 'baby');
  setupClip(fake.firstChild, { wav: latest.wav });
  fake.querySelector('.play').click();
}

async function shareClip(wav, title) {
  const file = new File([wav], `${title.replace(/[^\w]+/g, '-').toLowerCase()}.wav`, { type: 'audio/wav' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- lifer celebration ----------
function celebrate(id) {
  const b = BIRDS[id], el = $('#lifer');
  el.innerHTML = `<div class="big">New life bird! ${b.emoji || ''}</div><div class="sub">${esc(b.name)} added to ${esc(poss(babyName()))} life list</div>`;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3800);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#2f5d46', '#d9892b', '#f6e3c4', '#6fae84', '#c4553b'];
  for (let i = 0; i < 40; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = 1.8 + Math.random() * 1.6 + 's';
    c.style.animationDelay = Math.random() * 0.4 + 's';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4200);
  }
}

// ---------- listening ----------
class Listener {
  constructor(onCall, onLevel) { this.onCall = onCall; this.onLevel = onLevel; }
  async start(onDb) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.resampler = new Resampler(this.ctx.sampleRate, SR);
    this.analyzer = new Analyzer({ onDb, ringSeconds: 12 });
    this.calib = []; this.calibN = 0; this.ready = false;
    const src = this.ctx.createMediaStreamSource(this.stream);
    const handle = chunk => this._audio(chunk);
    if (this.ctx.audioWorklet && window.AudioWorkletNode) {
      await this.ctx.audioWorklet.addModule('js/worklet.js');
      this.node = new AudioWorkletNode(this.ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      this.node.port.onmessage = e => handle(e.data);
    } else {
      this.node = this.ctx.createScriptProcessor(2048, 1, 1);
      this.node.onaudioprocess = e => handle(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination);
  }
  _audio(chunk) {
    let ss = 0;
    for (let i = 0; i < chunk.length; i++) ss += chunk[i] * chunk[i];
    this.onLevel(Math.sqrt(ss / chunk.length));
    const x = this.resampler.process(chunk);
    if (!this.ready) {
      // First second: learn the room's background noise (same as for bird recordings).
      this.calib.push(x); this.calibN += x.length;
      if (this.calibN < SR) return;
      const all = new Float32Array(this.calibN);
      let o = 0;
      for (const c of this.calib) { all.set(c, o); o += c.length; }
      this.analyzer.seedNoise(all);
      this.ready = true;
      this.calib = null;
      return this._push(all);
    }
    this._push(x);
  }
  _push(x) {
    for (const ev of this.analyzer.push(x)) this.onCall(ev, this.analyzer);
  }
  async stop() {
    try { this.stream.getTracks().forEach(t => t.stop()); } catch {}
    try { this.node.disconnect(); } catch {}
    try { await this.ctx.close(); } catch {}
  }
}

async function handleCall(ev, an) {
  if (!ev.feat || ev.peak < LIVE_PEAK_MIN || ev.feat.dur < MIN_DUR) return;
  const ranked = rankBirds(ev.feat, DB.birds, DB.params);
  if (!ranked.length) return;
  const top = ranked[0];
  const a = assess(top);
  const s = {
    ts: Date.now(), bird: top.id, score: +top.score.toFixed(4), rarity: top.rarity == null ? null : +top.rarity.toFixed(4),
    level: a.level, traits: Object.fromEntries(TRAITS.map(k => [k, +top.traits[k].toFixed(3)])),
    runners: ranked.slice(1, 4).map(r => ({ id: r.id, score: +r.score.toFixed(4) })), feat: ev.feat,
  };
  const wav = encodeWav(an.audio(ev.a, ev.b, 0.35), SR);
  spec.mark(ev.a, ev.b, a.level ? `${BIRDS[top.id].name} ${pct(top.score)}%` : `? ${pct(top.score)}%`, a.level >= 2);
  if (a.level >= 1) {
    const lifer = a.level >= 2 && !lifeMap().has(s.bird);
    try {
      s.id = await store.addSighting({ ...s }, settings.saveClips ? wav : null);
      memClips.set(s.id, wav);
    } catch (e) { console.warn('save failed', e); }
    sightings.push(s);
    const e = session.get(s.bird) || { bird: s.bird, count: 0, best: s, last: 0 };
    e.count++; e.last = s.ts; e.flash = true;
    if (s.score >= e.best.score) e.best = s;
    session.set(s.bird, e);
    renderSession();
    if (lifer) celebrate(s.bird);
  }
  latest = { s, wav };
  renderLatest();
}

function setStatus(text, on) {
  const st = $('#status');
  st.textContent = text;
  st.classList.toggle('on', !!on);
}

async function startListening() {
  if (listener) return;
  const btn = $('#btn-listen');
  try {
    setStatus('Asking for the microphone…');
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
    const L = new Listener(handleCall, lvl => {
      const db = 20 * Math.log10(lvl + 1e-9);
      $('#meter-fill').style.width = Math.max(0, Math.min(100, (db + 70) * 1.6)) + '%';
    });
    await L.start(settings.sensitivity);
    listener = L;
    btn.setAttribute('aria-pressed', 'true');
    btn.querySelector('.label').textContent = 'Stop';
    $('#spec-hint').classList.add('hide');
    spec.clear();
    setStatus('Learning the room’s background noise…', true);
    const loop = () => {
      if (!listener) return;
      if (listener.ready) {
        spec.update(listener.analyzer);
        const cur = listener.analyzer.current();
        setStatus(cur ? 'Hearing a call…' : 'Listening', true);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    store.persist();
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  } catch (e) {
    console.error(e);
    listener = null;
    setStatus('Not listening');
    toast(e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in Settings › Safari › Microphone.' : 'Couldn’t start the microphone.');
  }
}

async function stopListening() {
  if (!listener) return;
  const L = listener;
  listener = null;
  cancelAnimationFrame(raf);
  if (L.ready) {
    const ev = L.analyzer.flush();
    if (ev) await handleCall(ev, L.analyzer);
  }
  await L.stop();
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
  const btn = $('#btn-listen');
  btn.setAttribute('aria-pressed', 'false');
  btn.querySelector('.label').textContent = 'Start listening';
  $('#meter-fill').style.width = '0';
  setStatus('Not listening');
}

// ---------- boot ----------
function buildFreqAxis() {
  $('#freq-axis').innerHTML = [500, 1000, 2000, 4000, 8000].map(f => {
    const y = (yOfFreq(f) * 100).toFixed(1);
    return `<i style="top:${y}%"></i><span style="top:${y}%">${f >= 1000 ? f / 1000 + 'k' : f}</span>`;
  }).join('');
}

async function init() {
  spec = new LiveSpectrogram($('#spec'), $('#spec-overlay'));
  buildFreqAxis();
  renderNames();
  try {
    DB = await (await fetch('data/birds.json')).json();
  } catch {
    setStatus('Couldn’t load the bird data. Check your connection and reload.');
    return;
  }
  for (const b of DB.birds) BIRDS[b.id] = b;
  try { sightings = (await store.allSightings()).filter(s => BIRDS[s.bird]); } catch { sightings = []; }
  renderSession();

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-view],[data-sighting],[data-bird],[data-act],[data-close]');
    if (!t) return;
    if (t.dataset.close !== undefined) return closeSheet();
    if (t.dataset.view) return showView(t.dataset.view);
    if (t.dataset.sighting) return openSighting(t.dataset.sighting);
    if (t.dataset.bird) return openBird(t.dataset.bird);
    if (t.dataset.act === 'play-latest') return playLatest();
  });
  $('#btn-listen').onclick = () => (listener ? stopListening() : startListening());
  $('#btn-settings').onclick = openSettings;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && listener) stopListening(); });
  if (!navigator.mediaDevices?.getUserMedia) setStatus('This browser can’t use the microphone here (needs https).');

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Debug/test hook: feed a 24 kHz Float32Array through the live pipeline.
  window.fledglingTest = async samples => {
    const an = new Analyzer({ onDb: settings.sensitivity });
    an.seedNoise(samples.subarray(0, Math.min(samples.length, SR * 2)));
    const out = [];
    for (let i = 0; i < samples.length; i += 4096) for (const ev of an.push(samples.subarray(i, i + 4096))) { await handleCall(ev, an); out.push(latest?.s); }
    const fl = an.flush();
    if (fl) { await handleCall(fl, an); out.push(latest?.s); }
    return out;
  };
}

init();
