// M4B / MP3 audiobook metadata + chapters, parsed client-side.
// M4B is an MP4 container. Chapters are looked for in two places:
//  1. A Nero 'chpl' atom (tolerant parsing: several header layouts
//     are tried, entries must be monotonic and within the duration).
//  2. A QuickTime chapter track is NOT fully decoded here — if no
//     'chpl' chapters are found, the book falls back to a single
//     track with time-based bookmarks, which the player supports.
// No chapter data is invented: chapters=[] means "none embedded".
function readU32(dv, off) { return dv.getUint32(off, false) }
function readU64(dv, off) {
  // Big-endian 64-bit as a Number (safe for audio durations).
  return Number(dv.getBigUint64(off, false))
}

// Walk MP4 boxes. `meta` boxes carry 4 version/flags bytes before
// their children; every other container is walked directly.
function walkBoxes(dv, start, end, out, depth = 0) {
  if (depth > 8) return
  let off = start
  while (off + 8 <= end) {
    let size = readU32(dv, off)
    const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7))
    let header = 8
    if (size === 1) { size = readU64(dv, off + 8); header = 16 }
    else if (size === 0) { size = end - off }
    if (size < header || off + size > end + 1) break
    const dataStart = off + header
    const dataEnd = off + size
    out.push({ type, start: off, dataStart, dataEnd, size })
    if (['moov', 'trak', 'mdia', 'minf', 'udta', 'tref'].includes(type)) {
      walkBoxes(dv, dataStart, dataEnd, out, depth + 1)
    } else if (type === 'meta') {
      walkBoxes(dv, dataStart + 4, dataEnd, out, depth + 1)
    }
    off += size
  }
}

function readString(dv, off, len) {
  let s = ''
  for (let i = 0; i < len; i++) {
    const c = dv.getUint8(off + i)
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

function parseChpl(dv, box, durationSec) {
  const data = box.dataStart
  const end = box.dataEnd
  // Try several plausible header offsets; an entry is
  // uint64 start + uint8 title-length + title bytes.
  for (const headerSkip of [0, 4, 5, 8]) {
    let pos = data + headerSkip
    if (pos + 4 > end) continue
    // Some layouts store a count first; try both "count then
    // entries" and "entries until end" by scanning entries.
    let count = null
    if (headerSkip >= 4) {
      // If the 4 bytes before pos look like a small count, use it.
      const maybeCount = readU32(dv, data)
      if (maybeCount > 0 && maybeCount < 1000) count = maybeCount
    }
    const chapters = []
    let ok = true
    let lastStart = -1
    while (pos + 9 <= end && (count === null || chapters.length < count)) {
      const startRaw = readU64(dv, pos)
      const titleLen = dv.getUint8(pos + 8)
      if (titleLen === 0 || titleLen > 200 || pos + 9 + titleLen > end) { ok = false; break }
      const title = readString(dv, pos + 9, titleLen)
      if (!/^[\x20-\x7e\u00a0-\uffff]+$/.test(title)) { ok = false; break }
      // Nero start units: try 1/10000s first, then 100ns, then seconds.
      let startSec = startRaw / 10000
      if (durationSec && startSec > durationSec * 1.5) startSec = startRaw / 10000000
      if (durationSec && startSec > durationSec * 1.5) startSec = startRaw
      if (startSec < lastStart || (durationSec && startSec > durationSec + 1)) { ok = false; break }
      lastStart = startSec
      chapters.push({ title: title.trim() || `Chapter ${chapters.length + 1}`, start: startSec })
      pos += 9 + titleLen
    }
    if (ok && chapters.length >= 2) return chapters
    if (ok && chapters.length === 1 && count === 1) return chapters
  }
  return []
}

function parseIlst(dv, box) {
  // ilst children are 4-char keys with a data box inside.
  const out = {}
  let off = box.dataStart
  while (off + 8 <= box.dataEnd) {
    let size = readU32(dv, off)
    if (size < 8 || off + size > box.dataEnd) break
    const key = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7))
    // Find a 'data' box inside this item.
    let inner = off + 8
    while (inner + 8 <= off + size) {
      const isize = readU32(dv, inner)
      const itype = String.fromCharCode(dv.getUint8(inner + 4), dv.getUint8(inner + 5), dv.getUint8(inner + 6), dv.getUint8(inner + 7))
      if (itype === 'data' && isize > 16) {
        // data box: 4 size, 4 type, 4 type-indicator, 4 locale, then value
        const value = readString(dv, inner + 16, isize - 16)
        if (value) out[key] = value
        break
      }
      if (isize < 8) break
      inner += isize
    }
    off += size
  }
  return out
}

export function parseAudio(arrayBuffer, fallbackName = 'Unknown audiobook') {
  const dv = new DataView(arrayBuffer)
  const boxes = []
  try { walkBoxes(dv, 0, dv.byteLength, boxes) } catch { /* partial parse is ok */ }

  let durationSec = null
  let timescale = null
  const mvhd = boxes.find((b) => b.type === 'mvhd')
  if (mvhd) {
    try {
      const version = dv.getUint8(mvhd.dataStart)
      if (version === 1) {
        timescale = readU32(dv, mvhd.dataStart + 20)
        durationSec = Number(dv.getBigUint64(mvhd.dataStart + 24, false)) / (timescale || 1)
      } else {
        timescale = readU32(dv, mvhd.dataStart + 12)
        durationSec = readU32(dv, mvhd.dataStart + 16) / (timescale || 1)
      }
    } catch { /* duration from the audio element later */ }
  }

  let meta = {}
  const ilst = boxes.find((b) => b.type === 'ilst')
  if (ilst) { try { meta = parseIlst(dv, ilst) } catch { /* ignore */ } }

  const title = meta['©nam'] || meta['nam'] || fallbackName.replace(/\.(m4b|mp3)$/i, '').replace(/[_-]+/g, ' ').trim()
  const author = meta['©ART'] || meta['aART'] || ''
  const chapters = []
  for (const box of boxes.filter((b) => b.type === 'chpl')) {
    const found = parseChpl(dv, box, durationSec)
    if (found.length) { chapters.push(...found); break }
  }
  // De-duplicate / sort chapter starts.
  const seen = new Set()
  const cleanChapters = chapters
    .filter((c) => { if (seen.has(c.start)) return false; seen.add(c.start); return true })
    .sort((a, b) => a.start - b.start)

  return {
    title,
    author,
    creators: author ? [author] : [],
    language: '',
    publisher: '',
    date: meta['©day'] || '',
    description: meta['desc'] || meta['©cmt'] || '',
    identifier: '',
    isbn: '',
    series: '',
    seriesIndex: '',
    coverDataUrl: '',
    durationSec: durationSec && Number.isFinite(durationSec) ? durationSec : null,
    chapters: cleanChapters,
    // Cover art in MP4 ('covr') is binary and large; the player
    // shows a placeholder unless the user adds a cover via Fix Review.
    hasEmbeddedChapters: cleanChapters.length > 0,
  }
}

// Minimal ID3v2 text-frame reader for MP3s (TIT2/TPE1/TALB).
export function parseMp3Tags(arrayBuffer, fallbackName = 'Unknown audiobook') {
  const bytes = new Uint8Array(arrayBuffer)
  const out = { title: '', author: '' }
  if (!(bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)) return out
  let pos = 10
  const end = Math.min(bytes.length, 10 + ((bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f)))
  const dec = new TextDecoder('utf-8', { fatal: false })
  while (pos + 10 <= end) {
    const id = dec.decode(bytes.slice(pos, pos + 4))
    const size = (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7]
    if (size <= 0 || pos + 10 + size > bytes.length) break
    if (['TIT2', 'TPE1', 'TALB'].includes(id)) {
      const text = dec.decode(bytes.slice(pos + 11, pos + 10 + size)).replace(/\0/g, '').trim()
      if (id === 'TIT2') out.title = text
      if (id === 'TPE1') out.author = text
    }
    pos += 10 + size
  }
  if (!out.title) out.title = fallbackName.replace(/\.(mp3)$/i, '').replace(/[_-]+/g, ' ').trim()
  return out
}

export function formatTime(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '--:--'
  const s = Math.floor(sec % 60)
  const m = Math.floor((sec / 60) % 60)
  const h = Math.floor(sec / 3600)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}
