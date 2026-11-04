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
//
// NOTE on "BookTitle: Series, Book N" titles (e.g. Dungeon Crawler
// Carl): the text before ", Book N" is NOT always the series — it is
// often "book title: series". detectSeriesFromTitle alone cannot tell
// "A Parade of Horribles: Dungeon Crawler Carl" (series = the part
// after the colon) from "Star Wars: A New Hope" (series = the part
// before it), so it returns the full prefix here and groupBySeries()
// resolves the colon case by cross-book sharing (see below): a
// segment after the colon that is shared by 2+ books is the series.
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

// Publication date: metadata.date may be a year ("1998"), a full date
// ("1998-03-15"), or empty/malformed. Extract the first plausible
// 4-digit year; anything else is null (sorts last, never crashes).
export function parsePublicationYear(raw) {
  if (raw === null || raw === undefined) return null
  const m = String(raw).match(/(\d{4})/)
  if (!m) return null
  const y = parseInt(m[1], 10)
  return (y >= 1000 && y <= 2999) ? y : null
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
  if (mode === 'date') {
    // Publication date, newest first; books with no usable date last
    // (ties fall back to title so the order is stable).
    return list.sort((a, b) => {
      const ya = parsePublicationYear(a.metadata.date)
      const yb = parsePublicationYear(b.metadata.date)
      if (ya === null && yb === null) return byTitle(a, b)
      if (ya === null) return 1
      if (yb === null) return -1
      if (yb !== ya) return yb - ya
      return byTitle(a, b)
    })
  }
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
//
// Two grouping fixes live here, not in detectSeriesFromTitle:
//  1. Colon titles: for a title-parsed (not metadata) series whose
//     name contains ":", the segment after the last colon is the
//     series ONLY if 2+ books share that exact segment — e.g. every
//     Dungeon Crawler Carl book ends "...: Dungeon Crawler Carl,
//     Book N", so they all share "Dungeon Crawler Carl" and group
//     under it. A lone "Series: BookTitle, Book N" keeps its full
//     prefix, so it is no worse off than before.
//  2. Case/punctuation variants of the same series must not split:
//     the group key is normalized (lowercase, collapsed whitespace,
//     punctuation stripped, leading "The " dropped), so "Red rising"
//     and "Red Rising" land in one group. The displayed name is the
//     most frequent exact form in the group (title-cased form wins
//     ties), so the group shows "Red Rising", not "Red rising".
function normalizeSeriesKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^the\s+/, '').replace(/[^\w\s]/g, '').trim()
}
function afterColonSegment(name) {
  const parts = name.split(/[:—–-]/).map((p) => p.trim()).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1] : null
}
function pickDisplayName(forms) {
  const counts = new Map()
  for (const f of forms) counts.set(f, (counts.get(f) || 0) + 1)
  const titleCased = (f) => f.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).length
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (titleCased(b[0]) - titleCased(a[0])) || a[0].localeCompare(b[0]))[0][0]
}
export function groupBySeries(books) {
  const resolved = books.map((book) => ({ book, s: getSeries(book) }))
  // Colon resolution: count shared after-colon segments among
  // title/filename-parsed series only (metadata series is authoritative).
  const segmentCounts = new Map()
  for (const { s } of resolved) {
    if (s.source === 'metadata' || !s.name) continue
    const seg = afterColonSegment(s.name)
    if (seg && seg.length >= 2) segmentCounts.set(normalizeSeriesKey(seg), (segmentCounts.get(normalizeSeriesKey(seg)) || 0) + 1)
  }
  for (const entry of resolved) {
    if (entry.s.source === 'metadata' || !entry.s.name) continue
    const seg = afterColonSegment(entry.s.name)
    if (seg && seg.length >= 2 && (segmentCounts.get(normalizeSeriesKey(seg)) || 0) >= 2) {
      entry.s = { ...entry.s, name: seg }
    }
  }
  const groups = new Map()
  const standalone = []
  for (const { book, s } of resolved) {
    if (!s.name) {
      standalone.push(book)
      continue
    }
    const key = `series:${normalizeSeriesKey(s.name)}`
    if (!groups.has(key)) groups.set(key, { forms: [], books: [] })
    groups.get(key).forms.push(s.name.trim())
    groups.get(key).books.push(book)
  }
  const out = []
  for (const [key, g] of groups) {
    const sorted = sortBooks(g.books, 'series')
    // sortBooks compares getSeries() names, which for colon-titled
    // books still differ per book — so order the group by series
    // index here (nulls last), which is what a series screen means.
    if (sorted.some((b) => getSeries(b).index !== null)) {
      sorted.sort((a, b) => {
        const ia = getSeries(a).index, ib = getSeries(b).index
        if (ia === null && ib === null) return 0
        if (ia === null) return 1
        if (ib === null) return -1
        return ia - ib
      })
    }
    const indices = sorted.map((b) => getSeries(b).index).filter((n) => n !== null && Number.isInteger(n))
    const gaps = []
    if (indices.length >= 2) {
      const min = Math.min(...indices)
      const max = Math.max(...indices)
      for (let i = min; i <= max; i++) if (!indices.includes(i)) gaps.push(i)
    }
    out.push({ key, name: pickDisplayName(g.forms), books: sorted, gaps })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  if (standalone.length) out.push({ key: 'standalone', name: 'Standalone', books: sortBooks(standalone, 'author'), gaps: [] })
  return out
}
