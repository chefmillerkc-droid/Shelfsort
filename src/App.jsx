import { useEffect, useMemo, useRef, useState } from 'react'
import { getAllBooksMeta, getBookFile, putBookMeta, putBookFile, deleteBookFile, deleteBook, clearLibrary, saveProgressLocal, loadProgressLocal } from './lib/db.js'
import { parseEpub, parseChapters, fetchAsDataUrl } from './lib/epub.js'
import { parsePdf, loadPdf, renderPdfPage, searchPdf } from './lib/pdf.js'
import { parseCbz, getCbzPageBlob, isCbrFile } from './lib/comic.js'
import { parseAudio, parseMp3Tags, formatTime } from './lib/audio.js'
import { enrichBook } from './lib/enrich.js'
import { groupBySeries, getSeries, sortBooks } from './lib/series.js'
import { createAudioController } from './lib/nativeAudio.js'
import { buildCorrectedEpub, downloadBlob } from './lib/exportEpub.js'
import { findAudioMatch, findEpubMatch, mapChapters, audioChapterAtTime } from './lib/readalong.js'
import {
  loadR2Settings, saveR2Settings, clearR2Settings, r2Endpoint,
  uploadToR2, downloadFromR2, headR2Object, deleteFromR2, listR2Objects,
  testR2Connection, r2KeyFor, cloudStatus, cloudStatusLabel,
  idFromR2Key, titleFromR2Key, friendlyR2Error, R2_CORS_JSON,
} from './lib/r2.js'

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)
}

function coverFor(book) {
  return book.metadata.coverDataUrl || book.metadata.coverUrl || ''
}

function formatLabel(book) {
  if (book.format === 'pdf') return 'PDF'
  if (book.format === 'comic') return book.cbrUnsupported ? 'CBR' : 'CBZ'
  if (book.format === 'audio') return 'Audiobook'
  return 'EPUB'
}

// Unsorted shelf — IMPORT FIRST, FIX SECOND.
// A book lands here when it could not be sorted confidently:
//   no series AND (author missing OR cover missing OR the title was
//   derived from the filename because the file had no title metadata).
// A standalone book with a real title, author and cover is NOT
// Unsorted just for having no series. This is computed from the
// metadata on every render, never stored as a flag, so a book leaves
// the shelf automatically as soon as a fix or manual edit supplies
// author + cover + series (or a real title + author + cover).
// Old library records predate titleFromFilename: for them the title
// is treated as filename-derived when it exactly matches the cleaned
// filename stem.
export function titleIsFilenameDerived(book) {
  const m = book.metadata || {}
  if (typeof m.titleFromFilename === 'boolean') return m.titleFromFilename
  const stem = (book.fileName || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return !!stem && (m.title || '').trim().toLowerCase() === stem
}

export function isUnsorted(book) {
  const m = book.metadata || {}
  if (getSeries(book).name) return false
  const authorMissing = !(m.author || '').trim()
  const coverMissing = !(m.coverDataUrl || m.coverUrl)
  return authorMissing || coverMissing || titleIsFilenameDerived(book)
}

// Reading status, from progress only (no file access needed).
// NEW = never opened, STARTED = progress set, FINISHED = finished flag
// (set when the reader reaches the last chapter, or toggled on detail).
export function statusOf(book) {
  const pr = book.progress
  if (pr && pr.finished) return 'finished'
  if (!pr) return 'new'
  if (pr.chapterIndex || pr.page || pr.positionSec || (pr.bookmarks && pr.bookmarks.length)) return 'started'
  return 'new'
}

// 0..1 progress fraction for the thin bar under a list cover.
// EPUB uses chapterIndex/totalChapters (saved when chapters load);
// PDF/comic use page/pageCount; audio uses position/duration.
export function progressFraction(book) {
  const pr = book.progress
  if (!pr) return 0
  if (pr.finished) return 1
  if (pr.totalChapters && pr.chapterIndex !== undefined) return Math.min(1, (pr.chapterIndex + 1) / pr.totalChapters)
  if (pr.page && book.metadata.pageCount) return Math.min(1, pr.page / book.metadata.pageCount)
  if (pr.positionSec && book.metadata.durationSec) return Math.min(1, pr.positionSec / book.metadata.durationSec)
  if (pr.chapterIndex) return 0.1
  if (pr.page) return 0.1
  if (pr.positionSec) return 0.1
  return 0
}

// List view (reference screenshot 1): cover left, title + author right,
// thin progress bar under the cover. Nothing else on the card.
function BookRow({ book, onOpen }) {
  const cover = coverFor(book)
  const frac = progressFraction(book)
  return (
    <button className="book-row" onClick={() => onOpen(book)}>
      <span className="row-cover">
        {cover ? <img src={cover} alt="" /> : <span className="cover">No cover</span>}
        <span className="row-progress"><span style={{ width: `${Math.round(frac * 100)}%` }} /></span>
      </span>
      <span className="row-text">
        <span className="row-title">{book.metadata.title}</span>
        <span className="row-author">{book.metadata.author || 'Unknown author'}</span>
      </span>
    </button>
  )
}

// Grid view (reference screenshot 2): cover, with title + author under it,
// small and muted so the cover stays the focus.
function BookGridCard({ book, onOpen }) {
  const cover = coverFor(book)
  return (
    <button className="book-grid" onClick={() => onOpen(book)} aria-label={book.metadata.title}>
      {cover ? <img src={cover} alt="" /> : <div className="cover">No cover</div>}
      <span className="book-grid-title">{book.metadata.title}</span>
      <span className="book-grid-author">{book.metadata.author || 'Unknown author'}</span>
    </button>
  )
}

export default function App() {
  const [books, setBooks] = useState([])
  const [view, setView] = useState('library') // library | detail | reader | fixes | pdf | comic | audio | readalong
  const [selected, setSelected] = useState(null)
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState('series')
  const [formatTab, setFormatTab] = useState(() => { try { return localStorage.getItem('shelfsort-format-tab') || 'all' } catch { return 'all' } })
  useEffect(() => { try { localStorage.setItem('shelfsort-format-tab', formatTab) } catch { /* ignore */ } }, [formatTab])
  // Bottom tabs: Books = EPUB + PDF, Comics = CBZ/CBR, Audiobooks = M4B/MP3.
  function matchesFormatTab(b) {
    if (formatTab === 'books') return b.format === 'epub' || b.format === 'pdf'
    if (formatTab === 'comics') return b.format === 'comic'
    if (formatTab === 'audiobooks') return b.format === 'audio'
    return true
  }
  const [viewMode, setViewMode] = useState(() => { try { return localStorage.getItem('shelfsort-view') || 'list' } catch { return 'list' } })
  const [statusTab, setStatusTab] = useState('all')
  const [searchOpen, setSearchOpen] = useState(false)
  const [seriesDetail, setSeriesDetail] = useState(null)
  // Files for books currently OPEN only (0-2 books). The library list
  // itself is metadata-only, so 300 books never means 300 blobs in RAM.
  const [openFiles, setOpenFiles] = useState({})
  useEffect(() => { try { localStorage.setItem('shelfsort-view', viewMode) } catch { /* ignore */ } }, [viewMode])
  // Release open files whenever we leave a viewer/detail screen.
  useEffect(() => {
    if (['library', 'series', 'series-detail', 'unsorted', 'settings', 'cloud', 'fixes'].includes(view)) setOpenFiles({})
  }, [view])
  function withFile(meta) { return meta ? { ...meta, file: openFiles[meta.id] } : null }
  const [importStatus, setImportStatus] = useState('')
  const [importErrors, setImportErrors] = useState([])
  const [drag, setDrag] = useState(false)
  const [proposals, setProposals] = useState([])
  const [enriching, setEnriching] = useState(false)
  const [enrichStatus, setEnrichStatus] = useState('')
  // Auto-apply high-confidence fixes (only ask when unsure).
  // Default ON; turning it off restores ask-every-time behaviour.
  const [autoApplyHigh, setAutoApplyHigh] = useState(() => {
    try { return localStorage.getItem('shelfsort-auto-apply-high') !== 'off' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('shelfsort-auto-apply-high', autoApplyHigh ? 'on' : 'off') } catch { /* ignore */ }
  }, [autoApplyHigh])
  // Concise summary of the last Find Fixes run's auto-applied fixes.
  const [autoFixedSummary, setAutoFixedSummary] = useState([])
  const [edits, setEdits] = useState({})
  const [chapters, setChapters] = useState([])
  const [chapterIndex, setChapterIndex] = useState(0)
  const [fontSize, setFontSize] = useState(18)
  const [readerTheme, setReaderTheme] = useState('light')
  const [readerSearch, setReaderSearch] = useState('')
  const [readerHits, setReaderHits] = useState([])
  const [exporting, setExporting] = useState(false)
  // EPUB pagination (page-turn, not scroll). pageCount is measured
  // from the CSS-column layout (see the repaginate effect below);
  // pageIndexRef mirrors pageIndex without re-running that effect.
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const pageRef = useRef(null)
  const pageIndexRef = useRef(0)
  const pageCountRef = useRef(1)
  const pagePendingRef = useRef(null) // 'last' | fraction 0..1 | null
  const prevReaderFontRef = useRef(fontSize)
  const prevReaderChapterRef = useRef(0)
  // Pull-to-refresh (library + series views only).
  const [pullDist, setPullDist] = useState(0)
  const [ptrRefreshing, setPtrRefreshing] = useState(false)
  const ptrStartY = useRef(null)
  const pullDistRef = useRef(0)
  // App-wide light/dark mode: persisted, system preference on first load.
  const [appTheme, setAppTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('shelfsort-theme')
      if (saved === 'light' || saved === 'dark') return saved
    } catch { /* ignore */ }
    return 'dark'
  })
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', appTheme)
    try { localStorage.setItem('shelfsort-theme', appTheme) } catch { /* ignore */ }
  }, [appTheme])

  // ---- Cloud / R2 ------------------------------------------------------
  // Credentials live only in this browser (localStorage, via r2.js).
  // They are never in the repo, never logged, and only sent to the
  // configured R2 endpoint. Until they are entered, R2 features are
  // hidden/disabled gracefully and the library works exactly as before.
  const [r2Settings, setR2Settings] = useState(() => loadR2Settings())
  const [r2Form, setR2Form] = useState(() => loadR2Settings() || { accountId: '', bucket: '', accessKeyId: '', secretAccessKey: '', endpoint: '' })
  const [cloudMsg, setCloudMsg] = useState('')
  const [cloudProgress, setCloudProgress] = useState('')
  const [cloudBusy, setCloudBusy] = useState(false)
  const [syncObjects, setSyncObjects] = useState([])
  const [syncMsg, setSyncMsg] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [corsCopied, setCorsCopied] = useState(false)

  const fileRef = useRef(null)
  const folderRef = useRef(null)

  // Metadata only — this is the fix for the 300-book crash/empty-library
  // cycle: loading the library must NEVER pull 300 file blobs into RAM.
  async function reload() {
    const all = await getAllBooksMeta()
    setBooks(all)
    return all
  }
  useEffect(() => { reload().catch(() => {}) }, [])
  useEffect(() => { if (folderRef.current) folderRef.current.setAttribute('webkitdirectory', '') }, [])

  // ---- Import ---------------------------------------------------------
  async function parseByFormat(file, buf) {
    const name = file.name
    if (/\.epub$/i.test(name)) {
      return { format: 'epub', metadata: await parseEpub(buf, name), extra: {} }
    }
    if (/\.pdf$/i.test(name)) {
      return { format: 'pdf', metadata: await parsePdf(buf, name), extra: {} }
    }
    if (/\.cbz$/i.test(name)) {
      return { format: 'comic', metadata: await parseCbz(buf, name), extra: {} }
    }
    if (/\.cbr$/i.test(name)) {
      // RAR cannot be opened in this browser build — detected, not faked.
      const clean = name.replace(/\.cbr$/i, '').replace(/[_-]+/g, ' ').trim()
      return { format: 'comic', metadata: { title: clean, titleFromFilename: true, author: '', creators: [], language: '', publisher: '', date: '', description: '', identifier: '', isbn: '', series: '', seriesIndex: '', coverDataUrl: '', pageCount: 0 }, extra: { cbrUnsupported: true } }
    }
    if (/\.m4b$/i.test(name)) {
      const parsed = parseAudio(buf, name)
      return { format: 'audio', metadata: { ...parsed, chapters: undefined }, extra: { audioChapters: parsed.chapters, durationSec: parsed.durationSec } }
    }
    if (/\.mp3$/i.test(name)) {
      const tags = parseMp3Tags(buf, name)
      return { format: 'audio', metadata: { title: tags.title, titleFromFilename: tags.titleFromFilename, author: tags.author, creators: tags.author ? [tags.author] : [], language: '', publisher: '', date: '', description: '', identifier: '', isbn: '', series: '', seriesIndex: '', coverDataUrl: '' }, extra: { audioChapters: [], durationSec: null } }
    }
    throw new Error('Unsupported file type')
  }

  async function importFiles(fileList) {
    const files = [...fileList].filter((f) => /\.(epub|pdf|cbz|cbr|m4b|mp3)$/i.test(f.name))
    if (!files.length) { setImportStatus('No supported files found (.epub, .pdf, .cbz, .cbr, .m4b, .mp3).'); return }
    setImportStatus(`Importing ${files.length} file(s)…`)
    setImportErrors([])
    const errors = []
    let imported = 0
    // One book at a time, committed immediately: meta + file are each
    // written before moving on, so a crash mid-import keeps everything
    // imported so far and the user can simply re-import the rest.
    // Only one file buffer is alive at a time; nothing is accumulated.
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer()
        const parsed = await parseByFormat(file, buf)
        const metadata = { ...parsed.metadata }
        if (parsed.extra.durationSec) metadata.durationSec = parsed.extra.durationSec
        const id = uid()
        const meta = {
          id,
          fileName: file.name,
          format: parsed.format,
          metadata,
          audioChapters: parsed.extra.audioChapters || [],
          cbrUnsupported: !!parsed.extra.cbrUnsupported,
          addedAt: Date.now(),
          progress: null,
          fixedFields: [],
          hasFile: true,
        }
        await putBookMeta(meta)
        await putBookFile(id, buf)
        imported++
        setImportStatus(`Imported ${imported} of ${files.length} — ${meta.metadata.title}`)
      } catch (e) {
        errors.push(`${file.name}: ${e.message}`)
      }
    }
    setImportErrors(errors)
    setImportStatus(`Done — imported ${imported} of ${files.length} file(s).${errors.length ? ` ${errors.length} failed (see below).` : ''}`)
    // Metadata only — never reload full file blobs after an import.
    await reload()
  }

  // ---- Enrichment / Fix Review ---------------------------------------
  // Shared writer for one book's fixes. When `auto` is true, the fix
  // is also recorded on the book (autoApplied) so the detail page
  // can show exactly what was auto-applied and when — and the user
  // can correct it with the manual edit form there.
  async function applyValuesToBook(book, values, autoInfo) {
    const updated = { ...book, metadata: { ...book.metadata }, fixedFields: [...(book.fixedFields || [])] }
    const appliedFields = []
    for (const [field, value] of Object.entries(values)) {
      if (field === 'coverUrl') {
        try {
          updated.metadata.coverDataUrl = await fetchAsDataUrl(value)
          updated.metadata.coverUrl = value
        } catch {
          updated.metadata.coverUrl = value
        }
        if (!updated.fixedFields.includes('cover')) updated.fixedFields.push('cover')
        appliedFields.push('cover')
      } else {
        updated.metadata[field] = value
        // A supplied title is a real title, not a filename fallback:
        // clear the filename-derived flag so the book can leave the
        // Unsorted shelf once author/cover/series are also present.
        if (field === 'title') updated.metadata.titleFromFilename = false
        if (!updated.fixedFields.includes(field)) updated.fixedFields.push(field)
        appliedFields.push(field)
      }
    }
    if (autoInfo && appliedFields.length) {
      updated.autoApplied = [...(book.autoApplied || []), {
        fields: appliedFields,
        source: autoInfo.source,
        confidenceReason: autoInfo.confidenceReason,
        appliedAt: Date.now(),
      }]
    }
    await putBookMeta(updated)
    return updated
  }

  async function runEnrichment(scope = 'all') {
    // Scoped by choice, never auto-run on import: 'unsorted' scans
    // only the Unsorted shelf; 'all' keeps the old whole-library
    // scan. Import itself never enriches — books arrive as-is.
    const scopeBooks = scope === 'unsorted' ? books.filter(isUnsorted) : [...books]
    if (!scopeBooks.length) {
      setEnrichStatus(scope === 'unsorted' ? 'Unsorted shelf is empty — nothing to fix.' : 'No books to check.')
      return
    }
    setEnriching(true)
    setEnrichStatus(`Checking ${scope === 'unsorted' ? 'Unsorted shelf' : 'all books'} for missing metadata…`)
    setProposals([])
    setAutoFixedSummary([])
    const review = []
    const autoSummary = []
    // Snapshot the library at run start: auto-applying mutates books,
    // so later lookups must not re-read the mutated state mid-run.
    const snapshot = scopeBooks
    for (let i = 0; i < snapshot.length; i++) {
      setEnrichStatus(`Checking ${i + 1} of ${snapshot.length}: ${snapshot[i].metadata.title}`)
      try {
        const result = await enrichBook(snapshot[i])
        if (!result) continue
        // High-confidence, auto-apply ON: apply immediately, no prompt.
        // The review-only remainder (e.g. a non-ISBN cover) still
        // goes to Fix Review, even for a high-confidence book.
        if (autoApplyHigh && Object.keys(result.autoProposals || {}).length) {
          const updated = await applyValuesToBook(snapshot[i], result.autoProposals, {
            source: result.source,
            confidenceReason: result.confidenceReason,
          })
          const fields = Object.keys(result.autoProposals).map((f) => (f === 'coverUrl' ? 'cover' : f))
          autoSummary.push({
            bookId: snapshot[i].id,
            title: updated.metadata.title || snapshot[i].metadata.title,
            fields,
            source: result.source,
            confidenceReason: result.confidenceReason,
          })
        }
        // Toggle OFF restores ask-every-time: the full proposal set,
        // including high-confidence fields, goes to Fix Review.
        const reviewFields = autoApplyHigh ? (result.reviewProposals || {}) : (result.proposals || {})
        if (Object.keys(reviewFields).length) {
          review.push({ ...result, proposals: reviewFields })
        }
      } catch { /* a failed lookup is not a failed book */ }
    }
    setProposals(review)
    const initial = {}
    for (const p of review) initial[p.bookId] = { ...p.proposals }
    setEdits(initial)
    setAutoFixedSummary(autoSummary)
    await reload()
    setEnriching(false)
    const autoPart = autoSummary.length
      ? `${autoSummary.length} book(s) auto-fixed (high confidence only — see below).`
      : ''
    const reviewPart = review.length
      ? `${review.length} book(s) need your review (uncertain fixes below).`
      : 'No uncertain fixes need review.'
    setEnrichStatus(
      (!autoSummary.length && !review.length)
        ? 'No fixes found. Your books may already be complete, or the sources had no match.'
        : `${autoPart} ${reviewPart}`.trim(),
    )
    setView('fixes')
  }

  async function applyProposal(bookId, values) {
    const book = books.find((b) => b.id === bookId)
    if (!book) return
    await applyValuesToBook(book, values, null)
    setProposals((prev) => prev.filter((p) => p.bookId !== bookId))
    await reload()
  }

  async function applyAllProposals() {
    for (const p of [...proposals]) {
      await applyProposal(p.bookId, edits[p.bookId] || p.proposals)
    }
  }

  // ---- Detail editing / linking ---------------------------------------
  async function saveDetailEdits(book, patch) {
    const updated = { ...book, metadata: { ...book.metadata, ...patch } }
    // A manually changed title is a real title, not a filename fallback.
    if (patch.title && patch.title !== book.metadata.title) updated.metadata.titleFromFilename = false
    await putBookMeta(updated)
    setSelected(updated)
    await reload()
  }

  async function linkBooks(epubBook, audioBook) {
    const epubUpdated = { ...epubBook, linkedAudioId: audioBook ? audioBook.id : null }
    await putBookMeta(epubUpdated)
    if (audioBook) {
      const audioUpdated = { ...audioBook, linkedEpubId: epubBook.id }
      await putBookMeta(audioUpdated)
    }
    setSelected(epubUpdated)
    await reload()
  }

  // ---- Cloud / R2 helpers -------------------------------------------
  function requireR2() {
    if (!r2Settings) throw new Error('R2 is not configured yet. Open Cloud / Settings and enter your Account ID, bucket, and API token keys first.')
    return r2Settings
  }

  // Download a Cloud-only book and store it locally again. Metadata,
  // cover, series, progress and links are untouched — only `file` changes.
  // Load a book's file blob on demand (one book, not the library).
  // Returns the ArrayBuffer and keeps it in openFiles until the view
  // leaves a viewer screen. Cloud-only books download from R2 first.
  async function ensureLocalFile(book) {
    if (openFiles[book.id]) return openFiles[book.id]
    if (book.hasFile) {
      const buf = await getBookFile(book.id)
      if (buf) { setOpenFiles((prev) => ({ ...prev, [book.id]: buf })); return buf }
      // hasFile said local, but the blob is gone: fall through to R2
      // if there is a cloud copy, otherwise fail honestly.
    }
    if (!book.r2Key) throw new Error('This book has no local file and no cloud copy.')
    const settings = requireR2()
    setCloudProgress(`Downloading ${book.metadata.title} from R2…`)
    try {
      const buf = await downloadFromR2(settings, book.r2Key, (p) => {
        if (p.total) setCloudProgress(`Downloading ${book.metadata.title}… ${p.pct}%`)
      })
      await putBookFile(book.id, buf)
      const updated = { ...book, hasFile: true }
      await putBookMeta(updated)
      setBooks((prev) => prev.map((b) => (b.id === book.id ? updated : b)))
      setSelected(updated)
      setOpenFiles((prev) => ({ ...prev, [book.id]: buf }))
      setCloudProgress('')
      return buf
    } catch (e) {
      setCloudProgress('')
      throw e
    }
  }

  // Back-compat wrapper used by the old detail/open paths: returns a
  // book object with its file attached, for viewers only.
  async function ensureLocal(book) {
    const buf = await ensureLocalFile(book)
    return { ...book, file: buf, hasFile: true }
  }

  async function uploadBook(book, force = false) {
    const settings = requireR2()
    if (book.r2Key && !force) return book
    if (!book.hasFile) throw new Error(`"${book.metadata.title}" has no local file to upload.`)
    const fileBuf = await ensureLocalFile(book)
    book = { ...book, file: fileBuf }
    const key = book.r2Key || r2KeyFor(book)
    setCloudProgress(`Uploading ${book.metadata.title}…`)
    const uploadedKey = await uploadToR2({ ...settings }, { ...book, r2Key: key }, (p) => {
      setCloudProgress(p.total ? `Uploading ${book.metadata.title}… ${p.pct}%` : `Uploading ${book.metadata.title}…`)
    })
    const { file: _f, ...updated } = { ...book, r2Key: uploadedKey }
    await putBookMeta(updated)
    setOpenFiles((prev) => { const next = { ...prev }; delete next[book.id]; return next })
    setCloudProgress('')
    return updated
  }

  async function clearLocalFor(book) {
    const settings = requireR2()
    if (!book.r2Key) throw new Error('This book is not in R2 yet — upload it first, so clearing local does not lose it.')
    if (!book.hasFile) return book
    // Verify the cloud copy actually exists before deleting the only
    // local copy. A failed verification aborts the clear, by design.
    const head = await headR2Object(settings, book.r2Key)
    if (!head.exists) throw new Error('R2 does not contain this book (HeadObject found nothing), so the local copy was NOT deleted.')
    await deleteBookFile(book.id)
    const updated = { ...book, hasFile: false }
    await putBookMeta(updated)
    setOpenFiles((prev) => { const next = { ...prev }; delete next[book.id]; return next })
    return updated
  }

  async function deleteFromCloudFor(book) {
    const settings = requireR2()
    if (!book.r2Key) return book
    await deleteFromR2(settings, book.r2Key)
    const updated = { ...book, r2Key: null }
    await putBookMeta(updated)
    return updated
  }

  function autoMatchFor(book) {
    if (book.format === 'epub') return findAudioMatch(book, books)
    if (book.format === 'audio') return findEpubMatch(book, books)
    return null
  }

  function linkedPairFor(book) {
    if (book.format === 'epub' && book.linkedAudioId) {
      const a = books.find((b) => b.id === book.linkedAudioId)
      return a ? { epub: book, audio: a } : null
    }
    if (book.format === 'audio' && book.linkedEpubId) {
      const e = books.find((b) => b.id === book.linkedEpubId)
      return e ? { epub: e, audio: book } : null
    }
    return null
  }

  // ---- Openers ---------------------------------------------------------
  async function openBook(book) {
    // Detail page needs metadata only — no file blob is loaded here.
    setSelected(book)
    setView('detail')
  }

  async function openReader(book) {
    let buf
    try { buf = await ensureLocalFile(book) } catch (e) { alert(`Could not open this book: ${e.message}`); return }
    setSelected(book)
    setChapters([])
    setReaderHits([])
    setReaderSearch('')
    const parsed = await parseChapters(buf)
    setChapters(parsed)
    const saved = book.progress || loadProgressLocal(book.id)
    setChapterIndex(saved && saved.chapterIndex < parsed.length ? saved.chapterIndex : 0)
    // Old progress records have only chapterIndex: they open at
    // page 1 of that chapter (page defaults to 0 below).
    const savedPage = saved && typeof saved.page === 'number' ? saved.page : 0
    pageIndexRef.current = savedPage
    setPageIndex(savedPage)
    setView('reader')
  }

  async function saveReaderPage(book, chapter, page, count, totalChapters) {
    const lastChapter = totalChapters ? chapter >= totalChapters - 1 : chapter >= (chapters.length - 1)
    const finished = lastChapter && count > 0 && page >= count - 1
      ? true
      : (chapter < (totalChapters || chapters.length) - 1 ? false : !!book.progress?.finished)
    const progress = {
      ...(book.progress || {}),
      chapterIndex: chapter,
      page,
      totalChapters: totalChapters || book.progress?.totalChapters || null,
      finished,
      at: Date.now(),
    }
    saveProgressLocal(book.id, progress)
    const updated = { ...book, progress }
    await putBookMeta(updated)
    setSelected(updated)
    setBooks((prev) => prev.map((b) => (b.id === book.id ? updated : b)))
  }

  async function goToChapter(book, index, totalChapters, page = 0) {
    setChapterIndex(index)
    pageIndexRef.current = page
    setPageIndex(page)
    const progress = {
      ...(book.progress || {}),
      chapterIndex: index,
      page,
      totalChapters: totalChapters || book.progress?.totalChapters || null,
      // Entering the last chapter does NOT finish the book — only
      // reaching its last page does (see saveReaderPage). Preserve
      // an existing finished flag so reopening a finished book does
      // not unfinish it; moving to an earlier chapter clears it.
      finished: totalChapters ? (index < totalChapters - 1 ? false : !!book.progress?.finished) : !!book.progress?.finished,
      at: Date.now(),
    }
    saveProgressLocal(book.id, progress)
    const updated = { ...book, progress }
    await putBookMeta(updated)
    setSelected(updated)
    setBooks((prev) => prev.map((b) => (b.id === book.id ? updated : b)))
  }

  // Page-turn navigation. Next on the last page of a chapter moves
  // to the next chapter's first page; previous on the first page
  // moves to the previous chapter's LAST page (via pagePendingRef,
  // applied once that chapter has been repaginated).
  function nextPage() {
    if (pageIndexRef.current < pageCountRef.current - 1) {
      const p = pageIndexRef.current + 1
      pageIndexRef.current = p
      setPageIndex(p)
      if (selected) saveReaderPage(selected, chapterIndex, p, pageCountRef.current, chapters.length)
    } else if (chapterIndex < chapters.length - 1) {
      pagePendingRef.current = null
      goToChapter(selected, chapterIndex + 1, chapters.length, 0)
    } else if (selected) {
      saveReaderPage(selected, chapterIndex, pageIndexRef.current, pageCountRef.current, chapters.length)
    }
  }

  function prevPage() {
    if (pageIndexRef.current > 0) {
      const p = pageIndexRef.current - 1
      pageIndexRef.current = p
      setPageIndex(p)
      if (selected) saveReaderPage(selected, chapterIndex, p, pageCountRef.current, chapters.length)
    } else if (chapterIndex > 0) {
      pagePendingRef.current = 'last'
      goToChapter(selected, chapterIndex - 1, chapters.length, 0)
    }
  }

  // Repaginate the current chapter after it renders, and whenever
  // the font size or viewport changes. The chapter content is laid
  // out in CSS columns (one column = one screen-sized page, see
  // styles.css .reader-column-flow); page count comes from the
  // measured scroll width, so it follows font size and viewport
  // instead of guessing from character counts.
  useEffect(() => {
    if (view !== 'reader' || !chapters.length) return
    let cancelled = false
    const measure = () => {
      if (cancelled) return
      const el = pageRef.current
      if (!el || !el.clientWidth) return
      const GAP = 32 // must match column-gap in styles.css
      const count = Math.max(1, Math.round((el.scrollWidth + GAP) / (el.clientWidth + GAP)))
      const fontChanged = prevReaderFontRef.current !== fontSize
      const chapterChanged = prevReaderChapterRef.current !== chapterIndex
      prevReaderFontRef.current = fontSize
      prevReaderChapterRef.current = chapterIndex
      let p = pageIndexRef.current
      if (pagePendingRef.current === 'last') p = count - 1
      else if (typeof pagePendingRef.current === 'number') p = Math.min(count - 1, Math.max(0, Math.floor(pagePendingRef.current * count)))
      else if (fontChanged && pageCountRef.current > 1) p = Math.min(count - 1, Math.max(0, Math.round((pageIndexRef.current / pageCountRef.current) * count)))
      else p = Math.min(count - 1, Math.max(0, p))
      pagePendingRef.current = null
      const oldCount = pageCountRef.current
      pageCountRef.current = count
      setPageCount(count)
      if (p !== pageIndexRef.current || count !== oldCount) {
        pageIndexRef.current = p
        setPageIndex(p)
        if (selected && (p !== (selected.progress?.page || 0) || chapterChanged)) {
          saveReaderPage(selected, chapterIndex, p, count, chapters.length)
        }
      }
    }
    const t1 = requestAnimationFrame(() => { const t2 = setTimeout(measure, 60); return t2 })
    const onResize = () => measure()
    window.addEventListener('resize', onResize)
    return () => { cancelled = true; cancelAnimationFrame(t1); window.removeEventListener('resize', onResize) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, chapterIndex, chapters, fontSize])

  // Tap / swipe page-turn on the page area. Tap left third = previous,
  // tap right third = next, middle = no-op (so text/links are not
  // hijacked). Swipe left = next, swipe right = previous.
  const readerTouch = useRef(null)
  function onReaderTouchStart(e) {
    const t = e.touches[0]
    readerTouch.current = { x: t.clientX, y: t.clientY }
  }
  function onReaderTouchEnd(e) {
    const s = readerTouch.current
    readerTouch.current = null
    if (!s) return
    const t = e.changedTouches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) nextPage()
      else prevPage()
    }
  }
  function onReaderClick(e) {
    if (e.target && e.target.closest && e.target.closest('a,button')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / Math.max(1, rect.width)
    if (frac < 0.3) prevPage()
    else if (frac > 0.7) nextPage()
  }

  // Pull-to-refresh: library + series + Unsorted views only, and only when the
  // page is already scrolled to the top, so normal vertical scrolling
  // is untouched. No preventDefault: the indicator follows the pull
  // and a release past the threshold reloads metadata from IndexedDB.
  function onPtrTouchStart(e) {
    if (!['library', 'series', 'series-detail', 'unsorted'].includes(view)) return
    if (window.scrollY > 0) return
    ptrStartY.current = e.touches[0].clientY
  }
  function onPtrTouchMove(e) {
    if (ptrStartY.current == null || ptrRefreshing) return
    const dy = e.touches[0].clientY - ptrStartY.current
    const d = dy > 0 ? Math.min(dy, 90) : 0
    pullDistRef.current = d
    setPullDist(d)
  }
  async function onPtrTouchEnd() {
    const d = pullDistRef.current
    ptrStartY.current = null
    pullDistRef.current = 0
    if (d >= 70 && !ptrRefreshing) {
      setPtrRefreshing(true)
      setPullDist(48)
      try { await reload() } catch { /* reload failure just ends the indicator */ }
      setPtrRefreshing(false)
    }
    setPullDist(0)
  }

  async function openViewer(book, targetView) {
    try { await ensureLocalFile(book) } catch (e) { alert(`Could not open this book: ${e.message}`); return }
    setSelected(book)
    setView(targetView)
  }

  async function openReadAlong(book) {
    const pair = linkedPairFor(book)
    if (!pair) { setView('readalong'); return }
    try {
      await ensureLocalFile(pair.epub)
      await ensureLocalFile(pair.audio)
      await reload()
      setSelected(pair.epub)
      setView('readalong')
    } catch (e) {
      alert(`Could not download the read-along pair: ${e.message}`)
    }
  }

  function searchInBook() {
    const q = readerSearch.trim().toLowerCase()
    if (!q) { setReaderHits([]); return }
    const hits = []
    chapters.forEach((ch, i) => {
      const idx = ch.text.toLowerCase().indexOf(q)
      if (idx >= 0) {
        // frac is a page estimate: columns fill in order, so the
        // character position within the chapter approximates the
        // page. The repaginate effect applies it once the target
        // chapter has been laid out (see pagePendingRef).
        hits.push({ chapter: i, title: ch.title, snippet: ch.text.slice(Math.max(0, idx - 60), idx + 120), frac: idx / Math.max(1, ch.text.length) })
      }
    })
    setReaderHits(hits)
  }

  async function exportBook(book) {
    setExporting(true)
    try {
      const buf = await ensureLocalFile(book)
      const blob = await buildCorrectedEpub({ ...book, file: buf }, book.metadata, book.metadata.coverDataUrl || '')
      const safe = (book.metadata.title || 'book').replace(/[\\/:*?"<>|]+/g, '').slice(0, 80)
      downloadBlob(blob, `${safe} - fixed.epub`)
    } catch (e) {
      alert(`Export failed: ${e.message}`)
    } finally {
      setExporting(false)
    }
  }

  // ---- Library view model ----------------------------------------------
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = books.filter(matchesFormatTab)
    if (statusTab !== 'all') list = list.filter((b) => statusOf(b) === statusTab)
    if (q) {
      list = list.filter((b) => {
        const s = getSeries(b)
        return [b.metadata.title, b.metadata.author, s.name, b.fileName].join(' ').toLowerCase().includes(q)
      })
    }
    return sortBooks(list, sortMode)
  }, [books, search, sortMode, formatTab])

  const groups = useMemo(() => (sortMode === 'series' ? groupBySeries(filtered) : null), [filtered, sortMode])
  const seriesBase = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = books.filter(matchesFormatTab)
    if (q) list = list.filter((b) => [b.metadata.title, b.metadata.author, getSeries(b).name, b.fileName].join(' ').toLowerCase().includes(q))
    return list
  }, [books, search, formatTab])
  const seriesGroups = useMemo(() => groupBySeries(seriesBase), [seriesBase])
  const headerTitle = view === 'series' || view === 'series-detail' ? 'Series' : view === 'unsorted' ? 'Unsorted' : view === 'settings' ? 'Settings' : view === 'cloud' ? 'Cloud' : view === 'fixes' ? 'Fix Review' : 'Library'
  const detail = selected && books.find((b) => b.id === selected.id)
  const detailPair = detail ? linkedPairFor(detail) : null
  const detailAuto = detail ? autoMatchFor(detail) : null

  return (
    <>
      <header className="topbar">
        <h1>{headerTitle}</h1>
        <div className="topbar-actions">
          <button className="icon-btn" onClick={() => setSearchOpen(!searchOpen)} aria-label="Search">🔍</button>
          {view === 'library' && (
            <button className="icon-btn" onClick={() => setViewMode(viewMode === 'list' ? 'grid' : 'list')} aria-label="Toggle list/grid view">
              {viewMode === 'list' ? '▦' : '☰'}
            </button>
          )}
          <button className="icon-btn" onClick={() => setView('settings')} aria-label="Settings">⋮</button>
        </div>
        <nav className="topnav">
          <button className={view === 'library' ? 'active' : ''} onClick={() => setView('library')}>Library</button>
          <button className={view === 'series' || view === 'series-detail' ? 'active' : ''} onClick={() => setView('series')}>Series</button>
          <button className={view === 'unsorted' ? 'active' : ''} onClick={() => setView('unsorted')}>Unsorted{books.filter(isUnsorted).length ? ` (${books.filter(isUnsorted).length})` : ''}</button>
          <button className={view === 'settings' || view === 'cloud' ? 'active' : ''} onClick={() => setView('settings')}>Settings</button>
        </nav>
        {searchOpen && (
          <input className="top-search" type="search" placeholder="Search title, author, or series…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        )}
      </header>

      <main onTouchStart={onPtrTouchStart} onTouchMove={onPtrTouchMove} onTouchEnd={onPtrTouchEnd}>
        {['library', 'series', 'series-detail', 'unsorted'].includes(view) && (pullDist > 0 || ptrRefreshing) && (
          <div className="ptr" style={{ height: ptrRefreshing ? 48 : pullDist }}>
            {ptrRefreshing ? 'Refreshing…' : (pullDist >= 70 ? 'Release to refresh' : 'Pull to refresh')}
          </div>
        )}
        {view === 'library' && (
          <>
            <div className="status-tabs" role="tablist">
              {['all', 'new', 'started', 'finished'].map((t) => (
                <button key={t} className={statusTab === t ? 'active' : ''} onClick={() => setStatusTab(t)}>
                  {t === 'all' ? 'ALL' : t.toUpperCase()}
                </button>
              ))}
            </div>

            <div
              className={`dropzone ${drag ? 'drag' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); importFiles(e.dataTransfer.files) }}
            >
              <p><strong>Drop files or a folder here</strong>, or use the buttons below.</p>
              <p className="progress">EPUB, PDF, CBZ, CBR, M4B, MP3 — imported one book at a time, each saved as soon as it is read, so an interrupted import keeps what finished.</p>
              <div className="toolbar" style={{ justifyContent: 'center' }}>
                <button onClick={() => fileRef.current.click()}>Choose files</button>
                <button className="secondary" onClick={() => folderRef.current.click()}>Choose a folder</button>
              </div>
              <input ref={fileRef} type="file" accept=".epub,.pdf,.cbz,.cbr,.m4b,.mp3" multiple hidden onChange={(e) => importFiles(e.target.files)} />
              <input ref={folderRef} type="file" accept=".epub,.pdf,.cbz,.cbr,.m4b,.mp3" multiple hidden
                onChange={(e) => importFiles(e.target.files)} />
              <p className="progress">{importStatus}</p>
              {importErrors.length > 0 && (
                <div className="error">
                  {importErrors.map((err, i) => <div key={i}>{err}</div>)}
                </div>
              )}
            </div>

            {cloudMsg && <p className="progress">{cloudMsg}</p>}
            {cloudProgress && <p className="progress">{cloudProgress}</p>}
            <div className="toolbar">
              <select value={sortMode} onChange={(e) => setSortMode(e.target.value)} aria-label="Sort">
                <option value="series">Sort: Series</option>
                <option value="author">Sort: Author</option>
                <option value="title">Sort: Title</option>
                <option value="date">Sort: Publication date</option>
                <option value="recent">Sort: Recently added</option>
              </select>
              <span className="progress">{filtered.length} book{filtered.length === 1 ? '' : 's'}</span>
            </div>

            {!books.length ? (
              <div className="card">
                <h2>No books yet</h2>
                <p>Pick files or a folder above to start. ShelfSort reads each book's own metadata first, then can look up anything missing.</p>
                <div className="notice">
                  <strong>About Android storage:</strong> Android does not let an app silently scan your whole phone.
                  On Android, use the folder picker to grant ShelfSort access to the folder your books live in.
                  This is a personal app — there is no Play Store goal, and your books stay in this browser/app's storage.
                </div>
              </div>
            ) : !filtered.length ? (
              <div className="card"><p>No books match this filter.</p></div>
            ) : viewMode === 'grid' ? (
              <div className="book-grid-wrap">
                {filtered.map((b) => <BookGridCard key={b.id} book={b} onOpen={openBook} />)}
              </div>
            ) : (
              <div className="book-list">
                {filtered.map((b) => <BookRow key={b.id} book={b} onOpen={openBook} />)}
              </div>
            )}
          </>
        )}

        {view === 'series' && (
          <div className="series-list">
            {!seriesGroups.filter((g) => g.key !== 'standalone').length && <div className="card"><p>No series yet — series come from a book's own metadata, its title, or a manual edit on its detail page.</p></div>}
            {seriesGroups.filter((g) => g.key !== 'standalone').map((g) => (
              <button key={g.key} className="series-row" onClick={() => { setSeriesDetail(g); setView('series-detail') }}>
                <span className="series-tag">🏷</span>
                <span className="series-name">{g.name}</span>
                <span className="series-count">{g.books.length}</span>
              </button>
            ))}
            {seriesGroups.filter((g) => g.key === 'standalone').map((g) => (
              <button key={g.key} className="series-row" onClick={() => { setSeriesDetail(g); setView('series-detail') }}>
                <span className="series-tag">🏷</span>
                <span className="series-name">Standalone</span>
                <span className="series-count">{g.books.length}</span>
              </button>
            ))}
          </div>
        )}

        {view === 'series-detail' && seriesDetail && (
          <div>
            <button className="secondary" onClick={() => setView('series')}>← Back to Series</button>
            <h2>{seriesDetail.name}</h2>
            {seriesDetail.gaps.length > 0 && (
              <p className="gap">⚠️ Missing in this series: {seriesDetail.gaps.map((n) => `#${n}`).join(', ')} — you own {seriesDetail.books.map((b) => getSeries(b).index).filter((n) => n !== null).join(', ')}.</p>
            )}
            <div className="book-list">
              {seriesDetail.books.map((b) => <BookRow key={b.id} book={b} onOpen={openBook} />)}
            </div>
          </div>
        )}

        {view === 'unsorted' && (
          <div>
            <h2>🧺 Unsorted ({books.filter(isUnsorted).length})</h2>
            <p className="progress">
              Books that could not be sorted confidently: no series, and the author is missing, the cover is missing, or the title came from the filename because the file had no title metadata.
              Standalone books with a real title, author and cover are not here. Import never fixes anything — fix these by choice, below.
              A book leaves this shelf automatically once it has author + cover + series (or a real title + author + cover).
            </p>
            <div className="toolbar">
              <button onClick={() => runEnrichment('unsorted')} disabled={enriching || !books.filter(isUnsorted).length}>
                {enriching ? 'Checking…' : `Scan Unsorted shelf (${books.filter(isUnsorted).length})`}
              </button>
              <button className="secondary" onClick={() => setView('library')}>← Back to library</button>
            </div>
            {enrichStatus && <p className="progress">{enrichStatus}</p>}
            {!books.filter(isUnsorted).filter(matchesFormatTab).length ? (
              <div className="card"><p>Unsorted shelf is empty{formatTab !== 'all' ? ' for this bottom tab — try All' : ''}. Every book in the library has a series, or a real title + author + cover.</p></div>
            ) : (
              <div className="book-list">
                {books.filter(isUnsorted).filter(matchesFormatTab).map((b) => <BookRow key={b.id} book={b} onOpen={openBook} />)}
              </div>
            )}
          </div>
        )}

        {view === 'settings' && (
          <div>
            <div className="card">
              <h2>Appearance</h2>
              <button className="secondary" onClick={() => setAppTheme(appTheme === 'dark' ? 'light' : 'dark')}>
                {appTheme === 'dark' ? '☀️ Switch to light mode' : '🌙 Switch to dark mode'}
              </button>
              <p className="progress">Library view: {viewMode === 'list' ? 'List' : 'Grid'} — toggle it from the top bar in the Library.</p>
            </div>
            <div className="card">
              <h2>Metadata fixes</h2>
              <p className="progress">Import first, fix second — by choice. Import never runs enrichment. Scan the Unsorted shelf (default) or the whole library.</p>
              <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={autoApplyHigh} onChange={(e) => setAutoApplyHigh(e.target.checked)} />
                Auto-apply high-confidence fixes (only ask when unsure)
              </label>
              <div className="toolbar">
                <button onClick={() => runEnrichment('unsorted')} disabled={enriching || !books.filter(isUnsorted).length}>
                  {enriching ? 'Checking…' : `Scan Unsorted shelf (${books.filter(isUnsorted).length})`}
                </button>
                <button className="secondary" onClick={() => runEnrichment('all')} disabled={enriching || !books.length}>
                  {enriching ? 'Checking…' : 'Find fixes (all books)'}
                </button>
              </div>
              {enrichStatus && <p className="progress">{enrichStatus}</p>}
              <p className="progress">High confidence means an ISBN match to the same edition, or an exact title + author match with a single result. Everything uncertain goes to Fix Review.</p>
            </div>
            <div className="card">
              <h2>Cloud shelf</h2>
              <p className="progress">Keep the catalog on your phone and the big files in your private Cloudflare R2 bucket, or clear local copies after upload.</p>
              <button className="secondary" onClick={() => setView('cloud')}>☁️ Cloud / Settings</button>
            </div>
            <div className="card">
              <h2>Library</h2>
              <p className="progress">{books.length} book{books.length === 1 ? '' : 's'} in the library. The library list loads metadata only — book files are loaded one at a time when you open a book, so even 300 EPUBs stay stable.</p>
              <button className="secondary" onClick={async () => { if (confirm('Remove all books from ShelfSort? Files on your phone are not deleted.')) { await clearLibrary(); await reload() } }}>
                Clear library
              </button>
            </div>
          </div>
        )}

        {view === 'detail' && detail && (
          <div className="card">
            <button className="secondary" onClick={() => setView('library')}>← Back to library</button>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
              {coverFor(detail) ? <img src={coverFor(detail)} alt="" style={{ width: 160, borderRadius: 8 }} /> : <div className="cover" style={{ width: 160 }}>No cover</div>}
              <div style={{ flex: 1, minWidth: 240 }}>
                <h2>{detail.metadata.title}</h2>
                <p>{detail.metadata.author || 'Unknown author'} · {formatLabel(detail)}</p>
                <p>Publisher: {detail.metadata.publisher || '—'} · Date: {detail.metadata.date || '—'} · ISBN: {detail.metadata.isbn || '—'}</p>
                <p>Series: {detail.metadata.series || getSeries(detail).name || '—'} {detail.metadata.seriesIndex ? `#${detail.metadata.seriesIndex}` : ''}</p>
                <p>{detail.metadata.description || 'No description in this file.'}</p>
                <p>☁️ Cloud: {cloudStatusLabel(detail)}{detail.r2Key ? ` · ${detail.r2Key}` : ''}</p>
                {detail.autoApplied && detail.autoApplied.length > 0 && (
                  <div className="notice">
                    <strong>Auto-fixed (high confidence only):</strong>
                    {detail.autoApplied.map((a, i) => (
                      <div key={i}>✓ {a.fields.join(', ')} — {a.source} ({a.confidenceReason}){a.appliedAt ? ` · ${new Date(a.appliedAt).toLocaleDateString()}` : ''}</div>
                    ))}
                    <div className="progress">If any of these are wrong, correct them with “Edit metadata” below — auto-apply is never irreversible.</div>
                  </div>
                )}
                {cloudProgress && <p className="progress">{cloudProgress}</p>}
                {cloudMsg && <p className="progress">{cloudMsg}</p>}
                <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0' }}>
                  <input type="checkbox" checked={!!detail.progress?.finished} onChange={async (e) => {
                    const progress = { ...(detail.progress || {}), finished: e.target.checked, at: Date.now() }
                    const updated = { ...detail, progress }
                    await putBookMeta(updated); setSelected(updated); await reload()
                  }} />
                  Finished
                </label>
                <p className="progress">Status: {statusOf(detail)} · {detail.hasFile ? '📱 Local' : 'No local file'}{detail.r2Key ? ' · ☁️ In R2' : ''}</p>
                <div className="toolbar">
                  {!r2Settings && <button className="secondary" onClick={() => setView('cloud')}>Set up Cloud / R2</button>}
                  {r2Settings && detail.hasFile && !detail.r2Key && <button className="secondary" onClick={async () => { try { const u = await uploadBook(detail); setSelected(u); await reload(); setCloudMsg(`Uploaded "${detail.metadata.title}" to R2.`) } catch (e) { setCloudMsg(`Upload failed: ${friendlyR2Error(e)}`) } }}>☁️ Upload to R2</button>}
                  {r2Settings && detail.hasFile && detail.r2Key && <button className="secondary" onClick={async () => { try { const u = await uploadBook(detail, true); setSelected(u); await reload(); setCloudMsg(`Re-uploaded "${detail.metadata.title}" to R2.`) } catch (e) { setCloudMsg(`Upload failed: ${friendlyR2Error(e)}`) } }}>☁️ Re-upload to R2</button>}
                  {r2Settings && detail.hasFile && detail.r2Key && <button className="secondary" onClick={async () => { try { const u = await clearLocalFor(detail); setSelected(u); await reload(); setCloudMsg(`Local copy cleared for "${detail.metadata.title}". Metadata, cover, series and progress are kept; open it anytime to download it again.`) } catch (e) { setCloudMsg(`Clear local failed: ${friendlyR2Error(e)}`) } }}>🧹 Clear local (keep in R2)</button>}
                  {r2Settings && !detail.hasFile && detail.r2Key && <button onClick={() => openBook(detail)}>☁️ Download from R2 & open</button>}
                  {r2Settings && detail.r2Key && <button className="secondary" onClick={async () => { if (!confirm(`Delete "${detail.metadata.title}" from R2? The local copy (if any) is kept, but the cloud copy will be gone.`)) return; try { const u = await deleteFromCloudFor(detail); setSelected(u); await reload(); setCloudMsg(`Deleted "${detail.metadata.title}" from R2.`) } catch (e) { setCloudMsg(`Delete from cloud failed: ${friendlyR2Error(e)}`) } }}>🗑️ Delete from R2</button>}
                </div>
                {detail.cbrUnsupported && (
                  <div className="error">
                    <strong>CBR cannot be opened yet.</strong> CBR is a RAR archive, not a zip, and there is no reliable browser RAR unpacker bundled here.
                    Convert it to CBZ (a zip of images) — for example with 7-Zip, or in Calibre — then import the CBZ instead. This file is kept in your library so you can find it, but it will not open as a comic.
                  </div>
                )}
                {detail.format === 'audio' && (
                  <p>Duration: {detail.metadata.durationSec ? formatTime(detail.metadata.durationSec) : 'Unknown'} · Chapters: {detail.audioChapters && detail.audioChapters.length ? detail.audioChapters.length : 'None embedded — bookmarks work instead'}</p>
                )}
                {detailPair ? (
                  <p>🎧 Read-along linked to: <strong>{detailPair.audio.metadata.title}</strong> / <strong>{detailPair.epub.metadata.title}</strong></p>
                ) : detailAuto ? (
                  <p>🎧 Suggested read-along match: <strong>{detailAuto.book.metadata.title}</strong> (score {detailAuto.score}) — <button className="secondary" onClick={() => {
                    if (detail.format === 'epub') linkBooks(detail, detailAuto.book)
                    else linkBooks(detailAuto.book, detail)
                  }}>Link for read-along</button></p>
                ) : null}
                <div className="toolbar">
                  {detail.format === 'epub' && <button onClick={() => openReader(detail)}>Read</button>}
                  {detail.format === 'epub' && detailPair && <button className="secondary" onClick={() => openReadAlong(detail)}>🎧 Read along</button>}
                  {detail.format === 'pdf' && <button onClick={() => openViewer(detail, 'pdf')}>Open PDF</button>}
                  {detail.format === 'comic' && !detail.cbrUnsupported && <button onClick={() => openViewer(detail, 'comic')}>Open comic</button>}
                  {detail.format === 'audio' && <button onClick={() => openViewer(detail, 'audio')}>Play audiobook</button>}
                  {detail.format === 'audio' && detailPair && <button className="secondary" onClick={() => openReadAlong(detail)}>🎧 Read along</button>}
                  {detail.format === 'epub' && <button className="secondary" onClick={() => exportBook(detail)} disabled={exporting}>{exporting ? 'Exporting…' : 'Download corrected EPUB'}</button>}
                  <button className="secondary" onClick={async () => { if (confirm('Remove this book from ShelfSort?')) { await deleteBook(detail.id); setView('library'); await reload() } }}>Remove</button>
                </div>
                {(detail.format === 'epub' || detail.format === 'audio') && (
                  <div className="field">
                    <label>Manually link for read-along</label>
                    <select
                      value={detail.format === 'epub' ? (detail.linkedAudioId || '') : (detail.linkedEpubId || '')}
                      onChange={(e) => {
                        const targetId = e.target.value
                        if (!targetId) {
                          if (detail.format === 'epub') linkBooks(detail, null)
                          else {
                            const epub = books.find((b) => b.id === detail.linkedEpubId)
                            if (epub) linkBooks(epub, null)
                          }
                          return
                        }
                        const target = books.find((b) => b.id === targetId)
                        if (target) {
                          if (detail.format === 'epub') linkBooks(detail, target)
                          else linkBooks(target, detail)
                        }
                      }}
                    >
                      <option value="">No read-along link</option>
                      {(detail.format === 'epub' ? books.filter((b) => b.format === 'audio') : books.filter((b) => b.format === 'epub')).map((b) => (
                        <option key={b.id} value={b.id}>{b.metadata.title}</option>
                      ))}
                    </select>
                    <p className="progress">Read-along sync is chapter-level, not word-by-word — see the read-along screen for what that means.</p>
                  </div>
                )}
              </div>
            </div>
            <h3>Edit metadata (manual fix)</h3>
            <p className="progress">Edits are saved to your library immediately.{detail.format === 'epub' ? ' Use “Download corrected EPUB” to write them back into a new EPUB file.' : ''}</p>
            <DetailForm book={detail} onSave={saveDetailEdits} />
          </div>
        )}

        {view === 'cloud' && (
          <CloudView
            books={books}
            r2Settings={r2Settings}
            r2Form={r2Form}
            setR2Form={setR2Form}
            showSecret={showSecret}
            setShowSecret={setShowSecret}
            cloudMsg={cloudMsg}
            cloudProgress={cloudProgress}
            cloudBusy={cloudBusy}
            syncObjects={syncObjects}
            syncMsg={syncMsg}
            corsCopied={corsCopied}
            onBack={() => setView('library')}
            onSaveSettings={(form) => { saveR2Settings(form); setR2Settings(form); setCloudMsg('R2 settings saved in this browser only. They are not in the repo and are never sent anywhere except to your R2 endpoint.') }}
            onClearSettings={() => { clearR2Settings(); setR2Settings(null); setR2Form({ accountId: '', bucket: '', accessKeyId: '', secretAccessKey: '', endpoint: '' }); setCloudMsg('R2 credentials cleared from this browser.') }}
            onTest={async () => {
              setCloudBusy(true); setCloudMsg('Testing connection…')
              try { await testR2Connection(r2Form); setCloudMsg('✓ Connection works — R2 responded to a list request for this bucket.') }
              catch (e) { setCloudMsg(`✗ Connection failed: ${friendlyR2Error(e)}`) }
              finally { setCloudBusy(false) }
            }}
            onCopyCors={async () => {
              try { await navigator.clipboard.writeText(R2_CORS_JSON); setCorsCopied(true); setTimeout(() => setCorsCopied(false), 3000) }
              catch { setCloudMsg('Could not copy automatically — select the CORS JSON below and copy it manually.') }
            }}
            onUploadAll={async () => {
              if (!r2Settings) { setCloudMsg('Enter and save your R2 settings first.'); return }
              setCloudBusy(true)
              const pending = books.filter((b) => b.hasFile && !b.r2Key)
              let ok = 0; const errs = []
              for (let i = 0; i < pending.length; i++) {
                setCloudMsg(`Uploading ${i + 1} of ${pending.length}: ${pending[i].metadata.title}`)
                try { const u = await uploadBook(pending[i]); await reload(); if (u.r2Key) ok++ } catch (e) { errs.push(`${pending[i].metadata.title}: ${friendlyR2Error(e)}`) }
              }
              setCloudMsg(`Upload all done: ${ok} uploaded, ${errs.length} failed.${errs.length ? ' ' + errs.join(' | ') : ''}`)
              setCloudBusy(false)
            }}
            onClearAllLocal={async () => {
              if (!r2Settings) { setCloudMsg('Enter and save your R2 settings first.'); return }
              if (!confirm('Clear local copies for every book that is safely in R2? Metadata, covers, series and progress stay in the library; files can be downloaded again on demand.')) return
              setCloudBusy(true)
              let ok = 0; const errs = []
              for (const b of books.filter((x) => x.hasFile && x.r2Key)) {
                try { await clearLocalFor(b); ok++ } catch (e) { errs.push(`${b.metadata.title}: ${friendlyR2Error(e)}`) }
              }
              await reload()
              setCloudMsg(`Cleared local copies for ${ok} book(s).${errs.length ? ` ${errs.length} skipped: ${errs.join(' | ')}` : ''}`)
              setCloudBusy(false)
            }}
            onSync={async () => {
              if (!r2Settings) { setSyncMsg('Enter and save your R2 settings first.'); return }
              setSyncMsg('Listing R2 objects…')
              try {
                const objs = await listR2Objects(r2Settings)
                setSyncObjects(objs)
                const known = new Set(books.map((b) => b.r2Key).filter(Boolean))
                const unknown = objs.filter((o) => !known.has(o.key))
                setSyncMsg(`Found ${objs.length} object(s) in R2, ${unknown.length} not in this library.`)
              } catch (e) { setSyncMsg(`Sync failed: ${friendlyR2Error(e)}`) }
            }}
            onImportCloudObject={async (obj) => {
              const id = idFromR2Key(obj.key)
              const existing = id ? books.find((b) => b.id === id) : null
              if (existing) { setSyncMsg(`"${existing.metadata.title}" is already in the library.`); return }
              const ext = obj.key.split('.').pop().toLowerCase()
              const format = ext === 'pdf' ? 'pdf' : (ext === 'cbz' || ext === 'cbr' ? 'comic' : (ext === 'm4b' || ext === 'mp3' ? 'audio' : 'epub'))
              const book = {
                id: id || uid(),
                fileName: obj.key.split('/').pop(),
                hasFile: false,
                format,
                metadata: { title: titleFromR2Key(obj.key), titleFromFilename: true, author: '', creators: [], language: '', publisher: '', date: '', description: '', identifier: '', isbn: '', series: '', seriesIndex: '', coverDataUrl: '', pageCount: 0 },
                audioChapters: [],
                cbrUnsupported: ext === 'cbr',
                addedAt: Date.now(),
                progress: null,
                fixedFields: [],
                r2Key: obj.key,
              }
              await putBookMeta(book)
              await reload()
              setSyncMsg(`Added "${book.metadata.title}" as Cloud only. Open it to download it, then its real metadata/cover will be parsed on import — or download it and re-import locally for full metadata.`)
            }}
            onDownloadBook={async (book) => {
              try { await ensureLocal(book); setOpenFiles((prev) => { const next = { ...prev }; delete next[book.id]; return next }); setCloudMsg(`Downloaded "${book.metadata.title}" — it is now local again.`) } catch (e) { setCloudMsg(`Download failed: ${friendlyR2Error(e)}`) }
            }}
            onUploadBook={async (book) => {
              try { await uploadBook(book); await reload(); setCloudMsg(`Uploaded "${book.metadata.title}" to R2.`) } catch (e) { setCloudMsg(`Upload failed: ${friendlyR2Error(e)}`) }
            }}
            onClearLocalBook={async (book) => {
              try { await clearLocalFor(book); await reload(); setCloudMsg(`Local copy cleared for "${book.metadata.title}".`) } catch (e) { setCloudMsg(`Clear local failed: ${friendlyR2Error(e)}`) }
            }}
          />
        )}

        {view === 'fixes' && (
          <div>
            <button className="secondary" onClick={() => setView('library')}>← Back to library</button>
            <h2>Fix Review</h2>
            <p>{enrichStatus}</p>
            <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={autoApplyHigh} onChange={(e) => setAutoApplyHigh(e.target.checked)} />
              Auto-apply high-confidence fixes (only ask when unsure) — turn off to ask every time
            </label>
            {autoFixedSummary.length > 0 && (
              <div className="card">
                <h3>✓ Auto-fixed (high confidence only)</h3>
                <p className="progress">These were applied immediately, without a prompt, because they met the high-confidence rule. Anything uncertain is in the review list below. If an auto-fix is wrong, open the book's detail page and correct it with “Edit metadata”.</p>
                {autoFixedSummary.map((a) => (
                  <div key={a.bookId}>
                    <strong>{a.title}</strong> — {a.fields.join(', ')} · {a.source} ({a.confidenceReason})
                  </div>
                ))}
              </div>
            )}
            <p className="progress">Nothing in the review list below is applied until you press Apply. Edit any proposed value before applying it.</p>
            {proposals.length > 0 && <button onClick={applyAllProposals}>Apply all proposed fixes</button>}
            {proposals.map((p) => {
              const book = books.find((b) => b.id === p.bookId)
              if (!book) return null
              const values = edits[p.bookId] || p.proposals
              return (
                <div className="proposal" key={p.bookId}>
                  <h3>{book.metadata.title}</h3>
                  <p className="src">{p.source} · {p.confidence}</p>
                  {Object.entries(values).map(([field, value]) => (
                    <div className="field" key={field}>
                      <label>{field}</label>
                      <input value={value} onChange={(e) => setEdits((prev) => ({ ...prev, [p.bookId]: { ...values, [field]: e.target.value } }))} />
                    </div>
                  ))}
                  <div className="toolbar">
                    <button onClick={() => applyProposal(p.bookId, values)}>Apply this book</button>
                    <button className="secondary" onClick={() => setProposals((prev) => prev.filter((x) => x.bookId !== p.bookId))}>Skip</button>
                  </div>
                </div>
              )
            })}
            {!proposals.length && <p>No pending proposals.</p>}
          </div>
        )}

        {view === 'reader' && selected && (
          <div className={`reader ${readerTheme}`}>
            <button className="secondary" onClick={() => setView('detail')}>← Back to book</button>
            <h2>{selected.metadata.title}</h2>
            <div className="toolbar">
              <button className="secondary" disabled={chapterIndex <= 0} onClick={() => goToChapter(selected, chapterIndex - 1, chapters.length)}>← Previous chapter</button>
              <button className="secondary" disabled={chapterIndex >= chapters.length - 1} onClick={() => goToChapter(selected, chapterIndex + 1, chapters.length)}>Next chapter →</button>
              <select value={chapterIndex} onChange={(e) => goToChapter(selected, Number(e.target.value), chapters.length)}>
                {chapters.map((ch, i) => <option key={i} value={i}>{ch.title || `Chapter ${i + 1}`}</option>)}
              </select>
              <label>Font <input type="range" min="14" max="26" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} /></label>
              <select value={readerTheme} onChange={(e) => setReaderTheme(e.target.value)}>
                <option value="light">Reader: Light</option>
                <option value="dark">Reader: Dark</option>
                <option value="sepia">Reader: Sepia</option>
              </select>
              {linkedPairFor(selected) && <button onClick={() => openReadAlong(selected)}>🎧 Read along</button>}
            </div>
            <div className="toolbar">
              <input type="search" placeholder="Search in this book…" value={readerSearch} onChange={(e) => setReaderSearch(e.target.value)} />
              <button className="secondary" onClick={searchInBook}>Search</button>
            </div>
            {readerHits.length > 0 && (
              <div className="card">
                {readerHits.map((h, i) => (
                  <div key={i}><button className="secondary" onClick={() => { pagePendingRef.current = h.frac; goToChapter(selected, h.chapter, chapters.length, 0); setReaderHits([]) }}>{h.title}</button> …{h.snippet}…</div>
                ))}
              </div>
            )}
            {!chapters.length ? <p className="progress">Loading chapters…</p> : (
              <>
                <div className="reader-pages" onTouchStart={onReaderTouchStart} onTouchEnd={onReaderTouchEnd} onClick={onReaderClick}>
                  <div ref={pageRef} className="reader-column-flow chapter" style={{ ['--reader-size']: `${fontSize}px`, transform: `translateX(${-pageIndex * 100}%)` }}
                    dangerouslySetInnerHTML={{ __html: chapters[chapterIndex]?.html || '<p>No readable chapter content found in this EPUB.</p>' }} />
                </div>
                <div className="toolbar reader-pagebar">
                  <button className="secondary" onClick={prevPage}>← Previous page</button>
                  <span className="progress">Page {pageIndex + 1} of {pageCount} · Chapter {chapterIndex + 1} of {chapters.length}</span>
                  <button className="secondary" onClick={nextPage}>Next page →</button>
                </div>
                <p className="progress">Tap the left or right side of the page, or swipe, to turn pages. The last page of a chapter goes to the next chapter.</p>
              </>
            )}
          </div>
        )}

        {view === 'pdf' && selected && <PdfViewer book={withFile(selected)} onBack={() => setView('detail')} onSave={async (book, progress) => { const { file: _f, ...u } = { ...book, progress }; await putBookMeta(u); setSelected(u); await reload() }} />}
        {view === 'comic' && selected && <ComicViewer book={withFile(selected)} onBack={() => setView('detail')} onSave={async (book, progress) => { const { file: _f, ...u } = { ...book, progress }; await putBookMeta(u); setSelected(u); await reload() }} />}
        {view === 'audio' && selected && <AudioPlayer book={withFile(selected)} onBack={() => setView('detail')} onSave={async (book, progress) => { const { file: _f, ...u } = { ...book, progress }; await putBookMeta(u); setSelected(u); }} readAlongPair={linkedPairFor(selected)} onReadAlong={() => openReadAlong(selected)} />}
        {view === 'readalong' && selected && <ReadAlongView epubBook={detailPair ? withFile(detailPair.epub) : withFile(selected)} audioBook={detailPair ? withFile(detailPair.audio) : null} books={books} onBack={() => setView('detail')} onSave={async (book, progress) => { const { file: _f, ...u } = { ...book, progress }; await putBookMeta(u); }} />}
      </main>

      {['library', 'series', 'series-detail', 'unsorted'].includes(view) && (
        <nav className="bottom-tabs" aria-label="Format">
          {[
            { key: 'all', label: 'All', icon: '📚', count: books.length },
            { key: 'books', label: 'Books', icon: '📖', count: books.filter((b) => b.format === 'epub' || b.format === 'pdf').length },
            { key: 'comics', label: 'Comics', icon: '🖼️', count: books.filter((b) => b.format === 'comic').length },
            { key: 'audiobooks', label: 'Audiobooks', icon: '🎧', count: books.filter((b) => b.format === 'audio').length },
          ].map((t) => (
            <button key={t.key} className={formatTab === t.key ? 'active' : ''} onClick={() => setFormatTab(t.key)}>
              <span className="bt-icon">{t.icon}</span>
              <span>{t.label}</span>
              <span className="bt-count">{t.count}</span>
            </button>
          ))}
        </nav>
      )}
    </>
  )
}

function DetailForm({ book, onSave }) {
  const [form, setForm] = useState({
    title: book.metadata.title || '',
    author: book.metadata.author || '',
    publisher: book.metadata.publisher || '',
    date: book.metadata.date || '',
    description: book.metadata.description || '',
    series: book.metadata.series || '',
    seriesIndex: book.metadata.seriesIndex || '',
  })
  useEffect(() => {
    setForm({
      title: book.metadata.title || '',
      author: book.metadata.author || '',
      publisher: book.metadata.publisher || '',
      date: book.metadata.date || '',
      description: book.metadata.description || '',
      series: book.metadata.series || '',
      seriesIndex: book.metadata.seriesIndex || '',
    })
  }, [book.id])
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(book, form) }}>
      {Object.entries(form).map(([field, value]) => (
        <div className="field" key={field}>
          <label>{field}</label>
          {field === 'description'
            ? <textarea rows={4} value={value} onChange={(e) => setForm({ ...form, [field]: e.target.value })} />
            : <input value={value} onChange={(e) => setForm({ ...form, [field]: e.target.value })} />}
        </div>
      ))}
      <button type="submit">Save edits</button>
    </form>
  )
}

function CloudView(props) {
  const {
    books, r2Settings, r2Form, setR2Form, showSecret, setShowSecret,
    cloudMsg, cloudProgress, cloudBusy, syncObjects, syncMsg, corsCopied,
    onBack, onSaveSettings, onClearSettings, onTest, onCopyCors,
    onUploadAll, onClearAllLocal, onSync, onImportCloudObject,
    onDownloadBook, onUploadBook, onClearLocalBook,
  } = props
  const knownKeys = new Set(books.map((b) => b.r2Key).filter(Boolean))
  const unknownObjects = syncObjects.filter((o) => !knownKeys.has(o.key))
  const endpointPreview = r2Form.endpoint && r2Form.endpoint.trim()
    ? r2Form.endpoint.trim()
    : (r2Form.accountId ? `https://${r2Form.accountId}.r2.cloudflarestorage.com` : 'https://<accountId>.r2.cloudflarestorage.com')
  return (
    <div>
      <button className="secondary" onClick={onBack}>← Back to library</button>
      <h2>☁️ Cloud shelf — Cloudflare R2</h2>
      <p className="progress">
        How this works: your catalog (titles, covers, series, progress) always stays on this device.
        Book <em>files</em> can live in your private R2 bucket instead. Upload a book, then Clear Local to
        free phone space — the book stays in your library as “Cloud only”, and opening it downloads it
        again on demand. Nothing is uploaded until you press Upload, and R2 features are disabled until
        you save settings below. Without R2 configured, ShelfSort works exactly as before.
      </p>
      {cloudMsg && <p>{cloudMsg}</p>}
      {cloudProgress && <p className="progress">{cloudProgress}</p>}

      <div className="card">
        <h3>R2 settings — stored only in this browser</h3>
        <p className="progress">
          {r2Settings
            ? `✓ Configured for bucket “${r2Settings.bucket}”. Credentials are stored in this browser's localStorage only — they are not in the repo, not logged, and only sent to ${r2Endpoint(r2Settings)}.`
            : 'Not configured yet. Enter your own keys here — never in chat.'}
        </p>
        <div className="field"><label>Account ID</label><input value={r2Form.accountId} onChange={(e) => setR2Form({ ...r2Form, accountId: e.target.value })} placeholder="Cloudflare Account ID" autoComplete="off" /></div>
        <div className="field"><label>Bucket name</label><input value={r2Form.bucket} onChange={(e) => setR2Form({ ...r2Form, bucket: e.target.value })} placeholder="e.g. shelfsort-books" autoComplete="off" /></div>
        <div className="field"><label>Access Key ID</label><input value={r2Form.accessKeyId} onChange={(e) => setR2Form({ ...r2Form, accessKeyId: e.target.value })} placeholder="R2 API token Access Key ID" autoComplete="off" /></div>
        <div className="field">
          <label>Secret Access Key</label>
          <input type={showSecret ? 'text' : 'password'} value={r2Form.secretAccessKey} onChange={(e) => setR2Form({ ...r2Form, secretAccessKey: e.target.value })} placeholder="R2 API token Secret Access Key" autoComplete="off" />
          <button className="secondary" onClick={() => setShowSecret(!showSecret)}>{showSecret ? 'Hide' : 'Show'}</button>
        </div>
        <div className="field"><label>Custom endpoint (optional — leave blank for the default)</label><input value={r2Form.endpoint} onChange={(e) => setR2Form({ ...r2Form, endpoint: e.target.value })} placeholder="https://<accountId>.r2.cloudflarestorage.com" autoComplete="off" /></div>
        <p className="progress">Endpoint that will be used: {endpointPreview}</p>
        <div className="toolbar">
          <button onClick={() => onSaveSettings(r2Form)} disabled={!r2Form.accountId || !r2Form.bucket || !r2Form.accessKeyId || !r2Form.secretAccessKey}>Save R2 settings</button>
          <button className="secondary" onClick={onTest} disabled={cloudBusy || !r2Form.accountId || !r2Form.bucket || !r2Form.accessKeyId || !r2Form.secretAccessKey}>Test connection</button>
          <button className="secondary" onClick={onClearSettings}>Clear credentials</button>
        </div>
      </div>

      <div className="card">
        <h3>Set up R2 (once, in Cloudflare)</h3>
        <ol>
          <li>Cloudflare Dashboard → <strong>R2</strong> → Create a bucket (any name, e.g. <code>shelfsort-books</code>).</li>
          <li><strong>Keep the bucket PRIVATE.</strong> Do not enable public access / a public domain — ShelfSort talks to R2 with your token, not via a public URL. A public bucket would make your books downloadable by anyone with the link.</li>
          <li>R2 → Manage API Tokens → Create API Token → <strong>Object Read &amp; Write</strong>, scoped to <strong>that bucket only</strong>. Copy its Access Key ID and Secret Access Key into the form above.</li>
          <li><strong>CORS is required for browser access.</strong> In the bucket → Settings → CORS Policy, paste the JSON below, then add your own app origin to AllowedOrigins if you host ShelfSort somewhere other than localhost (for example, your deployed site URL). Without CORS, the browser blocks R2 requests and you will see a “Could not reach R2 / CORS” error — that is a configuration error, not a lost file.</li>
        </ol>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{R2_CORS_JSON}</pre>
        <p className="progress">This snippet allows localhost origins only. Add your hosted origin to AllowedOrigins before using a deployed build.</p>
        <button className="secondary" onClick={onCopyCors}>{corsCopied ? '✓ Copied!' : 'Copy CORS JSON'}</button>
        <p className="progress">Free tier note: Cloudflare's R2 free tier includes 10 GB of storage. EPUBs are small (usually 1–5 MB), but M4B audiobooks (hundreds of MB) and CBZ comics (100 MB+) fill it much faster — this frees phone space, it does not make storage unlimited. Check your R2 usage in the Cloudflare dashboard.</p>
      </div>

      <div className="card">
        <h3>Bulk cloud actions</h3>
        <p className="progress">Upload All skips books already in R2. Clear All Local verifies each book in R2 first (HeadObject) and skips any that are not safely there — it never deletes a local copy that has no verified cloud copy.</p>
        <div className="toolbar">
          <button onClick={onUploadAll} disabled={cloudBusy || !r2Settings}>☁️ Upload all local books</button>
          <button className="secondary" onClick={onClearAllLocal} disabled={cloudBusy || !r2Settings}>🧹 Clear all local (keep in R2)</button>
          <button className="secondary" onClick={onSync} disabled={!r2Settings}>🔄 Sync from Cloud (list R2)</button>
        </div>
        {syncMsg && <p>{syncMsg}</p>}
        {syncObjects.length > 0 && (
          <div>
            <h4>Objects in R2 not in this library ({unknownObjects.length})</h4>
            {unknownObjects.length === 0
              ? <p className="progress">Every R2 object is already in this library.</p>
              : unknownObjects.map((o) => (
                <div key={o.key} className="chapter-row">
                  <span>{o.key}{o.size ? ` · ${(o.size / 1048576).toFixed(1)} MB` : ''}</span>
                  <button className="secondary" onClick={() => onImportCloudObject(o)}>Add as Cloud only</button>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Per-book cloud status</h3>
        {!books.length && <p className="progress">No books in the library yet.</p>}
        {books.map((b) => (
          <div key={b.id} className="chapter-row">
            <span>{b.metadata.title} — {cloudStatusLabel(b)}</span>
            <span className="toolbar">
              {b.hasFile && !b.r2Key && <button className="secondary" onClick={() => onUploadBook(b)}>Upload</button>}
              {b.hasFile && b.r2Key && <button className="secondary" onClick={() => onClearLocalBook(b)}>Clear local</button>}
              {!b.hasFile && b.r2Key && <button className="secondary" onClick={() => onDownloadBook(b)}>Download</button>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PdfViewer({ book, onBack, onSave }) {
  const canvasRef = useRef(null)
  const docRef = useRef(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(book.metadata.pageCount || 0)
  const [scale, setScale] = useState(1.4)
  const [status, setStatus] = useState('Loading PDF…')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState([])

  useEffect(() => {
    let cancelled = false
    if (!book.file) return () => { cancelled = true }
    loadPdf(book.file).then((doc) => {
      if (cancelled) return
      docRef.current = doc
      setTotal(doc.numPages)
      const saved = book.progress
      if (saved && saved.page >= 1 && saved.page <= doc.numPages) setPage(saved.page)
      setStatus('')
    }).catch((e) => setStatus(`Could not open PDF: ${e.message}`))
    return () => { cancelled = true }
  }, [book.id, book.file])

  useEffect(() => {
    if (!docRef.current || !canvasRef.current || !total) return
    renderPdfPage(docRef.current, page, canvasRef.current, scale).catch(() => {})
    onSave(book, { page, at: Date.now() })
  }, [page, scale, total])

  return (
    <div className="card viewer">
      <button className="secondary" onClick={onBack}>← Back to book</button>
      <h2>{book.metadata.title}</h2>
      <div className="toolbar">
        <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Previous page</button>
        <span>Page <input type="number" min="1" max={total || 1} value={page} onChange={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= total) setPage(n) }} style={{ width: 70 }} /> of {total || '…'}</span>
        <button className="secondary" disabled={page >= total} onClick={() => setPage(page + 1)}>Next page →</button>
        <button className="secondary" onClick={() => setScale(Math.max(0.5, scale - 0.25))}>Zoom −</button>
        <span>{Math.round(scale * 100)}%</span>
        <button className="secondary" onClick={() => setScale(Math.min(3, scale + 0.25))}>Zoom +</button>
      </div>
      <div className="toolbar">
        <input type="search" placeholder="Search in this PDF…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="secondary" onClick={async () => { if (docRef.current) setHits(await searchPdf(docRef.current, query)) }}>Search</button>
      </div>
      {hits.length > 0 && (
        <div className="card">
          {hits.map((h, i) => (
            <div key={i}><button className="secondary" onClick={() => setPage(h.page)}>Page {h.page}</button> …{h.snippet}…</div>
          ))}
        </div>
      )}
      {status && <p className="progress">{status}</p>}
      <div className="pdf-canvas-wrap"><canvas ref={canvasRef} /></div>
    </div>
  )
}

function ComicViewer({ book, onBack, onSave }) {
  const [pages, setPages] = useState([])
  const [page, setPage] = useState(0)
  const [fit, setFit] = useState('width')
  const [status, setStatus] = useState('Loading comic…')
  const urlsRef = useRef([])

  useEffect(() => {
    let cancelled = false
    if (!book.file) { setStatus('Loading comic…'); return () => { cancelled = true } }
    ;(async () => {
      try {
        const names = book.metadata.pageNames || []
        const urls = []
        for (const name of names) {
          const blob = await getCbzPageBlob(book.file, name)
          urls.push({ name, url: URL.createObjectURL(blob) })
        }
        if (cancelled) { urls.forEach((u) => URL.revokeObjectURL(u.url)); return }
        urlsRef.current = urls
        setPages(urls)
        const saved = book.progress
        if (saved && saved.page >= 0 && saved.page < urls.length) setPage(saved.page)
        setStatus('')
      } catch (e) {
        setStatus(`Could not open comic: ${e.message}`)
      }
    })()
    return () => { cancelled = true; urlsRef.current.forEach((u) => URL.revokeObjectURL(u.url)); urlsRef.current = [] }
  }, [book.id, book.file])

  function goTo(i) {
    if (i < 0 || i >= pages.length) return
    setPage(i)
    onSave(book, { page: i, at: Date.now() })
  }

  if (book.cbrUnsupported) {
    return (
      <div className="card">
        <button className="secondary" onClick={onBack}>← Back to book</button>
        <h2>{book.metadata.title}</h2>
        <div className="error">
          <strong>CBR cannot be opened yet.</strong> CBR is a RAR archive, not a zip, and no reliable browser RAR unpacker is bundled here.
          Convert it to CBZ with 7-Zip or Calibre, then import the CBZ instead.
        </div>
      </div>
    )
  }

  return (
    <div className="card viewer">
      <button className="secondary" onClick={onBack}>← Back to book</button>
      <h2>{book.metadata.title}</h2>
      <div className="toolbar">
        <button className="secondary" disabled={page <= 0} onClick={() => goTo(page - 1)}>← Previous page</button>
        <span>Page {pages.length ? page + 1 : '…'} of {pages.length}</span>
        <button className="secondary" disabled={page >= pages.length - 1} onClick={() => goTo(page + 1)}>Next page →</button>
        <button className="secondary" onClick={() => setFit(fit === 'width' ? 'page' : 'width')}>Fit: {fit === 'width' ? 'width' : 'page'}</button>
      </div>
      {status && <p className="progress">{status}</p>}
      {pages[page] && (
        <img src={pages[page].url} alt={`Page ${page + 1}`} className={fit === 'width' ? 'comic-page fit-width' : 'comic-page fit-page'} />
      )}
      {pages.length > 1 && (
        <div className="thumb-strip">
          {pages.map((p, i) => (
            <button key={p.name} className={i === page ? 'thumb active' : 'thumb'} onClick={() => goTo(i)} aria-label={`Go to page ${i + 1}`}>
              <img src={p.url} alt="" loading="lazy" />
              <span>{i + 1}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AudioPlayer({ book, onBack, onSave, readAlongPair, onReadAlong }) {
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(book.metadata.durationSec || 0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [sleepMin, setSleepMin] = useState(0)
  const [sleepLeft, setSleepLeft] = useState(0)
  const [bookmarks, setBookmarks] = useState((book.progress && book.progress.bookmarks) || [])
  const [chapterIndex, setChapterIndex] = useState(0)
  const [playerMode, setPlayerMode] = useState('')
  const [playerError, setPlayerError] = useState('')
  const [loading, setLoading] = useState(true)
  const sleepTimerRef = useRef(null)
  const lastSavedRef = useRef(0)
  const currentRef = useRef(0)
  const chapterRef = useRef(0)
  const bookmarksRef = useRef(bookmarks)
  const ctrlRef = useRef(null)
  const bookRef = useRef(book)
  bookRef.current = book
  bookmarksRef.current = bookmarks

  function saveProgress(pos, chap) {
    const progress = { positionSec: pos, chapterIndex: chap, bookmarks: bookmarksRef.current, at: Date.now() }
    onSave(bookRef.current, progress)
  }
  const saveProgressRef = useRef(saveProgress)
  saveProgressRef.current = saveProgress

  // Create the controller once per book. Native on Android (Playlist /
  // ExoPlayer + MediaSession, background + notification controls),
  // HTML <audio> on web or if native setup fails. The controller is
  // NOT paused on unmount: that is the point of a native player —
  // backing out to the library/detail keeps playing in the background.
  // The final position is saved on unmount via the refs above.
  useEffect(() => {
    let cancelled = false
    let ctrl = null
    setLoading(true)
    setPlayerError('')
    const saved = book.progress
    const startPos = saved && saved.positionSec ? saved.positionSec : 0
    currentRef.current = startPos
    lastSavedRef.current = startPos
    setCurrent(startPos)
    createAudioController({
      book,
      fileBuf: book.file,
      startPosition: startPos,
      pauseOnDestroy: false,
      cbs: {
        onPosition: (pos, dur) => {
          if (cancelled) return
          currentRef.current = pos
          setCurrent(pos)
          if (dur > 0) setDuration(dur)
          const chapters = book.audioChapters || []
          if (chapters.length) {
            let idx = 0
            for (let i = 0; i < chapters.length; i++) if (chapters[i].start <= pos + 0.5) idx = i
            if (idx !== chapterRef.current) { chapterRef.current = idx; setChapterIndex(idx) }
          }
          if (Math.abs(pos - lastSavedRef.current) > 5) {
            lastSavedRef.current = pos
            saveProgressRef.current(pos, chapterRef.current)
          }
        },
        onPlaying: (p) => { if (!cancelled) setPlaying(p) },
        onEnded: () => { if (!cancelled) setPlaying(false) },
        onError: () => { if (!cancelled) setPlayerError('Playback reported an error. Try pressing play again, or re-import the file.') },
      },
    }).then((c) => {
      if (cancelled) { c.destroy(); return }
      ctrl = c
      ctrlRef.current = c
      setPlayerMode(c.mode)
      if (c.fallbackFromNative) setPlayerError('Native player was unavailable, so this is playing with the in-app player (no background playback).')
      setLoading(false)
    }).catch(() => {
      if (!cancelled) { setPlayerError('Could not start playback for this file.'); setLoading(false) }
    })
    return () => {
      cancelled = true
      // Save wherever playback had reached, even if it kept playing
      // in the background after this screen unmounted.
      if (currentRef.current > 0) saveProgressRef.current(currentRef.current, chapterRef.current)
      if (ctrl) ctrl.destroy()
      else if (ctrlRef.current) ctrlRef.current.destroy()
      ctrlRef.current = null
      if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id])

  function seekTo(sec) {
    const target = Math.max(0, Math.min(duration || sec, sec))
    currentRef.current = target
    setCurrent(target)
    ctrlRef.current && ctrlRef.current.seekTo(target)
    saveProgress(target, chapterRef.current)
  }

  function togglePlay() {
    if (!ctrlRef.current) return
    if (playing) ctrlRef.current.pause()
    else ctrlRef.current.play()
  }

  function setSleep(min) {
    setSleepMin(min)
    if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current)
    if (!min) { setSleepLeft(0); return }
    setSleepLeft(min * 60)
    // Sleep timer lives in this screen only: if the user leaves the
    // player, the timer is cleared on unmount (native background
    // playback itself keeps going, but no timer is left running).
    sleepTimerRef.current = setTimeout(() => {
      if (ctrlRef.current) ctrlRef.current.pause()
      setPlaying(false)
      setSleepLeft(0)
      setSleepMin(0)
    }, min * 60 * 1000)
  }

  function addBookmark() {
    const next = [...bookmarks, { time: Math.floor(currentRef.current), label: `Bookmark ${formatTime(currentRef.current)}` }]
    setBookmarks(next)
    bookmarksRef.current = next
    onSave(book, { positionSec: currentRef.current, chapterIndex: chapterRef.current, bookmarks: next, at: Date.now() })
  }

  const chapters = book.audioChapters || []
  return (
    <div className="card viewer">
      <button className="secondary" onClick={() => { saveProgress(currentRef.current, chapterRef.current); onBack() }}>← Back to book</button>
      <h2>🎧 {book.metadata.title}</h2>
      <p>{book.metadata.author || 'Unknown author'}</p>
      {playerMode === 'native' && <p className="progress">Native player — keeps playing in the background, with lock-screen / notification controls.</p>}
      {playerMode === 'html' && <p className="progress">In-app player (web fallback).</p>}
      {loading && <p className="progress">Loading audio… (large M4Bs are copied to the app cache on first open, then reused.)</p>}
      {playerError && <p className="error">{playerError}</p>}
      <div className="audio-controls">
        <input type="range" min="0" max={duration || 0} step="1" value={Math.min(current, duration || 0)} onChange={(e) => seekTo(Number(e.target.value))} />
        <div className="toolbar">
          <span>{formatTime(current)} / {formatTime(duration)}</span>
          <button className="secondary" onClick={() => seekTo(current - 15)}>−15s</button>
          <button className="secondary" onClick={() => seekTo(current - 30)}>−30s</button>
          <button onClick={togglePlay} disabled={loading}>{playing ? '⏸ Pause' : '▶ Play'}</button>
          <button className="secondary" onClick={() => seekTo(current + 15)}>+15s</button>
          <button className="secondary" onClick={() => seekTo(current + 30)}>+30s</button>
          <label>Speed
            <select value={speed} onChange={(e) => { const s = Number(e.target.value); setSpeed(s); if (ctrlRef.current) ctrlRef.current.setRate(s) }}>
              {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </label>
        </div>
        <div className="toolbar">
          <label>Sleep timer
            <select value={sleepMin} onChange={(e) => setSleep(Number(e.target.value))}>
              <option value={0}>Off</option>
              <option value={15}>15 min</option>
              <option value={30}>30 min</option>
              <option value={60}>60 min</option>
            </select>
          </label>
          {sleepLeft > 0 && <span className="progress">Sleep timer set ({sleepMin} min)</span>}
          <button className="secondary" onClick={addBookmark}>🔖 Bookmark at {formatTime(current)}</button>
          {readAlongPair && <button onClick={onReadAlong}>🎧 Read along with EPUB</button>}
        </div>
      </div>
      {chapters.length > 0 ? (
        <div>
          <h3>Chapters {chapters.length ? `(${chapters.length})` : ''}</h3>
          {chapters.map((ch, i) => (
            <div key={i} className={i === chapterIndex ? 'chapter-row active' : 'chapter-row'}>
              <button className="secondary" onClick={() => seekTo(ch.start)}>{ch.title}</button>
              <span>{formatTime(ch.start)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="progress">No chapters embedded in this file. Use bookmarks above to mark places instead — playback position is still saved.</p>
      )}
      {bookmarks.length > 0 && (
        <div>
          <h3>Bookmarks</h3>
          {bookmarks.map((b, i) => (
            <div key={i}><button className="secondary" onClick={() => seekTo(b.time)}>{b.label}</button></div>
          ))}
        </div>
      )}
    </div>
  )
}

function ReadAlongView({ epubBook, audioBook, onBack, onSave }) {
  const [epubChapters, setEpubChapters] = useState([])
  const [epubIndex, setEpubIndex] = useState(0)
  const [current, setCurrent] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fontSize, setFontSize] = useState(18)
  const [playerMode, setPlayerMode] = useState('')
  const [playerError, setPlayerError] = useState('')
  const syncingFromAudioRef = useRef(false)
  const ctrlRef = useRef(null)
  const epubIndexRef = useRef(0)

  const audioChapters = (audioBook && audioBook.audioChapters) || []
  const mapping = useMemo(() => mapChapters(epubChapters, audioChapters), [epubChapters, audioChapters])
  const mappingRef = useRef(mapping)
  mappingRef.current = mapping

  useEffect(() => {
    if (!epubBook || !epubBook.file) return
    parseChapters(epubBook.file).then((ch) => {
      setEpubChapters(ch)
      const saved = epubBook.progress
      if (saved && saved.chapterIndex < ch.length) { setEpubIndex(saved.chapterIndex); epubIndexRef.current = saved.chapterIndex }
    }).catch(() => {})
  }, [epubBook && epubBook.id, epubBook && epubBook.file])

  // Read-along uses the SAME native controller as the standalone
  // player, so position events drive the EPUB chapter sync. Native
  // position events are throttled / suppressed while backgrounded —
  // read-along is a foreground activity, so that is fine here.
  // Unlike the standalone player, leaving read-along DOES pause:
  // the EPUB view is gone, so continuing audio alone would be a
  // surprise (pauseOnDestroy: true in nativeAudio.js).
  useEffect(() => {
    if (!audioBook || !audioBook.file) return
    let cancelled = false
    let ctrl = null
    const saved = audioBook.progress
    const startPos = saved && saved.positionSec ? saved.positionSec : 0
    setCurrent(startPos)
    createAudioController({
      book: audioBook,
      fileBuf: audioBook.file,
      startPosition: startPos,
      pauseOnDestroy: true,
      cbs: {
        onPosition: (pos) => {
          if (cancelled) return
          setCurrent(pos)
          const chs = audioChapters
          if (!chs.length || !epubChapters.length) return
          const aIdx = audioChapterAtTime(chs, pos)
          let eIdx = mappingRef.current.indexOf(aIdx)
          if (eIdx < 0) eIdx = Math.min(aIdx, epubChapters.length - 1)
          if (eIdx !== epubIndexRef.current && !syncingFromAudioRef.current) {
            syncingFromAudioRef.current = true
            epubIndexRef.current = eIdx
            setEpubIndex(eIdx)
            if (epubBook) onSave(epubBook, { chapterIndex: eIdx, at: Date.now() })
            setTimeout(() => { syncingFromAudioRef.current = false }, 200)
          }
        },
        onPlaying: (p) => { if (!cancelled) setPlaying(p) },
        onEnded: () => { if (!cancelled) setPlaying(false) },
        onError: () => { if (!cancelled) setPlayerError('Playback reported an error.') },
      },
    }).then((c) => {
      if (cancelled) { c.destroy(); return }
      ctrl = c
      ctrlRef.current = c
      setPlayerMode(c.mode)
      if (c.fallbackFromNative) setPlayerError('Native player was unavailable, so read-along is using the in-app player.')
    }).catch(() => { if (!cancelled) setPlayerError('Could not start read-along audio.') })
    return () => {
      cancelled = true
      if (ctrl) ctrl.destroy()
      else if (ctrlRef.current) ctrlRef.current.destroy()
      ctrlRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioBook && audioBook.id, audioBook && audioBook.file])

  function goToEpubChapter(index, seekAudio = true) {
    epubIndexRef.current = index
    setEpubIndex(index)
    if (epubBook) onSave(epubBook, { chapterIndex: index, at: Date.now() })
    if (seekAudio && audioBook && audioChapters.length) {
      const audioIdx = mapping[index]
      if (audioIdx >= 0 && ctrlRef.current) {
        ctrlRef.current.seekTo(audioChapters[audioIdx].start)
        setCurrent(audioChapters[audioIdx].start)
      }
    }
  }

  if (!audioBook) {
    return (
      <div className="card">
        <button className="secondary" onClick={onBack}>← Back to book</button>
        <h2>Read-along</h2>
        <p>No audiobook is linked to this book yet. Link one from the book detail page (automatic suggestion, or the manual link dropdown), then come back here.</p>
      </div>
    )
  }

  return (
    <div className="card viewer">
      <button className="secondary" onClick={onBack}>← Back to book</button>
      <h2>🎧 Read-along: {epubBook.metadata.title}</h2>
      <p className="progress">
        <strong>Chapter-level sync, not word-by-word.</strong> When the audio chapter changes, the EPUB advances to the matching chapter (by title, otherwise by order).
        When you change EPUB chapter, the audio seeks to that chapter's start. Ordinary EPUB + M4B pairs do not contain word timing data, so word highlighting is not claimed here.
      </p>
      {playerMode === 'native' && <p className="progress">Native player — audio keeps playing if you switch apps; leaving this screen pauses it.</p>}
      {playerError && <p className="error">{playerError}</p>}
      <div className="toolbar">
        <button onClick={() => { if (!ctrlRef.current) return; if (playing) ctrlRef.current.pause(); else ctrlRef.current.play() }}>{playing ? '⏸ Pause' : '▶ Play'}</button>
        <span>{formatTime(current)} · Audio chapter: {audioChapters.length ? (audioChapters[audioChapterAtTime(audioChapters, current)]?.title || '—') : 'No embedded chapters — sync follows EPUB chapter order only when you change chapters'} · EPUB chapter {epubChapters.length ? epubIndex + 1 : '…'} of {epubChapters.length}</span>
      </div>
      <div className="toolbar">
        <button className="secondary" disabled={epubIndex <= 0} onClick={() => goToEpubChapter(epubIndex - 1)}>← Previous EPUB chapter</button>
        <button className="secondary" disabled={epubIndex >= epubChapters.length - 1} onClick={() => goToEpubChapter(epubIndex + 1)}>Next EPUB chapter →</button>
        <select value={epubIndex} onChange={(e) => goToEpubChapter(Number(e.target.value))}>
          {epubChapters.map((ch, i) => <option key={i} value={i}>{ch.title || `Chapter ${i + 1}`}</option>)}
        </select>
        <label>Font <input type="range" min="14" max="26" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} /></label>
      </div>
      {!epubChapters.length ? <p className="progress">Loading EPUB chapters…</p> : (
        <article className="chapter" style={{ ['--reader-size']: `${fontSize}px` }}
          dangerouslySetInnerHTML={{ __html: epubChapters[epubIndex]?.html || '<p>No readable chapter content found.</p>' }} />
      )}
    </div>
  )
}
