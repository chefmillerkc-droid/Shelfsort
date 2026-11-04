// PDF reading with pdf.js (pdfjs-dist). Runs entirely in the browser.
// Worker is bundled via Vite's ?url import so no CDN is needed.
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export async function loadPdf(arrayBuffer) {
  // pdf.js may detach/transfer the buffer; pass a copy so the caller
  // can still store the original in IndexedDB.
  const copy = arrayBuffer.slice(0)
  const task = pdfjsLib.getDocument({ data: copy })
  return task.promise
}

export async function parsePdf(arrayBuffer, fallbackName = 'Unknown document') {
  const doc = await loadPdf(arrayBuffer)
  let title = ''
  let author = ''
  try {
    const meta = await doc.getMetadata()
    title = (meta.info && (meta.info.Title || meta.info.title)) || ''
    author = (meta.info && (meta.info.Author || meta.info.author)) || ''
  } catch { /* metadata is best-effort */ }
  // First-page thumbnail as a cover, best-effort only.
  let coverDataUrl = ''
  try {
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 0.6 })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    coverDataUrl = canvas.toDataURL('image/jpeg', 0.7)
  } catch { /* no thumbnail, no problem */ }
  const clean = fallbackName.replace(/\.(pdf)$/i, '').replace(/[_-]+/g, ' ').trim()
  return {
    title: title || clean,
    titleFromFilename: !title,
    author: author || '',
    creators: author ? [author] : [],
    language: '',
    publisher: '',
    date: '',
    description: '',
    identifier: '',
    isbn: '',
    series: '',
    seriesIndex: '',
    coverDataUrl,
    pageCount: doc.numPages,
  }
}

export async function renderPdfPage(doc, pageNumber, canvas, scale) {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  return viewport
}

export async function searchPdf(doc, query) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits = []
  for (let i = 1; i <= doc.numPages; i++) {
    try {
      const content = await doc.getPage(i).then((p) => p.getTextContent())
      const text = content.items.map((it) => it.str).join(' ')
      const idx = text.toLowerCase().indexOf(q)
      if (idx >= 0) {
        hits.push({ page: i, snippet: text.slice(Math.max(0, idx - 60), idx + 120) })
      }
    } catch { /* skip unreadable pages */ }
  }
  return hits
}
