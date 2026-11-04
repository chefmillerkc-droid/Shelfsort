// EPUB parsing with JSZip + DOMParser. No epub.js dependency, so the
// reader and the metadata fixer both work from the same parsed model.
//
// An EPUB is a zip: META-INF/container.xml points at the OPF package
// file, the OPF lists metadata + manifest + spine, and the spine gives
// the reading order. Cover detection tries, in order:
//   1. manifest item with properties="cover-image"
//   2. <meta name="cover" content="<item id>">
//   3. a manifest item whose id/href mentions "cover"
import JSZip from 'jszip'

const DC = 'http://purl.org/dc/elements/1.1/'

function parseXml(text) {
  return new DOMParser().parseFromString(text, 'application/xml')
}

function textOf(el) {
  return el ? (el.textContent || '').trim() : ''
}

function joinPaths(baseDir, href) {
  // Resolve a relative href against the OPF directory, normalising . and ..
  const parts = (baseDir ? baseDir + '/' : '') + href
  const out = []
  for (const seg of parts.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

function decodeHref(href) {
  try { return decodeURIComponent(href) } catch { return href }
}

export async function parseEpub(arrayBuffer, fallbackName = 'Unknown book') {
  const zip = await JSZip.loadAsync(arrayBuffer)
  const containerFile = zip.file('META-INF/container.xml')
  if (!containerFile) throw new Error('Not an EPUB: META-INF/container.xml is missing')
  const container = parseXml(await containerFile.async('text'))
  const rootfile = container.querySelector('rootfile')
  const opfPath = rootfile && rootfile.getAttribute('full-path')
  if (!opfPath || !zip.file(opfPath)) throw new Error('Not an EPUB: OPF package file not found')

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const opf = parseXml(await zip.file(opfPath).async('text'))
  const metadata = opf.querySelector('metadata')
  if (!metadata) throw new Error('EPUB has no metadata section')

  const getDc = (tag) => {
    const els = metadata.getElementsByTagNameNS(DC, tag)
    return els.length ? textOf(els[0]) : ''
  }
  const getAllDc = (tag) => [...metadata.getElementsByTagNameNS(DC, tag)].map(textOf).filter(Boolean)

  // Identifiers: prefer an explicit ISBN, otherwise keep the first id.
  let isbn = ''
  let identifier = ''
  for (const el of metadata.getElementsByTagNameNS(DC, 'identifier')) {
    const scheme = (el.getAttribute('opf:scheme') || el.getAttribute('scheme') || '').toUpperCase()
    const value = textOf(el)
    if (!identifier) identifier = value
    if (scheme === 'ISBN' || /^(97[89])?\d{9}[\dX]$/.test(value.replace(/[-\s]/g, ''))) {
      isbn = value.replace(/[-\s]/g, '')
    }
  }

  // Series: Calibre writes <meta name="calibre:series">, other tools
  // write name="series"; EPUB 3 collections use belongs-to-collection.
  // All three are checked, in that order.
  let series = ''
  let seriesIndex = ''
  for (const meta of metadata.querySelectorAll('meta')) {
    const name = meta.getAttribute('name') || ''
    const prop = meta.getAttribute('property') || ''
    const content = meta.getAttribute('content') || ''
    if ((name === 'calibre:series' || name === 'series') && !series) series = content
    if ((name === 'calibre:series_index' || name === 'series_index') && !seriesIndex) seriesIndex = content
    if (prop === 'belongs-to-collection' && !series) series = content
    if (prop === 'group-position' && !seriesIndex) seriesIndex = content
  }

  // Manifest + spine
  const manifest = {}
  for (const item of opf.querySelectorAll('manifest > item')) {
    manifest[item.getAttribute('id')] = {
      id: item.getAttribute('id'),
      href: decodeHref(item.getAttribute('href') || ''),
      mediaType: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || '',
    }
  }
  const spine = [...opf.querySelectorAll('spine > itemref')]
    .map((ref) => manifest[ref.getAttribute('idref')])
    .filter(Boolean)

  // Cover
  let coverItem = Object.values(manifest).find((i) => i.properties.includes('cover-image'))
  if (!coverItem) {
    const coverMeta = metadata.querySelector('meta[name="cover"]')
    if (coverMeta && manifest[coverMeta.getAttribute('content')]) {
      coverItem = manifest[coverMeta.getAttribute('content')]
    }
  }
  if (!coverItem) {
    coverItem = Object.values(manifest).find(
      (i) => /cover/i.test(i.id || '') && (i.mediaType || '').startsWith('image/'),
    )
  }

  let coverDataUrl = ''
  if (coverItem) {
    const path = joinPaths(opfDir, coverItem.href)
    const file = zip.file(path)
    if (file) {
      const blob = await file.async('blob')
      coverDataUrl = await blobToDataUrl(blob)
    }
  }

  const creators = getAllDc('creator')
  const title = getDc('title') || fallbackName.replace(/\.epub$/i, '').replace(/[_-]+/g, ' ').trim()

  return {
    title,
    titleFromFilename: !getDc('title'),
    creators,
    author: creators.join(', '),
    language: getDc('language'),
    publisher: getDc('publisher'),
    date: getDc('date'),
    description: getDc('description'),
    identifier,
    isbn,
    series,
    seriesIndex,
    coverDataUrl,
    spine: spine.map((s) => ({ id: s.id, href: s.href, path: joinPaths(opfDir, s.href) })),
    opfPath,
    opfDir,
  }
}

// Re-parse chapters for the reader. Images are resolved to blob URLs so
// <img> tags inside a chapter keep working; scripts and event handlers
// are stripped before the HTML is rendered.
export async function parseChapters(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer)
  const container = parseXml(await zip.file('META-INF/container.xml').async('text'))
  const opfPath = container.querySelector('rootfile').getAttribute('full-path')
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const opf = parseXml(await zip.file(opfPath).async('text'))
  const manifest = {}
  for (const item of opf.querySelectorAll('manifest > item')) {
    manifest[item.getAttribute('id')] = decodeHref(item.getAttribute('href') || '')
  }
  const spine = [...opf.querySelectorAll('spine > itemref')]
    .map((ref) => manifest[ref.getAttribute('idref')])
    .filter(Boolean)

  const chapters = []
  for (const href of spine) {
    const path = joinPaths(opfDir, href)
    const file = zip.file(path)
    if (!file) continue
    // Only XHTML/HTML spine items are chapters; skip CSS/NCX/etc.
    if (!/\.(x?html?|xml)$/i.test(path)) continue
    const raw = await file.async('text')
    const doc = parseXml(raw)
    const body = doc.querySelector('body')
    let html = body ? body.innerHTML : raw
    // Resolve <img src> relative to this chapter's directory.
    const chapterDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const imgDoc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
    for (const img of imgDoc.querySelectorAll('img')) {
      const src = img.getAttribute('src')
      if (!src || src.startsWith('data:') || /^https?:/.test(src)) continue
      const imgPath = joinPaths(chapterDir, decodeHref(src))
      const imgFile = zip.file(imgPath)
      if (imgFile) {
        const blob = await imgFile.async('blob')
        img.setAttribute('src', URL.createObjectURL(blob))
      } else {
        img.remove()
      }
    }
    // Strip anything executable, then keep the cleaned inner HTML.
    for (const el of imgDoc.querySelectorAll('script, style, link')) el.remove()
    for (const el of imgDoc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith('on')) el.removeAttribute(attr.name)
      }
    }
    html = imgDoc.querySelector('div') ? imgDoc.querySelector('div').innerHTML : html
    const titleEl = doc.querySelector('title') || doc.querySelector('h1') || doc.querySelector('h2')
    const text = (body ? body.textContent : raw).replace(/\s+/g, ' ').trim()
    chapters.push({
      title: titleEl ? textOf(titleEl) : `Chapter ${chapters.length + 1}`,
      html,
      text,
    })
  }
  return chapters
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function fetchAsDataUrl(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Cover fetch failed (${res.status})`)
  return blobToDataUrl(await res.blob())
}
