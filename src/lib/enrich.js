// Metadata enrichment — best-effort, never silent.
//
// For each book we only propose fixes for fields that are currently
// missing/empty. Open Library is tried first (ISBN, then title+author),
// Google Books second. Every proposal carries a source label and a
// confidence note so the Fix Review screen can show why it was chosen.
// The caller decides whether to apply a proposal; nothing here writes
// to the library on its own.
//
// Cover handling: proposals carry a coverUrl. The UI fetches that URL
// to a data URL only when the user applies the fix, so merely
// reviewing proposals does not download covers.

const MISSING = (v) => !v || (typeof v === 'string' && !v.trim())

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k]) return obj[k]
  return ''
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

async function fromOpenLibrary(book) {
  const meta = book.metadata
  // 1. ISBN lookup — highest confidence.
  if (meta.isbn) {
    const data = await fetchJson(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(meta.isbn)}&format=json&jscmd=data`,
    )
    const entry = data && data[`ISBN:${meta.isbn}`]
    if (entry) {
      return {
        source: 'Open Library (ISBN match)',
        confidence: 'High — matched by ISBN',
        fields: {
          title: entry.title || '',
          author: (entry.authors || []).map((a) => a.name).join(', '),
          publisher: (entry.publishers || []).map((p) => p.name).join(', '),
          date: entry.publish_date || '',
          description: '',
          coverUrl: entry.cover ? entry.cover.large || entry.cover.medium || entry.cover.small : '',
        },
      }
    }
  }
  // 2. Title + author search.
  if (meta.title) {
    const q = new URLSearchParams({ title: meta.title })
    if (meta.author) q.set('author', meta.author)
    q.set('limit', '5')
    const search = await fetchJson(`https://openlibrary.org/search.json?${q}`)
    const doc = search && search.docs && search.docs[0]
    if (doc) {
      let description = ''
      let coverUrl = ''
      if (doc.cover_i) coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
      // A work lookup gives a fuller description when available.
      if (doc.key) {
        const work = await fetchJson(`https://openlibrary.org${doc.key}.json`)
        if (work) description = cleanDescription(work.description)
      }
      return {
        source: 'Open Library (title/author search)',
        confidence: 'Medium — first search result, please check it',
        fields: {
          title: doc.title || '',
          author: (doc.author_name || []).join(', '),
          publisher: (doc.publisher || [])[0] || '',
          date: doc.first_publish_year ? String(doc.first_publish_year) : '',
          description,
          coverUrl,
        },
      }
    }
  }
  return null
}

async function fromGoogleBooks(book) {
  const meta = book.metadata
  const parts = []
  if (meta.isbn) parts.push(`isbn:${meta.isbn}`)
  else {
    if (meta.title) parts.push(`intitle:${meta.title}`)
    if (meta.author) parts.push(`inauthor:${meta.author}`)
  }
  if (!parts.length) return null
  const data = await fetchJson(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(parts.join('+'))}&maxResults=5`,
  )
  const item = data && data.items && data.items[0]
  if (!item) return null
  const info = item.volumeInfo || {}
  return {
    source: 'Google Books',
    confidence: 'Medium — first search result, please check it',
    fields: {
      title: info.title || '',
      author: (info.authors || []).join(', '),
      publisher: info.publisher || '',
      date: info.publishedDate || '',
      description: cleanDescription(info.description),
      coverUrl: info.imageLinks ? info.imageLinks.large || info.imageLinks.thumbnail || '' : '',
    },
  }
}

// Returns null when the book is already complete or no source matched,
// otherwise { source, confidence, proposals } where proposals maps a
// field name to a proposed value, limited to fields that are missing.
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
  // Series is deliberately NOT auto-proposed from these sources:
  // Open Library / Google Books series data is inconsistent, and a
  // wrong series would silently mis-sort the book. Series stays
  // manual-edit only (see README).
  if (!Object.keys(proposals).length) return null
  return { bookId: book.id, source: candidate.source, confidence: candidate.confidence, proposals }
}
