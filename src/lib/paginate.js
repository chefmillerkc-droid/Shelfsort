// v0.7.0 EPUB pagination — measured, deterministic, NO CSS columns.
//
// The old reader laid a chapter out in CSS columns and derived the page
// count from scrollWidth / clientWidth. On the phone WebView that failed
// silently: a chapter could be measured as "Page 1 of 1" while its text
// continued past the bottom of the page, clipped and unreachable.
// This module replaces it: a chapter is split into REAL pages by
// measuring rendered height, one block at a time, and each finished
// page is its own DOM element. The visible reader shows exactly ONE
// page div. No columns, no translateX strip, no scrollWidth page count.
//
// Two entry points share the word-splitting logic:
//  - paginateBlocks(blocks, pageHeight, estimateHeight): PURE, for
//    node tests. `blocks` are { html, text }; estimateHeight(html)
//    returns the height that block would occupy in the same units
//    as pageHeight. A single block taller than a page is split by
//    words, never dropped, never clipped.
//  - paginateChapterDom(html, measurer, pageHeight): BROWSER. It
//    renders blocks into a hidden measuring container at the exact
//    page width/font/theme and reads real offsetHeight, so the pages
//    it returns fit the visible page by construction.
//
// HARD RULE: no page may clip text. If measurement fails (no
// measurer, zero size, exception), the caller must fall back to
// showing the whole chapter as a scrollable page — never
// overflow:hidden with no way to reach the text.

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Split a chapter HTML fragment into its top-level blocks. Text nodes
// become <p> blocks; scripts/styles are dropped; everything else keeps
// its original outer HTML (so images keep their src, links keep href).
export function extractBlocks(html) {
  if (typeof DOMParser === 'undefined') return []
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html')
  const root = doc.body ? doc.body.firstChild : null
  if (!root) return []
  const blocks = []
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) {
      const t = (node.textContent || '').trim()
      if (t) blocks.push({ html: `<p>${escapeHtml(t)}</p>`, text: t })
    } else if (node.nodeType === 1) {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') continue
      blocks.push({ html: node.outerHTML, text: node.textContent || '' })
    }
  }
  return blocks
}

// Pure pagination over blocks with a supplied height estimator.
// Returns [{ html, text }] — one entry per page, in order, every
// word of every block in exactly one page.
export function paginateBlocks(blocks, pageHeight, estimateHeight) {
  const pages = []
  let current = []
  let currentText = ''
  let currentHeight = 0
  const flush = () => {
    if (current.length) {
      pages.push({ html: current.join(''), text: currentText.trim() })
      current = []
      currentText = ''
      currentHeight = 0
    }
  }
  // Split one oversized text block into word-chunks that each fit.
  const splitTextBlock = (block) => {
    const words = (block.text || '').split(/\s+/).filter(Boolean)
    if (!words.length) return
    let chunk = []
    let chunkText = ''
    for (const word of words) {
      const trial = chunkText ? `${chunkText} ${word}` : word
      const h = estimateHeight(`<p>${escapeHtml(trial)}</p>`)
      if (h <= pageHeight) {
        chunk.push(word)
        chunkText = trial
      } else if (!chunk.length) {
        // A single word taller than the page: force it onto its own
        // page rather than dropping it.
        pages.push({ html: `<p>${escapeHtml(word)}</p>`, text: word })
      } else {
        pages.push({ html: `<p>${escapeHtml(chunkText)}</p>`, text: chunkText })
        chunk = [word]
        chunkText = word
      }
    }
    if (chunk.length) {
      current = [`<p>${escapeHtml(chunkText)}</p>`]
      currentText = chunkText
      currentHeight = estimateHeight(current[0])
    }
  }
  for (const block of blocks) {
    const h = estimateHeight(block.html)
    if (h <= pageHeight - currentHeight || (h <= pageHeight && !current.length)) {
      current.push(block.html)
      currentText += (currentText ? ' ' : '') + (block.text || '')
      currentHeight += h
    } else if (h > pageHeight && (block.text || '').trim()) {
      // Oversized block: close the current page, then split it.
      flush()
      splitTextBlock(block)
    } else {
      // Fits on a fresh page, just not on the current one.
      flush()
      current.push(block.html)
      currentText = block.text || ''
      currentHeight = h
    }
  }
  flush()
  return pages
}

// Browser pagination: measure real rendered height in `measurer`
// (a hidden container already sized to the page width and styled
// with the reader's font size / line-height / theme). Returns
// [{ html, text }] pages. Throws on a DOM failure — the caller must
// then fall back to the scrollable whole chapter.
export function paginateChapterDom(html, measurer, pageHeight) {
  if (!measurer || !pageHeight || pageHeight <= 0) throw new Error('No page size to measure against')
  const blocks = extractBlocks(html)
  if (!blocks.length) return [{ html: html || '<p>No readable chapter content found in this EPUB.</p>', text: '' }]
  const pageEl = document.createElement('div')
  pageEl.className = 'reader-page reader-page-measure'
  measurer.appendChild(pageEl)
  const pages = []
  let current = []
  let currentText = ''
  const flush = () => {
    if (current.length) {
      pages.push({ html: current.join(''), text: currentText.trim() })
      current = []
      currentText = ''
    }
    pageEl.innerHTML = ''
  }
  try {
    for (const block of blocks) {
      pageEl.insertAdjacentHTML('beforeend', block.html)
      if (pageEl.offsetHeight <= pageHeight) {
        current.push(block.html)
        currentText += (currentText ? ' ' : '') + (block.text || '')
        continue
      }
      // Does not fit on this page: take it back off.
      if (pageEl.lastElementChild) pageEl.lastElementChild.remove()
      else pageEl.innerHTML = ''
      if (current.length) flush()
      // Try it alone on a fresh page.
      pageEl.insertAdjacentHTML('beforeend', block.html)
      if (pageEl.offsetHeight <= pageHeight) {
        current.push(block.html)
        currentText = block.text || ''
        continue
      }
      // Oversized single block.
      pageEl.innerHTML = ''
      const text = (block.text || '').trim()
      const isTextBlock = text && !/^<(img|figure|table|video|svg)/i.test(block.html.trim())
      if (isTextBlock) {
        const words = text.split(/\s+/).filter(Boolean)
        let p = document.createElement('p')
        pageEl.appendChild(p)
        let chunkText = ''
        for (const word of words) {
          const trial = chunkText ? `${chunkText} ${word}` : word
          p.textContent = trial
          if (pageEl.offsetHeight <= pageHeight) {
            chunkText = trial
          } else if (!chunkText) {
            // Single word taller than the page: force it, don't drop it.
            chunkText = word
            p.textContent = chunkText
          } else {
            pages.push({ html: `<p>${escapeHtml(chunkText)}</p>`, text: chunkText })
            pageEl.innerHTML = ''
            p = document.createElement('p')
            pageEl.appendChild(p)
            chunkText = word
            p.textContent = chunkText
          }
        }
        current = [`<p>${escapeHtml(chunkText)}</p>`]
        currentText = chunkText
        // pageEl already holds the final chunk paragraph; keep it so
        // the next block is measured against the real remainder.
      } else {
        // Image/table/figure taller than a page: it gets a page of
        // its own, and visible-page CSS clamps images to the page
        // (max-height: 100%) so it cannot run off the screen.
        current.push(block.html)
        currentText = block.text || ''
        flush()
      }
    }
    flush()
  } finally {
    if (pageEl.parentNode === measurer) measurer.removeChild(pageEl)
  }
  return pages.length ? pages : [{ html, text: '' }]
}

// First page index whose text contains `query` (case-insensitive),
// or -1. Used by in-book search: a hit jumps to its actual page,
// not to a character-fraction estimate.
export function findPageForText(pages, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return -1
  for (let i = 0; i < pages.length; i++) {
    if ((pages[i].text || '').toLowerCase().includes(q)) return i
  }
  return -1
}

// Pure page-turn rule (also used by the reader, so it is testable):
// a turn moves exactly one page, and ONLY at a chapter boundary does
// it change chapter. Returns { page } for a within-chapter turn, or
// { page: null, chapterChange: true } at the boundary.
export function nextPageIndex(pageIndex, pageCount, dir) {
  if (dir > 0) {
    return pageIndex < pageCount - 1
      ? { page: pageIndex + 1, chapterChange: false }
      : { page: null, chapterChange: true }
  }
  return pageIndex > 0
    ? { page: pageIndex - 1, chapterChange: false }
    : { page: null, chapterChange: true }
}
