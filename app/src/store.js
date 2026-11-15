// Session log and small settings, kept in IndexedDB on this device only.
// If the browser refuses storage (for example inside a preview frame) the
// store falls back to memory so the page still works, and says so.

const DB_NAME = 'stabilizeShell';
const errText = (e) => String((e && e.message) || e);

function open() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('could not open storage'));
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('storage transaction aborted'));
  });
}

export async function createStore() {
  let db = null;
  let problem = null;
  const mem = { sessions: new Map(), kv: new Map() };
  try { db = await open(); } catch (e) { problem = errText(e); }

  const safe = async (fn, fallback) => {
    if (!db) return fallback();
    try { return await fn(); } catch (e) { problem = errText(e); return fallback(); }
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));

  return {
    get persistent() { return !!db; },
    get problem() { return problem; },
    async sessions() {
      const all = await safe(() => tx(db, 'sessions', 'readonly', (s) => s.getAll()), () => Array.from(mem.sessions.values()));
      return (all || []).sort((a, b) => a.startedAt - b.startedAt);
    },
    async saveSession(rec) {
      const copy = clone(rec);
      mem.sessions.set(copy.id, copy);
      await safe(() => tx(db, 'sessions', 'readwrite', (s) => s.put(copy)), () => undefined);
    },
    async clearSessions() {
      mem.sessions.clear();
      await safe(() => tx(db, 'sessions', 'readwrite', (s) => s.clear()), () => undefined);
    },
    async get(key) {
      return safe(() => tx(db, 'kv', 'readonly', (s) => s.get(key)), () => mem.kv.get(key));
    },
    async set(key, value) {
      mem.kv.set(key, value);
      await safe(() => tx(db, 'kv', 'readwrite', (s) => s.put(clone(value), key)), () => undefined);
    },
    async del(key) {
      mem.kv.delete(key);
      await safe(() => tx(db, 'kv', 'readwrite', (s) => s.delete(key)), () => undefined);
    },
    /** Ask the browser not to evict this data. Never waits longer than two seconds. */
    async requestPersistence() {
      if (!navigator.storage || !navigator.storage.persist) return 'not offered';
      try {
        return await Promise.race([
          navigator.storage.persist().then((ok) => (ok ? 'granted' : 'declined')),
          new Promise((resolve) => setTimeout(() => resolve('no reply'), 2000)),
        ]);
      } catch (e) {
        return 'error: ' + errText(e);
      }
    },
  };
}
