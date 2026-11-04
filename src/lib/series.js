// Series detection and sorting.
//
// Sources, in priority order:
//   1. OPF metadata (calibre:series / series + series_index) — most reliable.
//   2. Title patterns: "Name #2", "Name (Book 2)", "Book 2 of Name",
//      "Name, Book 2", and "Name — Book 2".
//   3. Filename patterns, same shapes as (2).
// A series index is kept as a number when it parses cleanly, so
// "Book 10" sorts after "Book 2" (string sorting would put 10 before 2).

export function parseSeriesIndex(raw) {
  if (raw === '' || raw === null || raw === undefined) return null
  const n = parseFloat(String(raw))
  return Number.isFinite(n) ? n : null
}

// Returns { name, index } or null. `name` is the series name with the
// trailing book-number part stripped.
export function detectSeriesFromTitle(title) {
  if (!title) return null
  const t = title.trim()
  const patterns = [
    // "Dune Messiah (Dune #2)" / "Name (Series #2)"
    /^(?:.+?\s*\()?\s*(.+?)\s*#\s*(\d+(?:\.\d+)?)\s*\)?\s*$/,
    // "Book 2 of The Expanse" / "Book 2: The Expanse"
    /^Book\s+(\d+(?:\.\d+)?)\s+(?:of|:)\s+(.+)$/i,
    // "The Expanse, Book 2" / "The Expanse — Book 2"
    /^(.+?)[,:\-–—]\s*Book\s+(\d+(?:\.\d+)?)$/i,
    // "The Expanse Book 2"
    /^(.+?)\s+Book\s+(\d+(?:\.\d+)?)$/i,
  ]
  // Pattern 1 is only a series hit when the # part is at the end AND
  // there is a plausible series name before it; a bare "#2" title
  // (e.g. a book literally titled "#2") is ignored by requiring a
  // name of at least 2 characters.
  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i])
    if (!m) continue
    if (i === 0) {
      // For the # pattern the groups are (name, index); for the
      // others the order differs, handled below.
      if (m[1] && m[1].trim().length >= 1 && !/^\d+$/.test(m[1].trim())) {
        return { name: m[1].trim(), index: parseFloat(m[2]) }
      }
    } else if (i === 1) {
      return { name: m[2].trim(), index: parseFloat(m[1]) }
    } else {
      return { name: m[1].trim(), index: parseFloat(m[2]) }
    }
  }
  return null
}

export function getSeries(book) {
  const meta = book.metadata || book
  if (meta.series) {
    return { name: meta.series.trim(), index: parseSeriesIndex(meta.seriesIndex), source: 'metadata' }
  }
  const fromTitle = detectSeriesFromTitle(meta.title || '')
  if (fromTitle) return { ...fromTitle, source: 'title' }
  const fromFile = detectSeriesFromTitle((book.fileName || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '))
  if (fromFile) return { ...fromFile, source: 'filename' }
  return { name: '', index: null, source: '' }
}

export function sortBooks(books, mode = 'series') {
  const list = [...books]
  const byTitle = (a, b) => (a.metadata.title || '').localeCompare(b.metadata.title || '')
  const byAuthor = (a, b) =>
    (a.metadata.author || '').localeCompare(b.metadata.author || '') || byTitle(a, b)
  if (mode === 'author') return list.sort(byAuthor)
  if (mode === 'title') return list.sort(byTitle)
  if (mode === 'recent') return list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
  // Series: series books first, grouped by series name, ordered by
  // index; standalones after, by author then title.
  return list.sort((a, b) => {
    const sa = getSeries(a)
    const sb = getSeries(b)
    if (sa.name && !sb.name) return -1
    if (!sa.name && sb.name) return 1
    if (sa.name && sb.name) {
      const cmp = sa.name.localeCompare(sb.name)
      if (cmp) return cmp
      if (sa.index !== null && sb.index !== null) return sa.index - sb.index
      if (sa.index !== null) return -1
      if (sb.index !== null) return 1
    }
    return byAuthor(a, b)
  })
}

// Group sorted books into series groups + a standalone bucket.
// A group is { key, name, books, gaps } where gaps are missing
// integer indices between the lowest and highest owned index.
export function groupBySeries(books) {
  const groups = new Map()
  const standalone = []
  for (const book of books) {
    const s = getSeries(book)
    if (!s.name) {
      standalone.push(book)
      continue
    }
    if (!groups.has(s.name)) groups.set(s.name, [])
    groups.get(s.name).push(book)
  }
  const out = []
  for (const [name, list] of groups) {
    const sorted = sortBooks(list, 'series')
    const indices = sorted.map((b) => getSeries(b).index).filter((n) => n !== null && Number.isInteger(n))
    const gaps = []
    if (indices.length >= 2) {
      const min = Math.min(...indices)
      const max = Math.max(...indices)
      for (let i = min; i <= max; i++) if (!indices.includes(i)) gaps.push(i)
    }
    out.push({ key: `series:${name}`, name, books: sorted, gaps })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  if (standalone.length) out.push({ key: 'standalone', name: 'Standalone', books: sortBooks(standalone, 'author'), gaps: [] })
  return out
}
