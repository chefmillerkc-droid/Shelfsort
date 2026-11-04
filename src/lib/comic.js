// Comic archives.
//
// CBZ (zip) is parsed with JSZip, as before. CBR (RAR), CBT (tar, plain
// or gzip/bzip2/xz-compressed) and CB7 (7z) are parsed with libarchive.js
// (libarchive compiled to WebAssembly, v2.0.2), which claims ZIP, 7-Zip,
// RAR v4, RAR v5 and TAR. The old note that "no reliable browser RAR5
// unpacker exists" is superseded by that library: it was verified in
// Node with real archives (see README v0.7.3) — a hand-crafted RAR5
// stored archive, a tar CBT and a py7zr CB7 all listed and extracted
// correctly, including single-page extraction. Caveats, stated
// honestly: compressed RAR5 entries could not be tested on this VM
// (no RAR compressor exists here), so a real compressed CBR still
// needs a phone test; encrypted archives and multi-volume sets are
// NOT supported (libarchive reports them as encrypted / incomplete)
// and surface as a clear error, never as a fake open.
// The WASM worker is loaded through Vite's ?worker import, so the
// worker chunk and its .wasm are bundled from node_modules on the
// build runner — no binary files are committed to the repo and no
// workflow change is needed for them.
import JSZip from 'jszip'

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)$/i
const COMIC_EXT = /\.(cbz|cbr|cbt|cb7)$/i

export function isComicFile(name) {
  return COMIC_EXT.test(name || '')
}

export function isCbrFile(name) {
  return /\.cbr$/i.test(name || '')
}

// Archives that go through the libarchive worker (everything except zip).
export function isLibarchiveFile(name) {
  return /\.(cbr|cbt|cb7)$/i.test(name || '')
}

export function comicExtOf(name) {
  const m = (name || '').match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : ''
}

// Natural sort: "page2" before "page10", folder-prefixed names kept
// in archive order as a tie-break.
export function naturalCompare(a, b) {
  const ax = a.split(/(\d+)/)
  const bx = b.split(/(\d+)/)
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    if (ax[i] === undefined) return -1
    if (bx[i] === undefined) return 1
    if (ax[i] === bx[i]) continue
    const an = Number(ax[i])
    const bn = Number(bx[i])
    if (!Number.isNaN(an) && !Number.isNaN(bn) && ax[i].trim() !== '' && bx[i].trim() !== '') {
      return an - bn
    }
    return ax[i].localeCompare(bx[i])
  }
  return 0
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

// ComicInfo.xml is a flat field list, so a tag extractor (not a full
// XML parser) is enough here and keeps this module testable in Node.
// Returns {} when the text is not ComicInfo-shaped.
export function parseComicInfoXml(text) {
  if (!text || !/<ComicInfo[\s>]/i.test(text)) return {}
  const field = (name) => {
    const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))
    if (!m) return ''
    return decodeEntities(m[1]).trim()
  }
  const year = field('Year')
  const month = field('Month')
  const day = field('Day')
  let date = ''
  if (/^\d{4}$/.test(year)) {
    date = year
    if (/^\d{1,2}$/.test(month)) {
      date += `-${String(Number(month)).padStart(2, '0')}`
      if (/^\d{1,2}$/.test(day)) date += `-${String(Number(day)).padStart(2, '0')}`
    }
  }
  const number = field('Number')
  const seriesIndex = /^-?\d+(\.\d+)?$/.test(number) ? number : ''
  const author = ['Writer', 'Penciller', 'Inker', 'Colorist', 'Letterer', 'CoverArtist', 'Editor']
    .map((n) => field(n)).find((v) => v) || ''
  return {
    title: field('Title'),
    series: field('Series'),
    seriesIndex,
    volume: field('Volume'),
    author,
    publisher: field('Publisher'),
    date,
    description: field('Summary'),
  }
}

function cleanFilenameTitle(fallbackName, ext) {
  return fallbackName.replace(new RegExp(`\\.${ext}$`, 'i'), '').replace(/[_-]+/g, ' ').trim()
}

function baseMetadata({ fallbackName, ext, coverDataUrl, pageNames, comicInfo }) {
  const title = comicInfo.title || cleanFilenameTitle(fallbackName, ext)
  return {
    title,
    titleFromFilename: !comicInfo.title,
    author: comicInfo.author || '',
    creators: comicInfo.author ? [comicInfo.author] : [],
    language: '',
    publisher: comicInfo.publisher || '',
    date: comicInfo.date || '',
    description: comicInfo.description || '',
    identifier: '',
    isbn: '',
    series: comicInfo.series || '',
    seriesIndex: comicInfo.seriesIndex || '',
    volume: comicInfo.volume || '',
    coverDataUrl,
    pageNames,
    pageCount: pageNames.length,
  }
}

function isImageName(name) {
  return IMAGE_EXT.test(name) && !/(^|\/)__MACOSX\//.test(name) && !/^\./.test(name.split('/').pop())
}

function isComicInfoName(name) {
  return /(^|\/)ComicInfo\.xml$/i.test(name)
}

async function parseZipComic(arrayBuffer, fallbackName, ext) {
  const zip = await JSZip.loadAsync(arrayBuffer)
  const allNames = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  const names = allNames.filter(isImageName).sort(naturalCompare)
  if (!names.length) throw new Error('No images found in this comic archive')
  let comicInfo = {}
  const infoName = allNames.filter(isComicInfoName).sort((a, b) => a.length - b.length)[0]
  if (infoName) {
    try { comicInfo = parseComicInfoXml(await zip.file(infoName).async('text')) } catch { /* metadata is best-effort */ }
  }
  let coverDataUrl = ''
  try {
    const blob = await zip.file(names[0]).async('blob')
    coverDataUrl = await blobToDataUrl(blob)
  } catch { /* cover is best-effort */ }
  return baseMetadata({ fallbackName, ext, coverDataUrl, pageNames: names, comicInfo })
}

// ---- libarchive (CBR / CBT / CB7) -------------------------------------
// Lazy: the worker constructor is only imported when a non-zip comic
// is actually opened, so EPUB/PDF/audio users never pay for it.
let libarchiveInit = null
async function getLibarchive() {
  if (!libarchiveInit) {
    libarchiveInit = (async () => {
      const [{ Archive }, workerMod] = await Promise.all([
        import('libarchive.js'),
        import('libarchive.js/dist/worker-bundle.js?worker'),
      ])
      const WorkerCtor = workerMod.default || workerMod
      Archive.init({ getWorker: () => new WorkerCtor() })
      return Archive
    })().catch((e) => { libarchiveInit = null; throw e })
  }
  return libarchiveInit
}

async function withLibarchiveArchive(arrayBuffer, fallbackName, fn) {
  const Archive = await getLibarchive()
  const archive = await Archive.open(new File([arrayBuffer], fallbackName))
  try {
    return await fn(archive)
  } finally {
    try { await archive.close() } catch { /* already closed after extractFiles */ }
  }
}

function flattenLibarchiveEntries(arr) {
  // getFilesArray() returns { file: CompressedFile, path: 'dir/' }.
  // Full archive path = path + file.name. Directories never appear
  // as extractable entries here.
  return arr
    .filter((e) => e.file && typeof e.file.extract === 'function' && typeof e.file.name === 'string')
    .map((e) => ({ fullPath: `${e.path || ''}${e.file.name}`, entry: e.file }))
}

async function parseLibarchiveComic(arrayBuffer, fallbackName, ext) {
  return withLibarchiveArchive(arrayBuffer, fallbackName, async (archive) => {
    const entries = flattenLibarchiveEntries(await archive.getFilesArray())
    const info = entries.find((e) => isComicInfoName(e.fullPath))
    let comicInfo = {}
    if (info) {
      try {
        const f = await info.entry.extract()
        comicInfo = parseComicInfoXml(await f.text())
      } catch { /* metadata is best-effort */ }
    }
    const images = entries.filter((e) => isImageName(e.fullPath))
    const names = images.map((e) => e.fullPath).sort(naturalCompare)
    if (!names.length) throw new Error('No images found in this comic archive')
    let coverDataUrl = ''
    try {
      const byName = new Map(images.map((e) => [e.fullPath, e.entry]))
      const cover = await byName.get(names[0]).extract()
      coverDataUrl = await blobToDataUrl(new Blob([await cover.arrayBuffer()], { type: cover.type || 'image/png' }))
    } catch { /* cover is best-effort */ }
    return baseMetadata({ fallbackName, ext, coverDataUrl, pageNames: names, comicInfo })
  })
}

export async function parseComic(arrayBuffer, fallbackName) {
  const ext = comicExtOf(fallbackName)
  if (ext === 'cbz') return parseZipComic(arrayBuffer, fallbackName, ext)
  if (isLibarchiveFile(fallbackName)) return parseLibarchiveComic(arrayBuffer, fallbackName, ext)
  throw new Error(`Unsupported comic archive: .${ext}`)
}

// Backwards-compatible name used by older call sites.
export const parseCbz = parseComic

// Load every page (in pageNames order) with a single archive open.
// Returns [{ name, blob }] — the viewer's object URLs are built from
// these, so a 200-page comic does not re-open its archive 200 times.
export async function loadComicPages(arrayBuffer, pageNames, fallbackName) {
  const ext = comicExtOf(fallbackName)
  if (ext === 'cbz') {
    const zip = await JSZip.loadAsync(arrayBuffer)
    const out = []
    for (const name of pageNames) {
      const file = zip.file(name)
      if (!file) throw new Error(`Page not found in archive: ${name}`)
      out.push({ name, blob: await file.async('blob') })
    }
    return out
  }
  if (isLibarchiveFile(fallbackName)) {
    return withLibarchiveArchive(arrayBuffer, fallbackName, async (archive) => {
      const byName = new Map(flattenLibarchiveEntries(await archive.getFilesArray()).map((e) => [e.fullPath, e.entry]))
      const out = []
      for (const name of pageNames) {
        const entry = byName.get(name)
        if (!entry) throw new Error(`Page not found in archive: ${name}`)
        const f = await entry.extract()
        out.push({ name, blob: new Blob([await f.arrayBuffer()], { type: f.type || 'application/octet-stream' }) })
      }
      return out
    })
  }
  throw new Error(`Unsupported comic archive: .${ext}`)
}

export async function getComicPageBlob(arrayBuffer, pageName, fallbackName) {
  const pages = await loadComicPages(arrayBuffer, [pageName], fallbackName)
  return pages[0].blob
}

// Backwards-compatible name.
export async function getCbzPageBlob(arrayBuffer, pageName) {
  return getComicPageBlob(arrayBuffer, pageName, 'book.cbz')
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
