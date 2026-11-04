// Read-along matching: EPUB + M4B for the same book.
// Chapter-level sync ONLY — no word-level sync is claimed, because
// ordinary EPUB + M4B pairs do not contain word timing data.
// If a pair ever did (e.g. SMIL/media-overlay EPUBs), that would
// be a separate feature, not something to fake from chapter lists.

export function normalizeTitle(raw) {
  return (raw || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(unabridged|audiobook|audio book|part \d+|volume \d+)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function baseTitle(raw) {
  // Strip trailing series numbering for matching: "Dune #2" -> "dune"
  return normalizeTitle(raw)
    .replace(/\s+#\s*\d+(\.\d+)?$/, '')
    .replace(/\s+book\s+\d+(\.\d+)?$/, '')
    .trim()
}

function tokens(s) {
  return new Set(normalizeTitle(s).split(' ').filter(Boolean))
}

function tokenOverlap(a, b) {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / Math.max(ta.size, tb.size)
}

export function matchScore(epubBook, audioBook) {
  const et = normalizeTitle(epubBook.metadata.title)
  const at = normalizeTitle(audioBook.metadata.title)
  const eb = baseTitle(epubBook.metadata.title)
  const ab = baseTitle(audioBook.metadata.title)
  let score = 0
  if (et && et === at) score = 100
  else if (eb && eb === ab) score = 95
  else if (eb && (ab.includes(eb) || eb.includes(ab))) score = 85
  else score = Math.round(tokenOverlap(et, at) * 80)
  const ea = normalizeTitle(epubBook.metadata.author)
  const aa = normalizeTitle(audioBook.metadata.author)
  if (ea && aa) {
    if (ea === aa) score += 10
    else if (tokenOverlap(ea, aa) >= 0.5) score += 5
    else score -= 15
  }
  return Math.max(0, Math.min(110, score))
}

export function findAudioMatch(epubBook, allBooks) {
  const audios = allBooks.filter((b) => b.format === 'audio' && b.id !== epubBook.id)
  let best = null
  let bestScore = 0
  for (const a of audios) {
    const s = matchScore(epubBook, a)
    if (s > bestScore) { bestScore = s; best = a }
  }
  // 70 is the threshold: exact / base-title matches pass easily,
  // loose token overlap alone does not auto-link.
  return bestScore >= 70 ? { book: best, score: bestScore } : null
}

export function findEpubMatch(audioBook, allBooks) {
  const epubs = allBooks.filter((b) => b.format === 'epub' && b.id !== audioBook.id)
  let best = null
  let bestScore = 0
  for (const e of epubs) {
    const s = matchScore(e, audioBook)
    if (s > bestScore) { bestScore = s; best = e }
  }
  return bestScore >= 70 ? { book: best, score: bestScore } : null
}

// Map each EPUB chapter index -> audio chapter index.
// Strategy: title similarity first (if >= 0.4 token overlap), else
// index order clamped to the audio chapter list. With no audio
// chapters, every EPUB chapter maps to the single track (index -1).
export function mapChapters(epubChapters, audioChapters) {
  if (!audioChapters || !audioChapters.length) return epubChapters.map(() => -1)
  return epubChapters.map((ech, i) => {
    let best = -1
    let bestScore = 0
    audioChapters.forEach((ach, j) => {
      const s = tokenOverlap(ech.title || '', ach.title || '')
      if (s > bestScore) { bestScore = s; best = j }
    })
    if (bestScore >= 0.4) return best
    return Math.min(i, audioChapters.length - 1)
  })
}

// Given an audio time (seconds), find the audio chapter index whose
// start is the latest start <= time. Returns -1 when no chapters.
export function audioChapterAtTime(audioChapters, timeSec) {
  if (!audioChapters || !audioChapters.length) return -1
  let idx = 0
  for (let i = 0; i < audioChapters.length; i++) {
    if (audioChapters[i].start <= timeSec + 0.5) idx = i
    else break
  }
  return idx
}
