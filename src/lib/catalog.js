// ShelfSort catalog export / import — the "Muse can sort my books" route.
// This is NOT a backdoor: nothing here opens a port, a socket, or a
// persistent connection. Export is a file the owner chooses to share;
// import only applies a file the owner chooses to load, and only to
// whitelisted metadata fields. Book files, covers, progress, cloud
// credentials and R2 keys are never in a catalog file.
export const CATALOG_FIELDS = ['title', 'author', 'publisher', 'date', 'isbn', 'description', 'series', 'seriesIndex']

export function buildCatalog(books) {
  return {
    app: 'ShelfSort',
    catalogVersion: 1,
    exportedAt: new Date().toISOString(),
    books: (books || []).map((b) => ({
      id: b.id,
      fileName: b.fileName || '',
      format: b.format || '',
      title: b.metadata?.title || '',
      author: b.metadata?.author || '',
      publisher: b.metadata?.publisher || '',
      date: b.metadata?.date || '',
      isbn: b.metadata?.isbn || '',
      description: b.metadata?.description || '',
      series: b.metadata?.series || '',
      seriesIndex: b.metadata?.seriesIndex ?? null,
      hasCover: !!(b.metadata?.coverDataUrl || b.metadata?.coverUrl),
      titleFromFilename: !!b.titleFromFilename,
    })),
  }
}

export function parseCatalog(text) {
  let data
  try { data = JSON.parse(text) } catch { throw new Error('That file is not valid JSON.') }
  if (!data || data.app !== 'ShelfSort' || !Array.isArray(data.books)) {
    throw new Error('That file is not a ShelfSort catalog (expected app "ShelfSort" and a books list).')
  }
  return data.books.filter((e) => e && typeof e === 'object')
}

function normalizeValue(field, value) {
  if (field === 'seriesIndex') {
    if (value === '' || value === null || value === undefined) return null
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

export function computeCatalogChanges(books, entries) {
  const byId = new Map((books || []).map((b) => [b.id, b]))
  const byFileFormat = new Map()
  const byFile = new Map()
  for (const b of books || []) {
    if (b.fileName) {
      byFileFormat.set(`${b.format}::${b.fileName}`, b)
      if (!byFile.has(b.fileName)) byFile.set(b.fileName, b)
      else byFile.set(b.fileName, null) // ambiguous filename, id/file+format only
    }
  }
  const changes = []
  const unmatched = []
  for (const entry of entries) {
    const book = (entry.id && byId.get(entry.id))
      || (entry.fileName && byFileFormat.get(`${entry.format}::${entry.fileName}`))
      || (entry.fileName && byFile.get(entry.fileName))
    if (!book) { unmatched.push(entry); continue }
    const diffs = []
    for (const field of CATALOG_FIELDS) {
      if (!(field in entry)) continue
      const next = normalizeValue(field, entry[field])
      if (next === undefined) continue
      const current = field === 'seriesIndex' ? (book.metadata?.seriesIndex ?? null) : (book.metadata?.[field] || '')
      if (next !== current) diffs.push({ field, from: current, to: next })
    }
    if (diffs.length) changes.push({ bookId: book.id, fileName: book.fileName || '', title: book.metadata?.title || '', diffs })
  }
  return { changes, unmatched, unchanged: entries.length - changes.length - unmatched.length }
}
