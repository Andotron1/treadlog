// Tiny IndexedDB wrapper for run storage.
const DB_NAME = 'treadlog';
const STORE = 'runs';

let dbPromise;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const putRun = (run) => tx('readwrite', (s) => s.put(run));
export const deleteRun = (id) => tx('readwrite', (s) => s.delete(id));
export const allRuns = async () => (await tx('readonly', (s) => s.getAll())).sort((a, b) => b.start - a.start);
export async function putMany(runs) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    runs.forEach((r) => t.objectStore(STORE).put(r));
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
export async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
