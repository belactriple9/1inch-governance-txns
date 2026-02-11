/**
 * db.js — IndexedDB wrapper using idb-like pattern (no dependencies)
 *
 * Stores: settings, proposals, questions_state, answers, txBundles
 */

const DB_NAME = "GovernanceCommandCenter";
const DB_VERSION = 2;

let _db = null;

/**
 * Open / create the IndexedDB database.
 */
export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }

      let proposalsStore;
      if (!db.objectStoreNames.contains("proposals")) {
        proposalsStore = db.createObjectStore("proposals", { keyPath: "questionId" });
      } else {
        proposalsStore = e.target.transaction.objectStore("proposals");
      }
      if (!proposalsStore.indexNames.contains("proposalId")) {
        proposalsStore.createIndex("proposalId", "proposalId", { unique: false });
      }
      if (!proposalsStore.indexNames.contains("createdBlock")) {
        proposalsStore.createIndex("createdBlock", "createdBlock", { unique: false });
      }

      if (!db.objectStoreNames.contains("questions_state")) {
        db.createObjectStore("questions_state", { keyPath: "questionId" });
      }

      let answersStore;
      if (!db.objectStoreNames.contains("answers")) {
        answersStore = db.createObjectStore("answers", { keyPath: "id" }); // id = `${questionId}:${block}:${txIndex}:${logIndex}`
      } else {
        answersStore = e.target.transaction.objectStore("answers");
      }
      if (!answersStore.indexNames.contains("questionId")) {
        answersStore.createIndex("questionId", "questionId", { unique: false });
      }
      if (!answersStore.indexNames.contains("blockNumber")) {
        answersStore.createIndex("blockNumber", "blockNumber", { unique: false });
      }

      if (!db.objectStoreNames.contains("txBundles")) {
        db.createObjectStore("txBundles", { keyPath: "proposalId" });
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      resolve(_db);
    };

    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Generic get from a store.
 */
export async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Generic put to a store.
 */
export async function dbPut(storeName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get all records from a store.
 */
export async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get the first record by an index key from a store.
 */
export async function dbGetByIndex(storeName, indexName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const req = index.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get all records by an index key from a store.
 */
export async function dbGetAllByIndex(storeName, indexName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const req = index.getAll(IDBKeyRange.only(key));
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete a record from a store.
 */
export async function dbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Clear all data in a store.
 */
export async function dbClear(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Clear the entire DB (all stores).
 */
export async function dbClearAll() {
  const db = await openDB();
  const storeNames = ["settings", "proposals", "questions_state", "answers", "txBundles"];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, "readwrite");
    for (const name of storeNames) {
      tx.objectStore(name).clear();
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Export entire DB as a JSON object.
 */
export async function exportDB() {
  const storeNames = ["settings", "proposals", "questions_state", "answers", "txBundles"];
  const dump = {};
  for (const name of storeNames) {
    dump[name] = await dbGetAll(name);
  }
  return dump;
}

/**
 * Import from a JSON dump (replaces current data).
 */
export async function importDB(dump) {
  const storeNames = ["settings", "proposals", "questions_state", "answers", "txBundles"];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, "readwrite");
    for (const name of storeNames) {
      const store = tx.objectStore(name);
      store.clear();
      if (dump[name]) {
        for (const item of dump[name]) {
          store.put(item);
        }
      }
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Convenience settings helpers ----

export async function getSetting(key) {
  const rec = await dbGet("settings", key);
  return rec ? rec.value : null;
}

export async function setSetting(key, value) {
  return dbPut("settings", { key, value });
}
