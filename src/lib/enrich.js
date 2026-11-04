// Metadata enrichment — best-effort, with a strict confidence split.
//
// For each book we only propose fixes for fields that are currently
// missing/empty. Open Library is tried first (ISBN, then title+author),
// Google Books second.
//
// Confidence — this is the part the auto-apply toggle depends on, so
// it is deliberately strict. A candidate is HIGH confidence only when:
//   * it was matched by ISBN to the same edition, OR
//   * the book already has a title AND an author, and the search
//     returned exactly one result whose title AND author match the
//     book's title and author exactly (case/punctuation-insensitive).
// Everything else is UNCERTAIN: first-search-result only, fuzzy
// title/author, multiple candidates, or a cover that could belong
// to a different edition. Uncertain proposals are NEVER auto-applied.
//
// One extra guard, even for high-confidence matches: a cover found
// by title/author search (not by ISBN) is treated as uncertain, even
// when the other fields are high confidence. Work-level covers can
// belong to a different edition, so the cover always goes to review
// unless it came from an ISBN match to the same edition.
//
// Series is deliberately NOT auto-proposed from these sources:
// Open Library / Google Books series data is inconsistent, and a
// wrong series would silently mis-sort the book. Series stays
// manual-edit only (see README).
//
// Cover handling: proposals carry a coverUrl. The UI fetches that URL
// to a data URL only when a fix is applied (auto or manual), so
// merely reviewing proposals does not download covers.

const MISSING = (v) => !v || (typeof v === 'string' && !v.trim())

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k]) return obj[k]
  return ''
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normIsbn(s) {
  return String(s || '').replace(/[^0-9xX]/g, '').toUpperCase()
}

function cleanDescription(d) {
  if (!d) return ''
  if (typeof d === 'string') return d.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
  if (typeof d === 'object' && d.value) return cleanDescription(d.value)
  return ''
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// Split a candidate's fields into auto-eligible and review-only parts.
// `autoOk` means the whole match is high confidence. Even then, a
// non-ISBN cover is review-only (see header comment).
function splitCandidate(candidate, isbnMatch) {
  if (!candidate) return null
  if (candidate.confidenceLevel !== 'high') {
    return { ...candidate, autoProposals: {}, reviewProposals: { ...candidate.fields } }
  }
  const autoProposals = {}
  const reviewProposals = {}
  for (const [field, value] of Object.entries(candidate.fields)) {
    if (field === 'coverUrl' && !isbnMatch) reviewProposals[field] = value
    else autoProposals[field] = value
  }
  return { ...candidate, autoProposals, reviewProposals }
}

async function fromOpenLibrary(book) {
  const meta = book.metadata
  // 1. ISBN lookup — same edition by definition of the ISBN key.
  if (meta.isbn) {
    const data = await fetchJson(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(meta.isbn)}&format=json&jscmd=data`,
    )
    const entry = data && data[`ISBN:${meta.isbn}`]
    if (entry) {
      return splitCandidate({
        source: 'Open Library (ISBN match)',
        confidence: 'High — matched by ISBN',
        confidenceLevel: 'high',
        confidenceReason: 'Matched by ISBN to the same edition',
        fields: {
          title: entry.title || '',
          author: (entry.authors || []).map((a) => a.name).join(', '),
          publisher: (entry.publishers || []).map((p) => p.name).join(', '),
          date: entry.publish_date || '',
          description: '',
          coverUrl: entry.cover ? entry.cover.large || entry.cover.medium || entry.cover.small : '',
        },
      }, true)
    }
  }
  // 2. Title + author search — high only on an exact, unambiguous match.
  if (meta.title) {
    const q = new URLSearchParams({ title: meta.title })
    if (meta.author) q.set('author', meta.author)
    q.set('limit', '10')
    const search = await fetchJson(`https://openlibrary.org/search.json?${q}`)
    const docs = (search && search.docs) || []
    const wantTitle = norm(meta.title)
    const wantAuthor = norm(meta.author)
    const exact = wantTitle && wantAuthor
      ? docs.filter((d) => norm(d.title) === wantTitle && (d.author_name || []).some((a) => norm(a) === wantAuthor))
      : []
    const doc = exact.length === 1 ? exact[0] : docs[0]
    if (doc) {
      const high = exact.length === 1
      let description = ''
      let coverUrl = ''
      if (doc.cover_i) coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
      if (doc.key) {
        const work = await fetchJson(`https://openlibrary.org${doc.key}.json`)
        if (work) description = cleanDescription(work.description)
      }
      return splitCandidate({
        source: 'Open Library (title/author search)',
        confidence: high
          ? 'High — exact title and author, single match'
          : 'Medium — first search result, please check it',
        confidenceLevel: high ? 'high' : 'uncertain',
        confidenceReason: high
          ? 'Exact title and author match, single unambiguous result'
          : (exact.length > 1
            ? 'Multiple candidates matched the title and author — please check it'
            : 'First search result only — title and/or author did not match exactly'),
        fields: {
          title: doc.title || '',
          author: (doc.author_name || []).join(', '),
          publisher: (doc.publisher || [])[0] || '',
          date: doc.first_publish_year ? String(doc.first_publish_year) : '',
          description,
          coverUrl,
        },
      }, false)
    }
  }
  return null
}

async function fromGoogleBooks(book) {
  const meta = book.metadata
  const parts = []
  const isbnQuery = !!meta.isbn
  if (meta.isbn) parts.push(`isbn:${meta.isbn}`)
  else {
    if (meta.title) parts.push(`intitle:${meta.title}`)
    if (meta.author) parts.push(`inauthor:${meta.author}`)
  }
  if (!parts.length) return null
  const data = await fetchJson(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(parts.join('+'))}&maxResults=10`,
  )
  const items = (data && data.items) || []
  if (!items.length) return null
  const wantTitle = norm(meta.title)
  const wantAuthor = norm(meta.author)
  const wantIsbn = normIsbn(meta.isbn)
  // ISBN query: high only if the returned volume actually carries
  // that ISBN in its industry identifiers (same edition).
  let item = items[0]
  let isbnMatch = false
  if (isbnQuery && wantIsbn) {
    const found = items.find((it) => (it.volumeInfo?.industryIdentifiers || [])
      .some((id) => normIsbn(id.identifier) === wantIsbn))
    if (found) { item = found; isbnMatch = true }
  }
  const exact = (!isbnQuery && wantTitle && wantAuthor)
    ? items.filter((it) => {
      const info = it.volumeInfo || {}
      return norm(info.title) === wantTitle && (info.authors || []).some((a) => norm(a) === wantAuthor)
    })
    : []
  const high = isbnMatch || exact.length === 1
  if (exact.length === 1) item = exact[0]
  const info = item.volumeInfo || {}
  return splitCandidate({
    source: 'Google Books',
    confidence: high
      ? (isbnMatch ? 'High — matched by ISBN' : 'High — exact title and author, single match')
      : 'Medium — first search result, please check it',
    confidenceLevel: high ? 'high' : 'uncertain',
    confidenceReason: high
      ? (isbnMatch
        ? 'Matched by ISBN to the same edition'
        : 'Exact title and author match, single unambiguous result')
      : (exact.length > 1
        ? 'Multiple candidates matched the title and author — please check it'
        : 'First search result only — title and/or author did not match exactly'),
    fields: {
      title: info.title || '',
      author: (info.authors || []).join(', '),
      publisher: info.publisher || '',
      date: info.publishedDate || '',
      description: cleanDescription(info.description),
      coverUrl: info.imageLinks ? info.imageLinks.large || info.imageLinks.thumbnail || '' : '',
    },
  }, isbnMatch)
}

// Returns null when the book is already complete or no source matched,
// otherwise { bookId, source, confidence, confidenceLevel,
// confidenceReason, proposals, autoProposals, reviewProposals }.
// `proposals` is the full set (kept for the review UI); the two
// subsets partition it, so auto + review never overlap and nothing
// is lost when only one side is applied.
export async function enrichBook(book) {
  const meta = book.metadata
  const candidate = (await fromOpenLibrary(book)) || (await fromGoogleBooks(book))
  if (!candidate) return null
  const proposals = {}
  for (const [field, value] of Object.entries(candidate.fields)) {
    if (!value) continue
    if (field === 'coverUrl') {
      if (!meta.coverDataUrl) proposals.coverUrl = value
      continue
    }
    if (MISSING(meta[field])) proposals[field] = value
  }
  if (!Object.keys(proposals).length) return null
  const autoProposals = {}
  const reviewProposals = {}
  for (const [field, value] of Object.entries(proposals)) {
    if (candidate.autoProposals && field in candidate.autoProposals) autoProposals[field] = value
    else reviewProposals[field] = value
  }
  return {
    bookId: book.id,
    source: candidate.source,
    confidence: candidate.confidence,
    confidenceLevel: candidate.confidenceLevel,
    confidenceReason: candidate.confidenceReason,
    proposals,
    autoProposals,
    reviewProposals,
  }
}
