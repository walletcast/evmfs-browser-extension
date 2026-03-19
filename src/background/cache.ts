const DB_NAME = 'evmfs-plugin';
const DB_VERSION = 1;
const FILE_STORE = 'files';
const META_STORE = 'meta';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

// ── Public API ──────────────────────────────────────────────────

export interface CachedFile {
  key: string;
  data: ArrayBuffer;
  mime: string;
  timestamp: number;
}

export interface CachedSiteFile {
  key: string;
  path: string;
  cid: string;
  data: ArrayBuffer;
  mime: string;
  timestamp: number;
}

/** Cache raw file data by CID */
export async function cacheFile(cid: string, data: Uint8Array, mime: string): Promise<void> {
  await dbPut(FILE_STORE, {
    key: `file:${cid}`,
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    mime,
    timestamp: Date.now(),
  });
}

/** Get cached raw file by CID */
export async function getCachedFile(cid: string): Promise<CachedFile | undefined> {
  return dbGet<CachedFile>(FILE_STORE, `file:${cid}`);
}

/** Cache a site file (from ZIP extraction) */
export async function cacheSiteFile(cid: string, path: string, data: ArrayBuffer, mime: string): Promise<void> {
  await dbPut(FILE_STORE, {
    key: `site:${cid}/${path}`,
    path,
    cid,
    data,
    mime,
    timestamp: Date.now(),
  } as CachedSiteFile);
}

/** Get a cached site file */
export async function getCachedSiteFile(cid: string, path: string): Promise<CachedSiteFile | undefined> {
  return dbGet<CachedSiteFile>(FILE_STORE, `site:${cid}/${path}`);
}

/** Cache name→CID mapping with TTL */
export async function cacheAlias(name: string, cid: string, chainId: number): Promise<void> {
  await dbPut(META_STORE, {
    key: `alias:${name}`,
    cid,
    chainId,
    timestamp: Date.now(),
  });
}

/** Get cached alias (returns null if expired, TTL = 5 minutes) */
export async function getCachedAlias(name: string): Promise<{ cid: string; chainId: number } | null> {
  const entry = await dbGet<{ cid: string; chainId: number; timestamp: number }>(META_STORE, `alias:${name}`);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > 5 * 60 * 1000) return null;
  return { cid: entry.cid, chainId: entry.chainId };
}
