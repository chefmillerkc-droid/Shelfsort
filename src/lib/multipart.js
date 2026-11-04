// Multi-part audiobooks — grouping + global position math.
//
// USER'S STRUCTURE (2026-11-04): audiobook root -> author folder ->
// book folder -> part files. Example:
//   Audiobooks / Scott Lynch / The Lies of Locke Lamora / [part files]
// So a book folder IS a book. That drives the grouping rule:
//
// PRIMARY RULE: all audio files in the SAME immediate directory
// (same book folder), imported in the same batch, are ONE book, parts
// naturally sorted by filename — regardless of album tags or filename
// prefixes. The book-folder name is the title fallback and the parent
// (author) folder name is the author fallback.
//
// FALLBACK RULE (only when files arrive with NO directory info, e.g.
// a flat multi-select): group only on a shared album tag, or on a
// shared filename prefix plus a part/number suffix, with at least 2
// files. Files from DIFFERENT book folders are NEVER merged, even if
// they share an album tag — the book folder wins.
//
// METADATA RULE (when parts disagree): file tags win only where they
// AGREE across all parts; otherwise the folder-derived names win.
// Concretely: title = common title tag if every part has the same
// non-empty one, else book-folder name (or album tag / shared prefix
// in the fallback case); author = common author tag if every part
// has the same non-empty one, else author-folder name (or the common
// tag, or ''). Description/publisher/date come from the first part
// (natural order) when present — parts of one book rarely disagree
// there, and picking one file's values silently for those fields is
// documented here rather than hidden.
//
// GLOBAL POSITION: global = sum of completed parts' durations +
// position inside the current part. Seeking a global position maps
// back to (part index, offset in part). A part whose duration is
// unknown at import (MP3: no duration in tags) absorbs any seek
// past the known total — it is the first unknown span, so a seek
// into it lands there at (target − known total before it). Totals
// grow as unknown parts play and report their real duration; the UI
// must never present a partial total as final (see AudioPlayer).
//
// This module is pure (no DOM, no Capacitor, no IndexedDB) so it can
// be unit-checked in Node. The App wires it into import + playback.
//
// Single-file books are untouched by this module: a one-part book
// has parts = [that file], global position = part position, and the
// player shows no part UI at all.
export function dirOfPath(relPath) {
  if (!relPath || !relPath.includes('/')) return ''
  return relPath.slice(0, relPath.lastIndexOf('/'))
}

export function lastSegmentOfDir(dir) {
  if (!dir) return ''
  const parts = dir.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

export function parentSegmentOfDir(dir) {
  if (!dir) return ''
  const parts = dir.split('/').filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : ''
}

// "The_Lies-of Locke Lamora" -> "The Lies of Locke Lamora".
// Underscores/dots become spaces, runs collapse, ends trimmed.
// Deliberately does NOT strip numbers or "Part 1" — a folder name
// is a title, not a filename, so it is kept verbatim apart from
// separator cleanup.
export function cleanFolderName(name) {
  return String(name || '').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function naturalCompare(a, b) {
  const ax = String(a).split(/(\d+)/)
  const bx = String(b).split(/(\d+)/)
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    if (ax[i] === undefined) return -1
    if (bx[i] === undefined) return 1
    if (ax[i] === bx[i]) continue
    const an = Number(ax[i])
    const bn = Number(bx[i])
    if (!Number.isNaN(an) && !Number.isNaN(bn) && ax[i] !== '' && bx[i] !== '') return an - bn
    return ax[i] < bx[i] ? -1 : 1
  }
  return 0
}

// Strip the extension, then a trailing part/number suffix:
// "Book - Part 01", "Book 01", "Book_1", "Book 2 of 3" -> "Book".
// Returns { prefix, partNum } or null when no part suffix is found.
export function partSuffixInfo(fileName) {
  const base = String(fileName || '').replace(/\.[a-z0-9]+$/i, '').trim()
  const m = base.match(/^(.*?)[\s._-]*(?:part|pt|disc|cd|book|vol|volume)?[\s._-]*0*(\d+)(?:\s*of\s*\d+)?$/i)
  if (!m) return null
  const prefix = m[1].replace(/[\s._-]+$/, '').trim()
  if (!prefix) return null
  return { prefix, partNum: parseInt(m[2], 10) }
}

function commonNonEmpty(values) {
  const nonEmpty = values.map((v) => String(v || '').trim()).filter(Boolean)
  if (!nonEmpty.length) return ''
  const first = nonEmpty[0]
  return nonEmpty.every((v) => v === first) ? first : ''
}

// Input: parsed audio entries, each:
//   { file, dir, parsed } where parsed = { title, author, album,
//   durationSec, chapters, ... } as returned by parseByFormat's
//   metadata + extra (chapters/duration in extra for MP4, album in
//   parsed.album when present — callers pass album explicitly).
// Returns an array of groups: { entries, title, author } where
// entries are the input entries in natural filename order and
// title/author are the grouped book's metadata per the rules above.
// A group of one entry is a single-file book; callers treat it
// exactly as before (no parts array, no part UI).
export function groupAudioEntries(entries) {
  const withDir = entries.filter((e) => e.dir)
  const withoutDir = entries.filter((e) => !e.dir)
  const groups = []

  // PRIMARY: same immediate directory = one book.
  const byDir = new Map()
  for (const e of withDir) {
    if (!byDir.has(e.dir)) byDir.set(e.dir, [])
    byDir.get(e.dir).push(e)
  }
  for (const [dir, list] of byDir) {
    list.sort((a, b) => naturalCompare(a.file.name, b.file.name))
    const folderTitle = cleanFolderName(lastSegmentOfDir(dir))
    const folderAuthor = cleanFolderName(parentSegmentOfDir(dir))
    const title = commonNonEmpty(list.map((e) => e.parsed.title)) || folderTitle
    const author = commonNonEmpty(list.map((e) => e.parsed.author)) || folderAuthor
    groups.push({ entries: list, title, author, dir })
  }

  // FALLBACK: no directory info. Album first, then prefix+part-number.
  const byAlbum = new Map()
  const rest = []
  for (const e of withoutDir) {
    const album = String(e.parsed.album || '').trim()
    if (album) {
      const key = album.toLowerCase()
      if (!byAlbum.has(key)) byAlbum.set(key, { album, list: [] })
      byAlbum.get(key).list.push(e)
    } else rest.push(e)
  }
  const consumed = new Set()
  for (const { album, list } of byAlbum.values()) {
    if (list.length < 2) { rest.push(...list); continue }
    list.sort((a, b) => naturalCompare(a.file.name, b.file.name))
    const title = commonNonEmpty(list.map((e) => e.parsed.title)) || album
    const author = commonNonEmpty(list.map((e) => e.parsed.author))
    groups.push({ entries: list, title, author, dir: '' })
    list.forEach((e) => consumed.add(e))
  }
  // Prefix + part number, among what is left.
  const byPrefix = new Map()
  for (const e of rest) {
    if (consumed.has(e)) continue
    const info = partSuffixInfo(e.file.name)
    if (!info) continue
    const key = info.prefix.toLowerCase()
    if (!byPrefix.has(key)) byPrefix.set(key, { prefix: info.prefix, list: [] })
    byPrefix.get(key).list.push(e)
  }
  for (const { prefix, list } of byPrefix.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => naturalCompare(a.file.name, b.file.name))
    const title = commonNonEmpty(list.map((e) => e.parsed.title)) || cleanFolderName(prefix)
    const author = commonNonEmpty(list.map((e) => e.parsed.author))
    groups.push({ entries: list, title, author, dir: '' })
    list.forEach((e) => consumed.add(e))
  }
  // Everything left over is a single-file book.
  for (const e of withoutDir) {
    if (!consumed.has(e)) groups.push({ entries: [e], title: e.parsed.title, author: e.parsed.author, dir: '' })
  }
  return groups
}

// Cumulative start offsets for chapters (strict): offsets[i] is
// the start of part i if all earlier durations are known, otherwise
// null (unplaceable — chapters after an unknown part are dropped
// from the global list, see globalChapters).
export function partStartOffsets(durations) {
  const out = []
  let sum = 0
  let known = true
  for (const d of durations) {
    out.push(known ? sum : null)
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) sum += d
    else known = false
  }
  return out
}

// Cumulative sums for POSITION math (lenient): unknown durations
// count as 0. Live global position uses this convention — global =
// sumKnownBefore(part) + position in part — so resume must use the
// same sums, or a saved position would land in the wrong part.
export function knownSums(durations) {
  const out = []
  let sum = 0
  for (const d of durations) {
    out.push(sum)
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) sum += d
  }
  return out
}

// Global chapter list for a multi-part book: each part's chapters
// shifted by its start offset. Parts after an unknown-duration part
// cannot be placed, so their chapters are omitted (never faked).
// Single-part books pass through unchanged (offset 0).
export function globalChapters(parts) {
  const durations = parts.map((p) => p.durationSec)
  const offsets = partStartOffsets(durations)
  const out = []
  parts.forEach((part, i) => {
    if (offsets[i] === null) return
    for (const ch of part.chapters || []) out.push({ ...ch, start: ch.start + offsets[i], partIndex: i })
  })
  return out.sort((a, b) => a.start - b.start)
}

// Map a GLOBAL seek target to { partIndex, offsetInPart }.
// A target inside an unknown-duration part lands in that part at
// (target − known total before it); a target past the end clamps
// to the last part at its duration (or 0 when unknown).
export function mapGlobalToPart(globalSec, durations) {
  const target = Math.max(0, globalSec || 0)
  let cum = 0
  for (let i = 0; i < durations.length; i++) {
    const d = durations[i]
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) {
      if (target < cum + d) return { partIndex: i, offsetInPart: target - cum }
      cum += d
    } else {
      // Unknown-duration part absorbs everything from here.
      return { partIndex: i, offsetInPart: Math.max(0, target - cum) }
    }
  }
  const last = durations.length - 1
  const lastDur = durations[last]
  return {
    partIndex: last,
    offsetInPart: typeof lastDur === 'number' && Number.isFinite(lastDur) && lastDur > 0 ? Math.min(lastDur, target - cum) : 0,
  }
}

// Resume mapping: saved { positionSec (global), partIndex } back to
// (partIndex, offsetInPart), clamped into the part when its duration
// is known. Uses knownSums — the same convention live position math
// uses — so a saved position lands in the part it was saved in.
// Falls back to mapGlobalToPart when the saved part index is
// missing or out of range.
export function resumeForSaved(saved, durations) {
  if (!saved) return { partIndex: 0, offsetInPart: 0 }
  const idx = saved.partIndex
  if (typeof idx === 'number' && idx >= 0 && idx < durations.length) {
    const sums = knownSums(durations)
    let offset = Math.max(0, (saved.positionSec || 0) - sums[idx])
    const d = durations[idx]
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) offset = Math.min(d, offset)
    return { partIndex: idx, offsetInPart: offset }
  }
  return mapGlobalToPart(saved.positionSec || 0, durations)
}
