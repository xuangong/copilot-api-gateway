/**
 * Durable storage for pasted images.
 *
 * `localStorage` caps out around 5 MB, which one screenshot can exhaust — and
 * the quota error surfaces as a silent write failure, so the whole session
 * would stop persisting. IndexedDB has a far larger budget, so the chat history
 * keeps only each image's id and the bytes live here.
 */

const DB_NAME = "playground-images"
const STORE = "images"
const DB_VERSION = 1

/** Content-addressed, so the same screenshot pasted twice is stored once. */
export async function hashDataUrl(dataUrl: string): Promise<string> {
  const bytes = new TextEncoder().encode(dataUrl)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  const hex = [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `img_${hex}`
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** Stores the bytes and returns the id to reference them by. */
export async function putImage(dataUrl: string): Promise<string> {
  const id = await hashDataUrl(dataUrl)
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).put(dataUrl, id)
    await done(tx)
  } finally {
    db.close()
  }
  return id
}

/** Missing ids are simply absent from the result — the caller renders a fallback. */
export async function getImages(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, "readonly")
    const store = tx.objectStore(STORE)
    for (const id of ids) {
      const req = store.get(id)
      req.onsuccess = () => {
        if (typeof req.result === "string") out.set(id, req.result)
      }
    }
    await done(tx)
  } finally {
    db.close()
  }
  return out
}

/** Drops everything the history no longer references, so the store stays bounded. */
export async function pruneImages(keep: string[]): Promise<void> {
  const live = new Set(keep)
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    const req = store.getAllKeys()
    req.onsuccess = () => {
      for (const key of req.result) {
        if (typeof key === "string" && !live.has(key)) store.delete(key)
      }
    }
    await done(tx)
  } finally {
    db.close()
  }
}
