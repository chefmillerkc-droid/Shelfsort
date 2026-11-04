// Comic archives. CBZ is a zip of images and is fully supported.
// CBR is a RAR archive, which is NOT a zip. The browser-usable RAR
// packages checked for this build (unrar-js 0.2.3) are Node-only
// (fs / child-process based) and there is no reliable, maintained
// browser RAR5 unpacker that can be bundled without a server, so CBR
// is detected and explained honestly instead of faked — see README.
import JSZip from 'jszip'

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)$/i

export function isComicFile(name) {
  return /\.(cbz|cbr)$/i.test(name)
}

export function isCbrFile(name) {
  return /\.cbr$/i.test(name)
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

export async function parseCbz(arrayBuffer, fallbackName = 'Unknown comic') {
  const zip = await JSZip.loadAsync(arrayBuffer)
  const names = Object.keys(zip.files)
    .filter((n) => !zip.files[n].dir && IMAGE_EXT.test(n) && !/(^|\/)__MACOSX\//.test(n) && !/^\./.test(n.split('/').pop()))
    .sort(naturalCompare)
  if (!names.length) throw new Error('No images found in this CBZ archive')
  let coverDataUrl = ''
  try {
    const blob = await zip.file(names[0]).async('blob')
    coverDataUrl = await blobToDataUrl(blob)
  } catch { /* cover is best-effort */ }
  const clean = fallbackName.replace(/\.cbz$/i, '').replace(/[_-]+/g, ' ').trim()
  return {
    title: clean,
    // CBZ archives carry no title metadata, so the title is always
    // filename-derived until a fix or manual edit supplies one.
    titleFromFilename: true,
    author: '',
    creators: [],
    language: '',
    publisher: '',
    date: '',
    description: '',
    identifier: '',
    isbn: '',
    series: '',
    seriesIndex: '',
    coverDataUrl,
    pageNames: names,
    pageCount: names.length,
  }
}

export async function getCbzPageBlob(arrayBuffer, pageName) {
  const zip = await JSZip.loadAsync(arrayBuffer)
  const file = zip.file(pageName)
  if (!file) throw new Error(`Page not found in archive: ${pageName}`)
  return file.async('blob')
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
