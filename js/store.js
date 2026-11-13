// Tiny IndexedDB wrapper. Everything stays on this device.
const DB_NAME = 'fledgling';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const s = db.createObjectStore('sightings', { keyPath: 'id', autoIncrement: true });
      s.createIndex('bird', 'bird');
      s.createIndex('ts', 'ts');
      db.createObjectStore('clips', { keyPath: 'id' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function addSighting(s, wav) {
  return tx(['sightings', 'clips'], 'readwrite', async t => {
    const id = await reqP(t.objectStore('sightings').add(s));
    if (wav) t.objectStore('clips').put({ id, wav });
    return id;
  });
}

export function allSightings() {
  return tx(['sightings'], 'readonly', t => reqP(t.objectStore('sightings').getAll()));
}

export function getClip(id) {
  return tx(['clips'], 'readonly', t => reqP(t.objectStore('clips').get(id))).then(r => r && r.wav);
}

export function deleteSighting(id) {
  return tx(['sightings', 'clips'], 'readwrite', t => {
    t.objectStore('sightings').delete(id);
    t.objectStore('clips').delete(id);
  });
}

export function clearAll() {
  return tx(['sightings', 'clips'], 'readwrite', t => {
    t.objectStore('sightings').clear();
    t.objectStore('clips').clear();
  });
}

export async function persist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
