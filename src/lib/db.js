// IndexedDB wrapper — v0.4.0 split storage.
//
// v1 stored the whole file ArrayBuffer inside the same record as the
// metadata, and the app loaded EVERY file into React state on launch.
// With ~800 books that OOMs the Android WebView, crashes mid-import,
// and makes the library look empty on reopen.
//
// v2/v3 split the data:
//   'books-meta'  — metadata, cover, series, progress, links, r2Key,
//                   fileName, format, hasFile. NO file blob. Small, so
//                   loading the whole library is cheap.
//   'books-files' — id -> ArrayBuffer, loaded one book at a time, only
//                   when that book is actually opened, then released.
//
// Migration (v1 -> v2 -> v3), never losing a file:
//   1. Open at version 2: new stores are created; the old 'books'
//      store is still readable.
//   2. If 'books' exists, copy each old record into meta + files,
//      SKIPPING any id already present in 'books-meta' (so a crash
//      mid-migration, or metadata edited after a partial migration,
//      is never clobbered by re-running it). This step is idempotent.
//   3. Close, then open at version 3, whose upgrade deletes the old
//      'books' store (deleting a store is only allowed in an upgrade
//      transaction that does no data reads, hence the separate step).
//   A fresh install has no 'books' store and simply uses version 2.
//   If migration is interrupted, the next launch re-runs step 2.
const DB_NAME = 'shelfsort'
const META_STORE = 'books-meta'
const FILE_STORE = 'books-files'
const OLD_STORE = 'books'

export function splitBookRecord(record) {
  const { file, ...rest } = record || {}
  return {
    meta: { ...rest, hasFile: !!file },
    file: file || null,
  }
}

function openRaw(version, onUpgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, version)
    req.onupgradeneeded = () => {
      const db = req.result
      if (onUpgrade) onUpgrade(db)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked — close other ShelfSort tabs and reopen.'))
  })
}

function ensureStores(db) {
  if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' })
  if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE, { keyPath: 'id' })
}

function storeReq(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function getAllFrom(db, store) {
  return storeReq(db, store, 'readonly', (s) => s.getAll())
}

function getAllKeysFrom(db, store) {
  return storeReq(db, store, 'readonly', (s) => s.getAllKeys())
}

async function migrateOldStore(db) {
  const oldRecords = await getAllFrom(db, OLD_STORE)
  if (!oldRecords.length) return
  const existing = new Set(await getAllKeysFrom(db, META_STORE))
  for (const record of oldRecords) {
    if (existing.has(record.id)) continue
    const { meta, file } = splitBookRecord(record)
    await storeReq(db, META_STORE, 'readwrite', (s) => s.put(meta))
    if (file) await storeReq(db, FILE_STORE, 'readwrite', (s) => s.put({ id: record.id, file }))
    existing.add(record.id)
  }
}

let dbPromise = null

export function openDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      let db = await openRaw(2, ensureStores)
      if (db.objectStoreNames.contains(OLD_STORE)) {
        await migrateOldStore(db)
        db.close()
        db = await openRaw(3, (upgraded) => {
          ensureStores(upgraded)
          if (upgraded.objectStoreNames.contains(OLD_STORE)) upgraded.deleteObjectStore(OLD_STORE)
        })
      }
      return db
    })()
    dbPromise.catch(() => { dbPromise = null })
  }
  return dbPromise
}

function txStores(db, stores, mode) {
  return db.transaction(stores, mode)
}

// ---- Metadata-only library (the hot path: no file blobs) ------------
export async function getAllBooksMeta() {
  const db = await openDb()
  return getAllFrom(db, META_STORE)
}

export async function getBookMeta(id) {
  const db = await openDb()
  return storeReq(db, META_STORE, 'readonly', (s) => s.get(id))
}

export async function putBookMeta(book) {
  const db = await openDb()
  const { file, ...meta } = book || {}
  if (meta.hasFile === undefined) meta.hasFile = !!file
  await storeReq(db, META_STORE, 'readwrite', (s) => s.put(meta))
  return meta
}

// ---- File blobs: one book at a time, only when opened ---------------
export async function getBookFile(id) {
  const db = await openDb()
  const row = await storeReq(db, FILE_STORE, 'readonly', (s) => s.get(id))
  return row ? row.file : null
}

export async function putBookFile(id, buf) {
  const db = await openDb()
  await storeReq(db, FILE_STORE, 'readwrite', (s) => s.put({ id, file: buf }))
}

export async function deleteBookFile(id) {
  const db = await openDb()
  await storeReq(db, FILE_STORE, 'readwrite', (s) => s.delete(id))
}

// ---- Combined helpers (split internally; never load all blobs) ------
export async function putBook(book) {
  const meta = await putBookMeta(book)
  if (book && 'file' in book) {
    if (book.file) await putBookFile(book.id, book.file)
    else if (book.file === null) await deleteBookFile(book.id)
    // book.file === undefined: leave the stored file untouched.
  }
  return meta
}

export async function deleteBook(id) {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const t = txStores(db, [META_STORE, FILE_STORE], 'readwrite')
    t.objectStore(META_STORE).delete(id)
    t.objectStore(FILE_STORE).delete(id)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

export async function clearLibrary() {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const t = txStores(db, [META_STORE, FILE_STORE], 'readwrite')
    t.objectStore(META_STORE).clear()
    t.objectStore(FILE_STORE).clear()
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

// Progress (chapter index) is kept on the book record itself so it is
// backed up with the library, and mirrored to localStorage as a cheap
// fallback if IndexedDB is unavailable in a given browser.
export function saveProgressLocal(id, progress) {
  try {
    const all = JSON.parse(localStorage.getItem('shelfsort-progress') || '{}')
    all[id] = progress
    localStorage.setItem('shelfsort-progress', JSON.stringify(all))
  } catch { /* localStorage is best-effort */ }
}

export function loadProgressLocal(id) {
  try {
    return (JSON.parse(localStorage.getItem('shelfsort-progress') || '{}'))[id] || null
  } catch {
    return null
  }
}
