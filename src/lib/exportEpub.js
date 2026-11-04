// Corrected-EPUB export.
//
// Rebuilds the original zip with a rewritten OPF: the corrected
// metadata fields replace (or are added to) the existing dc:* elements,
// calibre:series / calibre:series_index metas are added or updated,
// and a new cover, when supplied as a data URL, is written into the
// zip as OEBPS/cover.jpg, added to the manifest, and referenced by
// <meta name="cover">. The spine and all content files are copied
// unchanged, and the original library file is never modified — the
// caller downloads a new blob.
import JSZip from 'jszip'

const DC_NS = 'http://purl.org/dc/elements/1.1/'

function parseXml(text) {
  return new DOMParser().parseFromString(text, 'application/xml')
}

function dataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(header)?.[1] || 'image/jpeg'
  const bytes = atob(data)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

function setDc(doc, metadataEl, tag, value) {
  if (!value) return
  const existing = metadataEl.getElementsByTagNameNS(DC_NS, tag)[0]
  if (existing) {
    existing.textContent = value
  } else {
    const el = doc.createElementNS(DC_NS, `dc:${tag}`)
    el.textContent = value
    metadataEl.appendChild(el)
  }
}

function setMeta(doc, metadataEl, name, value) {
  if (value === '' || value === null || value === undefined) return
  let existing = null
  for (const m of metadataEl.querySelectorAll('meta')) {
    if (m.getAttribute('name') === name) { existing = m; break }
  }
  if (existing) existing.setAttribute('content', String(value))
  else {
    const el = doc.createElement('meta')
    el.setAttribute('name', name)
    el.setAttribute('content', String(value))
    metadataEl.appendChild(el)
  }
}

export async function buildCorrectedEpub(book, correctedMetadata, newCoverDataUrl) {
  const zip = await JSZip.loadAsync(book.file)
  const container = parseXml(await zip.file('META-INF/container.xml').async('text'))
  const opfPath = container.querySelector('rootfile').getAttribute('full-path')
  const opfText = await zip.file(opfPath).async('text')
  const opf = parseXml(opfText)
  const metadataEl = opf.querySelector('metadata')
  const manifestEl = opf.querySelector('manifest')

  // Metadata fields: only overwrite with non-empty corrected values.
  for (const tag of ['title', 'publisher', 'date', 'description']) {
    if (correctedMetadata[tag]) setDc(opf, metadataEl, tag, correctedMetadata[tag])
  }
  if (correctedMetadata.author) {
    // Replace all dc:creator elements with the corrected author list.
    const creators = correctedMetadata.author.split(',').map((s) => s.trim()).filter(Boolean)
    const existing = [...metadataEl.getElementsByTagNameNS(DC_NS, 'creator')]
    existing.forEach((el) => el.remove())
    for (const name of creators) {
      const el = opf.createElementNS(DC_NS, 'dc:creator')
      el.textContent = name
      metadataEl.appendChild(el)
    }
  }
  if (correctedMetadata.series !== undefined) setMeta(opf, metadataEl, 'calibre:series', correctedMetadata.series)
  if (correctedMetadata.seriesIndex !== undefined && correctedMetadata.seriesIndex !== '') {
    setMeta(opf, metadataEl, 'calibre:series_index', correctedMetadata.seriesIndex)
  }

  // New cover: write the image, add it to the manifest, point <meta
  // name="cover"> at it. The old cover file is left in place so
  // nothing else in the book breaks.
  if (newCoverDataUrl && newCoverDataUrl.startsWith('data:')) {
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
    const coverPath = (opfDir ? opfDir + '/' : '') + 'cover.jpg'
    zip.file(coverPath, dataUrlToBlob(newCoverDataUrl))
    if (!opf.querySelector('manifest > item[id="shelfsort-cover"]')) {
      const item = opf.createElement('item')
      item.setAttribute('id', 'shelfsort-cover')
      item.setAttribute('href', 'cover.jpg')
      item.setAttribute('media-type', 'image/jpeg')
      item.setAttribute('properties', 'cover-image')
      manifestEl.appendChild(item)
    }
    let coverMeta = metadataEl.querySelector('meta[name="cover"]')
    if (!coverMeta) {
      coverMeta = opf.createElement('meta')
      coverMeta.setAttribute('name', 'cover')
      metadataEl.appendChild(coverMeta)
    }
    coverMeta.setAttribute('content', 'shelfsort-cover')
  }

  const newOpf = new XMLSerializer().serializeToString(opf)
  zip.file(opfPath, newOpf)
  // EPUB spec: mimetype should be first and uncompressed. JSZip
  // cannot guarantee store-only for a single entry in this simple
  // rebuild, so we note the limitation in README; most readers
  // accept a normally-compressed mimetype entry.
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' })
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
