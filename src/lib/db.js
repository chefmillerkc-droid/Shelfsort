// IndexedDB wrapper — no extra dependency.
// One object store, "books", keyed by id. Each record holds the EPUB
// ArrayBuffer itself, so the library survives a reload and the reader can
// re-parse chapters on demand without re-uploading the file.
const DB_NAME = 'shelfsort'
const DB_VERSION = 1
const STORE = 'books'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE)
}

export async function getAllBooks() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

export async function putBook(book) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put(book)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function deleteBook(id) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function clearLibrary() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').clear()
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
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
