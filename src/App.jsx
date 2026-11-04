import { useEffect, useMemo, useRef, useState } from 'react'
import { getAllBooksMeta, getBookFile, putBookMeta, putBookFile, deleteBookFile, deleteBook, clearLibrary, saveProgressLocal, loadProgressLocal } from './lib/db.js'
import { parseEpub, parseChapters, fetchAsDataUrl } from './lib/epub.js'
import { parsePdf, loadPdf, renderPdfPage, searchPdf } from './lib/pdf.js'
import { parseCbz, getCbzPageBlob, isCbrFile } from './lib/comic.js'
import { parseAudio, parseMp3Tags, formatTime } from './lib/audio.js'
import { enrichBook } from './lib/enrich.js'
import { groupBySeries, getSeries, sortBooks } from './lib/series.js'
import { createAudioController } from './lib/nativeAudio.js'
import { pageTurnHaptic } from './lib/haptics.js'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { Volume } from '@capawesome/capacitor-volume'
import { paginateChapterDom, findPageForText, nextPageIndex } from './lib/paginate.js'
import { cleanDescription } from './lib/description.js'
import { storeAudioFile } from './lib/audioStore.js'
import { buildCorrectedEpub, downloadBlob } from './lib/exportEpub.js'
import { buildCatalog, parseCatalog, computeCatalogChanges } from './lib/catalog.js'
import { exportCatalogFile } from './lib/catalogExport.js'
import { findAudioMatch, findEpubMatch, mapChapters, audioChapterAtTime } from './lib/readalong.js'
import { folderNameOfFile, folderNameOfFiles, groupFilesByFolder, newFilesForRescan, isSupportedBookFile } from './lib/watchedFolders.js'
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
// Tap vs long-press vs scroll, for book rows/cards.
//   Tap (press + release, <500ms, <12px move)  -> onTap (open directly)
//   Long-press (hold >=500ms, <12px move)      -> onDetail (detail page)
//   Scroll (move >12px, any direction)          -> neither; the timer
//     is cancelled on move, and a following click is swallowed, so a
//     vertical list scroll can never open a book or its detail.
// A long-press must NOT also fire the tap: when the timer fires it
// sets fired=true, and the click that follows the release is
// swallowed. Mouse holds work the same way (desktop fallback);
// keyboard activation (Enter/Space) fires onTap with no press state.
function usePressHandlers(onTap, onDetail) {
  const timerRef = useRef(null)
  const stRef = useRef({ x: 0, y: 0, fired: false, moved: false })
  const clear = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }
  const start = (x, y) => {
    stRef.current = { x, y, fired: false, moved: false }
    clear()
    timerRef.current = setTimeout(() => { stRef.current.fired = true; onDetail() }, 500)
  }
  const move = (x, y) => {
    const s = stRef.current
    // Only during an active press: a plain mouse hover over a row
    // must not arm the moved flag, or a later keyboard activation
    // would be swallowed.
    if (!s || (timerRef.current === null && !s.fired)) return
    if (Math.hypot(x - s.x, y - s.y) > 12) { s.moved = true; clear() }
  }
  const end = () => clear()
  const click = (e) => {
    const s = stRef.current
    if (s.fired || s.moved) { stRef.current = { x: 0, y: 0, fired: false, moved: false }; e.preventDefault(); return }
    onTap()
  }
  return {
    onTouchStart: (e) => start(e.touches[0].clientX, e.touches[0].clientY),
    onTouchMove: (e) => move(e.touches[0].clientX, e.touches[0].clientY),
    onTouchEnd: end,
    onTouchCancel: end,
    onMouseDown: (e) => start(e.clientX, e.clientY),
    onMouseMove: (e) => move(e.clientX, e.clientY),
    onMouseUp: end,
    onMouseLeave: end,
    onContextMenu: (e) => e.preventDefault(),
    onClick: click,
  }
}

function BookRow({ book, onOpen, onDetail }) {
  const cover = coverFor(book)
  const frac = progressFraction(book)
  const press = usePressHandlers(() => onOpen(book), () => onDetail(book))
  return (
    <button className="book-row" {...press}>
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
function BookGridCard({ book, onOpen, onDetail }) {
  const cover = coverFor(book)
  const press = usePressHandlers(() => onOpen(book), () => onDetail(book))
  return (
    <button className="book-grid" {...press} aria-label={book.metadata.title}>
      {cover ? <img src={cover} alt="" /> : <div className="cover">No cover</div>}
      <span className="book-grid-title">{book.metadata.title}</span>
      <span className="book-grid-author">{book.metadata.author || 'Unknown author'}</span>
    </button>
  )
}
export default function App() {
  const [books, setBooks] = useState([])
  const [view, setView] = useState('library') // library | detail | reader | fixes | pdf | comic | audio | readalong
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view }, [view])
  // Back navigation, REPLACED by the in-app back swipe (see below).
  // Every view that used to have an in-app Back button now exits by
  // a rightward swipe STARTING in the band 56-160px from the left
  // edge. The band sits deliberately INWARD of the Pixel/Android
  // system back-gesture zone (roughly the first ~40px): a swipe
  // starting in the system zone is left to the system, which now
  // exits the reader via the Capacitor backButton listener below
  // instead of closing the app.
  // Destination map — the same destination the old Back buttons had:
  //   reader/detail/pdf/comic/audio/readalong -> detail/library as listed
  // Top-bar Library/Series/Unsorted/Settings tabs and bottom format
  // tabs are NOT back buttons and stay untouched.
  function backDestinationFor(v) {
    if (v === 'reader' || v === 'pdf' || v === 'comic' || v === 'audio' || v === 'readalong') return 'detail'
    if (v === 'detail' || v === 'unsorted' || v === 'fixes' || v === 'cloud') return 'library'
    if (v === 'series-detail') return 'series'
    return null
  }
  // History entry for system back (see navigateBack / popstate).
  const historyEntryRef = useRef(null) // { view } | null
  const doExitReaderRef = useRef(null)
  const navigateBackRef = useRef(null)
  // Global (non-reader) edge swipe state: the reader has its own
  // edge handling on its page area (with the flip), so the main
  // handler below skips view === 'reader'.
  const [navEdgeOffset, setNavEdgeOffset] = useState(0)
  const navEdgeRef = useRef(null)
  const navEdgeClickBlockRef = useRef(0)
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
  // Muse catalog export / import (no backdoor: files the owner chooses to share/load).
  const [catalogPreview, setCatalogPreview] = useState(null)
  const [catalogStatus, setCatalogStatus] = useState('')
  // Auto-apply high-confidence fixes (only ask when unsure).
  // Default ON; turning it off restores ask-every-time behaviour.
  const [autoApplyHigh, setAutoApplyHigh] = useState(() => {
    try { return localStorage.getItem('shelfsort-auto-apply-high') !== 'off' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('shelfsort-auto-apply-high', autoApplyHigh ? 'on' : 'off') } catch { /* ignore */ }
  }, [autoApplyHigh])
  // Watched library folders (v0.7.1) — NAME/PATH ONLY in localStorage.
  // A WebView <input> pick cannot persist a folder handle across
  // sessions, so a saved folder is never silently re-opened: on
  // startup the app only PROMPTS, and a rescan re-opens the picker
  // so the user grants access again. See src/lib/watchedFolders.js.
  const [watchedFolders, setWatchedFolders] = useState(() => {
    try { const v = JSON.parse(localStorage.getItem('shelfsort-watched-folders') || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
  })
  useEffect(() => {
    try { localStorage.setItem('shelfsort-watched-folders', JSON.stringify(watchedFolders)) } catch { /* ignore */ }
  }, [watchedFolders])
  // Volume keys turn pages (native plugin, see the reader effect
  // below). Default OFF: a user who never asked for it keeps normal
  // volume control. Persisted in localStorage; the toggle lives in
  // Settings only — there is deliberately no popup for it.
  const [volumeKeysTurnPages, setVolumeKeysTurnPages] = useState(() => {
    try { return localStorage.getItem('shelfsort-volume-keys') === 'on' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('shelfsort-volume-keys', volumeKeysTurnPages ? 'on' : 'off') } catch { /* ignore */ } }, [volumeKeysTurnPages])
  const volumeKeysRef = useRef(volumeKeysTurnPages)
  useEffect(() => { volumeKeysRef.current = volumeKeysTurnPages }, [volumeKeysTurnPages])
  // Latest-callback refs so native listeners (registered once per
  // reader session) always call the current turn functions instead
  // of a stale closure's chapter/page state.
  const nextPageRef = useRef(null)
  const prevPageRef = useRef(null)
  const [scanOnStartup, setScanOnStartup] = useState(() => {
    try { return localStorage.getItem('shelfsort-scan-on-startup') !== 'off' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('shelfsort-scan-on-startup', scanOnStartup ? 'on' : 'off') } catch { /* ignore */ }
  }, [scanOnStartup])
  const [watchStatus, setWatchStatus] = useState('')
  const [watchPromptDismissed, setWatchPromptDismissed] = useState(false)
  const watchFolderRef = useRef(null)
  const folderPickModeRef = useRef('library')
  const watchPickModeRef = useRef('add')
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
  // EPUB reader v0.7.0 — REAL pages, measured, no CSS columns.
  // `pages` is the current chapter split into page divs by
  // paginateChapterDom (each page's blocks, measured to fit the
  // actual page area). pageIndexRef mirrors pageIndex. If pagination
  // fails, readerFallback is true and the whole chapter is shown
  // scrollable — text is NEVER clipped with no way to reach it.
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const [pages, setPages] = useState([])
  const [readerFallback, setReaderFallback] = useState(false)
  const pageIndexRef = useRef(0)
  const pageCountRef = useRef(1)
  const pagePendingRef = useRef(null) // 'last' | { frac } | { page } | null
  const pageAreaRef = useRef(null)
  const measurerRef = useRef(null)
  const pageAreaSizeRef = useRef({ w: 0, h: 0 })
  // Full 3D page-turn: during a drag or an animated turn, the reader
  // renders TWO layers — the incoming page underneath, and the
  // outgoing page on top rotating in perspective (0 -> 180deg, pivot
  // on the spine: left edge for next, right edge for prev, with a
  // shadow that grows with progress). Past 90deg the outgoing page
  // is backface-hidden, so it reads as flipping over to reveal the
  // next page — not a tilt on a sliding page. flip = null when idle.
  const [flip, setFlip] = useState(null) // { dir, progress, target, boundary }
  // In-app back swipe: a rightward swipe STARTING in the band
  // 56-160px from the left edge exits the reader (see
  // onReaderTouch*). The band is inward of the system gesture zone
  // on purpose — see the top comment. edgeOffset
  // is the live drag distance, applied as a translateX on the reader
  // screen so the exit follows the finger like the flip does.
  const [edgeOffset, setEdgeOffset] = useState(0)
  const flipRef = useRef(null)
  const flipAnimRef = useRef(null)
  function setFlipState(f) { flipRef.current = f; setFlip(f) }
  const [readerToolbar, setReaderToolbar] = useState(false)
  const dragRef = useRef(null)
  const suppressClickRef = useRef(false)
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
  const catalogFileRef = useRef(null)

  // Metadata only — this is the fix for the 300-book crash/empty-library
  // cycle: loading the library must NEVER pull 300 file blobs into RAM.
  async function reload() {
    const all = await getAllBooksMeta()
    setBooks(all)
    return all
  }
  useEffect(() => { reload().catch(() => {}) }, [])
  useEffect(() => { if (folderRef.current) folderRef.current.setAttribute('webkitdirectory', '') }, [])
  useEffect(() => { if (watchFolderRef.current) watchFolderRef.current.setAttribute('webkitdirectory', '') }, [])

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
        // Audio: written ONCE at import to the app file store
        // (audioStore.js); the resulting URI is the playback source
        // and NO blob is stored in IndexedDB for audio (no double
        // storage). If that store fails (e.g. web build), fall back
        // to the IndexedDB blob + HTML player path instead of
        // failing the import.
        if (parsed.format === 'audio') {
          const uri = await storeAudioFile(id, file.name, buf)
          if (uri) {
            await putBookMeta({ ...meta, audioFileUri: uri })
          } else {
            await putBookFile(id, buf)
          }
        } else {
          await putBookFile(id, buf)
        }
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

  // ---- Watched folders ------------------------------------------------
  // One handler for every folder pick, so the folder-name logic and
  // the "picker did not return a folder" message live in one place.
  // mode: 'library' = Library "Choose a folder" (import only, do not
  // save); 'add' = Settings "Add folder" (save + import);
  // 'rescan' = startup/Settings rescan (import only files whose
  // folder name matches a saved watched folder, and only files not
  // already in the library — importFiles itself does NOT dedupe).
  async function handleFolderPick(fileList, mode) {
    const files = [...fileList].filter(isSupportedBookFile)
    if (!files.length) {
      const msg = 'No supported files found (.epub, .pdf, .cbz, .cbr, .m4b, .mp3).'
      if (mode === 'add' || mode === 'rescan') setWatchStatus(msg); else setImportStatus(msg)
      return
    }
    const groups = groupFilesByFolder(files)
    const namedGroups = [...groups.entries()].filter(([name]) => name)
    if (!namedGroups.length) {
      // The phone's picker fell back to plain files: it did not
      // return a folder, so no folder name can be saved or matched.
      // Import the files anyway (they are usable) and say so plainly
      // instead of silently doing nothing — but do not pretend a
      // folder was watched.
      await importFiles(files)
      const msg = "The phone's picker did not return a folder — it returned individual files instead. Those files were imported, but no folder was saved or matched. To watch a folder, pick it again, or use Choose files for individual files."
      if (mode === 'add' || mode === 'rescan') setWatchStatus(msg); else setImportStatus((prev) => `${prev} ${msg}`)
      return
    }
    if (mode === 'rescan') {
      const existing = await getAllBooksMeta()
      const wanted = new Set(watchedFolders.map((w) => w.name.toLowerCase()))
      let toImport = []
      const found = {}
      for (const [name, groupFiles] of namedGroups) {
        if (!wanted.has(name.toLowerCase())) continue
        found[name] = groupFiles.length
        toImport = toImport.concat(newFilesForRescan(groupFiles, existing))
      }
      if (!Object.keys(found).length) {
        setWatchStatus('No picked folder matched a saved watched folder. Re-pick one of the saved folders to rescan it.')
        return
      }
      // Record what this scan found, even when nothing was new.
      setWatchedFolders((prev) => prev.map((w) => (found[w.name] !== undefined ? { ...w, lastCount: found[w.name], lastScannedAt: Date.now() } : w)))
      if (!toImport.length) {
        setWatchStatus(`Rescan done — no new books in ${Object.keys(found).join(', ')}. Everything picked is already in the library.`)
        await reload()
        return
      }
      await importFiles(toImport)
      setWatchStatus(`Rescan done — imported ${toImport.length} new book(s) from ${Object.keys(found).join(', ')}.`)
      return
    }
    // 'library' and 'add': import everything picked.
    const folderName = folderNameOfFiles(files)
    await importFiles(files)
    if (mode === 'add' && folderName) {
      const count = namedGroups.find(([name]) => name === folderName)?.[1].length ?? files.length
      setWatchedFolders((prev) => {
        const rest = prev.filter((w) => w.name.toLowerCase() !== folderName.toLowerCase())
        return [...rest, { name: folderName, lastCount: count, lastScannedAt: Date.now() }]
      })
      setWatchStatus(`Folder "${folderName}" saved as a watched folder (${count} book file(s) found on this scan). Re-pick it on a later rescan to import new books — Android does not let the app reopen it on its own.`)
    } else if (mode === 'add') {
      setWatchStatus("No folder name came back with this pick, so nothing was saved as a watched folder — but the files above were imported.")
    }
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

  // ---- Muse catalog export / import ------------------------------------
  async function exportCatalog() {
    const catalog = buildCatalog(books)
    const jsonText = JSON.stringify(catalog, null, 2)
    const countNote = `${catalog.books.length} book${catalog.books.length === 1 ? '' : 's'} — metadata only, no book files, covers, or credentials.`
    try {
      const result = await exportCatalogFile(jsonText)
      // exportCatalogFile already distinguishes success, a dismissed
      // share sheet, and a real failure — never claim an export that
      // did not produce a file (the old "Exported N books" message
      // did exactly that on Android, where the blob download was
      // silently swallowed and no file ever appeared).
      setCatalogStatus(result.ok ? `${result.detail} ${countNote}` : result.detail)
    } catch (e) {
      setCatalogStatus(`No catalog file was created: ${e && e.message ? e.message : 'unknown error'}. Nothing was exported — try Export again.`)
    }
  }

  async function previewCatalogFile(file) {
    setCatalogStatus('')
    try {
      const text = await file.text()
      const entries = parseCatalog(text)
      setCatalogPreview(computeCatalogChanges(books, entries))
    } catch (e) {
      setCatalogPreview(null)
      setCatalogStatus(`Could not read that catalog: ${e.message}`)
    }
  }

  async function applyCatalogPreview() {
    if (!catalogPreview) return
    let applied = 0
    for (const change of catalogPreview.changes) {
      const book = books.find((b) => b.id === change.bookId)
      if (!book) continue
      const patch = {}
      for (const d of change.diffs) patch[d.field] = d.to
      const updated = { ...book, metadata: { ...book.metadata, ...patch } }
      if (change.diffs.some((d) => d.field === 'title')) updated.titleFromFilename = false
      await putBookMeta(updated)
      applied++
    }
    setCatalogPreview(null)
    setCatalogStatus(`Applied ${applied} book${applied === 1 ? '' : 's'} from the catalog. ${catalogPreview.unmatched.length ? `${catalogPreview.unmatched.length} catalog entr${catalogPreview.unmatched.length === 1 ? 'y' : 'ies'} did not match a book in this library and were skipped.` : ''}`)
    await reload()
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
    // Audio books with an import-time file URI need NO blob: the
    // native player plays straight from that URI (audioStore.js).
    // Returning null here lets openViewer / read-along proceed
    // without trying to load a blob that was never stored.
    if (book.format === 'audio' && book.audioFileUri) return null
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
    // Reached ONLY by long-press now (see BookRow/BookGridCard).
    setSelected(book)
    setView('detail')
  }

  // Tap on a row/card opens the book DIRECTLY — no detail page in
  // between — exactly as the old Read/Play buttons did. CBR cannot
  // open at all, so it falls back to the detail page, which is the
  // only place that explains the CBR limitation.
  async function openDirect(book) {
    if (book.format === 'epub') return openReader(book)
    if (book.format === 'pdf') return openViewer(book, 'pdf')
    if (book.format === 'comic') {
      if (book.cbrUnsupported) return openBook(book)
      return openViewer(book, 'comic')
    }
    if (book.format === 'audio') return openViewer(book, 'audio')
    return openBook(book)
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

  // v0.7.0 page turning — ONE page per turn, always.
  // nextPageIndex() (paginate.js) is the rule: a turn moves exactly
  // one page within the chapter; ONLY on the last page does it move
  // to the next chapter (and symmetrically on the first page to the
  // previous chapter's last page). A chapter measured as 1 page used
  // to make every swipe jump a chapter — with real measured pages
  // that cannot happen: a multi-page chapter needs N-1 turns to
  // reach its last page. The turn itself is a full 3D flip (see the
  // reader JSX): the outgoing page rotates 0 -> 180deg in
  // perspective over the incoming page underneath, following the
  // finger during a drag and snapping forward/back on release.
  function commitTurn(dir) {
    const r = nextPageIndex(pageIndexRef.current, pageCountRef.current, dir)
    if (!r.chapterChange) {
      const p = r.page
      pageIndexRef.current = p
      setPageIndex(p)
      if (selected) saveReaderPage(selected, chapterIndex, p, pageCountRef.current, chapters.length)
      return
    }
    if (dir > 0 && chapterIndex < chapters.length - 1) {
      pagePendingRef.current = null
      goToChapter(selected, chapterIndex + 1, chapters.length, 0)
    } else if (dir < 0 && chapterIndex > 0) {
      pagePendingRef.current = 'last'
      goToChapter(selected, chapterIndex - 1, chapters.length, 0)
    }
  }
  // Exit the reader to the book's detail page, saving progress
  // first — exactly what the Back button does. doExitReader is the
  // plain version; exitReader goes through browser history when the
  // reader pushed an entry, so a system back press and an in-app
  // exit stay in sync (see the popstate effect below).
  function doExitReader() {
    if (selected && !readerFallback) saveReaderPage(selected, chapterIndex, pageIndexRef.current, pageCountRef.current, chapters.length)
    setEdgeOffset(0)
    cancelFlipAnim()
    setFlipState(null)
    setView('detail')
  }
  useEffect(() => { doExitReaderRef.current = doExitReader })
  function exitReader() {
    if (historyEntryRef.current && historyEntryRef.current.view === 'reader') { historyEntryRef.current = null; window.history.back() }
    else doExitReader()
  }
  // System back (Android back button/gesture, browser back):
  // every back-able view pushes a history entry on entry, so a
  // system back pops that entry and lands on the same destination
  // the old Back button had — the user is never stuck if an edge
  // swipe misses. Reader exit also saves progress (doExitReader).
  function navigateBack(v) {
    const dest = backDestinationFor(v)
    if (!dest) return
    if (v === 'reader') { exitReader(); return }
    if (historyEntryRef.current && historyEntryRef.current.view === v) { historyEntryRef.current = null; window.history.back() }
    else setView(dest)
  }
  useEffect(() => { navigateBackRef.current = navigateBack })
  useEffect(() => {
    const onPop = () => {
      const v = viewRef.current
      historyEntryRef.current = null
      if (v === 'reader') {
        if (doExitReaderRef.current) doExitReaderRef.current()
      } else {
        const dest = backDestinationFor(v)
        if (dest) setView(dest)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // Desktop fallback (no touch, no Back button left): Escape exits
  // the current back-able view to the same destination. Browser back
  // and the top-bar tabs also still work. The same handler is the
  // web fallback for volume keys: if a browser ever delivers
  // VolumeUp/VolumeDown keys, they turn pages in the reader when
  // the toggle is on. (On Android the keys never reach the WebView
  // — the native plugin below handles them instead.)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && navigateBackRef.current) navigateBackRef.current(viewRef.current)
      if (volumeKeysRef.current && viewRef.current === 'reader' && ['VolumeUp', 'VolumeDown', 'AudioVolumeUp', 'AudioVolumeDown'].includes(e.key)) {
        e.preventDefault()
        if (e.key === 'VolumeDown' || e.key === 'AudioVolumeDown') nextPageRef.current?.()
        else prevPageRef.current?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Android system back (button + Pixel back gesture): Capacitor
  // does NOT run history.back() for us, and with no listener the
  // app exits — which is why system back used to close the app
  // from inside a book. This listener, registered once, routes
  // system back through the SAME navigateBack path as the in-app
  // swipe: for a pushed history entry, navigateBack calls
  // history.back() and the popstate handler above does the actual
  // navigation (reader exit saves progress there), so one back
  // press is exactly one navigation — never a setView here AND a
  // popstate navigation. Only a top-level tab view with no back
  // destination (Library, Series, Settings) exits the app.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let handle = null
    ;(async () => {
      try {
        handle = await CapApp.addListener('backButton', () => {
          const v = viewRef.current
          if (backDestinationFor(v)) {
            if (navigateBackRef.current) navigateBackRef.current(v)
          } else if (v === 'library' || v === 'series' || v === 'settings') {
            CapApp.exitApp().catch(() => { /* exit is best-effort */ })
          }
          // Any other view with no back destination: swallow the
          // press rather than exit unexpectedly.
        })
      } catch { /* App plugin unavailable: system back keeps its default behaviour */ }
    })()
    return () => { if (handle) handle.remove().catch(() => {}) }
  }, [])
  // Volume keys turn pages (native). A plain WebView keydown
  // handler can NOT do this on Android: the system consumes the
  // volume keys before the WebView ever sees them. So this uses
  // @capawesome/capacitor-volume: startWatching installs a native
  // key listener ONLY while watching, and with suppressVolumeChange
  // it consumes the key (returns true), so the volume does not
  // change and the system volume panel does not appear while
  // reading. stopWatching removes the listener and restores normal
  // volume behaviour. Listening starts on reader entry and stops
  // on reader exit (or toggle off) — it never runs in Library,
  // detail, or audio views, and never leaves a dangling listener.
  // Volume DOWN = next page, Volume UP = previous page, through
  // the same requestTurn path as swipe/buttons (one page per
  // press — the plugin fires once per press, not on hold — with
  // the same flip, haptic, and chapter-boundary rules).
  useEffect(() => {
    if (view !== 'reader' || !volumeKeysTurnPages) return
    if (!Capacitor.isNativePlatform()) return
    let cancelled = false
    let handle = null
    ;(async () => {
      try {
        handle = await Volume.addListener('volumeButtonPressed', (ev) => {
          if (ev?.direction === 'down') nextPageRef.current?.()
          else if (ev?.direction === 'up') prevPageRef.current?.()
        })
        if (cancelled) { try { await handle.remove() } catch { /* ignore */ } return }
        await Volume.startWatching({ suppressVolumeChange: true })
      } catch { /* plugin unavailable on this build: volume keys simply do nothing */ }
    })()
    return () => {
      cancelled = true
      const h = handle
      handle = null
      ;(async () => {
        try { if (h) await h.remove() } catch { /* ignore */ }
        try { await Volume.stopWatching() } catch { /* ignore */ }
      })()
    }
  }, [view, volumeKeysTurnPages])
  function cancelFlipAnim() {
    if (flipAnimRef.current) { cancelAnimationFrame(flipAnimRef.current); flipAnimRef.current = null }
  }
  // Animate a flip from its current progress to `to` (0 = snap back,
  // 1 = complete), then either commit the turn or cancel it. The
  // haptic fires ONLY on a completed turn: light for a page,
  // medium for a chapter change — never on a snap-back.
  function animateFlipTo(to, dir, boundary) {
    cancelFlipAnim()
    const from = flipRef.current ? flipRef.current.progress : 0
    const start = performance.now()
    const dur = 280
    const step = (now) => {
      const k = Math.min(1, (now - start) / dur)
      const eased = 1 - Math.pow(1 - k, 3)
      const progress = from + (to - from) * eased
      if (k < 1) {
        setFlipState({ dir, progress, boundary })
        flipAnimRef.current = requestAnimationFrame(step)
      } else if (to >= 1) {
        setFlipState(null)
        if (boundary) pageTurnHaptic('medium')
        else pageTurnHaptic('light')
        commitTurn(dir)
      } else {
        setFlipState(null)
      }
    }
    flipAnimRef.current = requestAnimationFrame(step)
  }
  function requestTurn(dir) {
    if (readerFallback || flipRef.current || !chapters.length) return
    const r = nextPageIndex(pageIndexRef.current, pageCountRef.current, dir)
    const boundary = r.chapterChange && (
      (dir > 0 && chapterIndex < chapters.length - 1) ||
      (dir < 0 && chapterIndex > 0)
    )
    if (r.chapterChange && !boundary) return // at the very start/end of the book
    setFlipState({ dir, progress: 0, boundary })
    animateFlipTo(1, dir, boundary)
  }
  function nextPage() { requestTurn(1) }
  function prevPage() { requestTurn(-1) }
  useEffect(() => { nextPageRef.current = nextPage; prevPageRef.current = prevPage })

  // v0.7.0 pagination: measure the ACTUAL visible page area
  // (clientWidth/clientHeight via ResizeObserver + a measure on
  // mount), split the chapter into real pages with
  // paginateChapterDom, and show one page div. Re-paginates
  // (debounced) on font-size, theme, chapter, and container resize.
  // If measurement fails or returns 0, readerFallback is set and the
  // whole chapter renders scrollable — never clipped, never lost.
  useEffect(() => {
    if (backDestinationFor(view) && (!historyEntryRef.current || historyEntryRef.current.view !== view)) {
      try { window.history.pushState({ shelfsortBack: view }, '') } catch { /* history unavailable */ }
      historyEntryRef.current = { view }
    }
  }, [view])
  useEffect(() => {
    if (view !== 'reader') return
    window.scrollTo(0, 0)
    if (!historyEntryRef.current || historyEntryRef.current.view !== 'reader') {
      try { window.history.pushState({ shelfsortReader: true }, '') } catch { /* history unavailable: in-app exit still works */ }
      historyEntryRef.current = { view: 'reader' }
    }
  }, [view])
  useEffect(() => {
    if (view !== 'reader' || !chapters.length) return
    let cancelled = false
    let timer = null
    const doPaginate = () => {
      if (cancelled) return
      const area = pageAreaRef.current
      const measurer = measurerRef.current
      const html = chapters[chapterIndex]?.html || ''
      const w = area ? area.clientWidth : 0
      const h = area ? area.clientHeight : 0
      if (!w || !h || !measurer) {
        // No size yet (first paint): retry once, then fall back.
        if (!area || !measurer) return
        setReaderFallback(true)
        setPages([{ html, text: '' }])
        setPageCount(1)
        pageCountRef.current = 1
        return
      }
      pageAreaSizeRef.current = { w, h }
      // Style the measurer exactly like a visible page so measured
      // heights match rendered heights. The page area has 16px
      // padding on each side, so the page content width is the area
      // width minus 32 — the measurer is sized to that, not to the
      // full area width, or every page would be measured 32px too
      // wide (the old reader's drift bug, in a new form).
      measurer.style.width = `${Math.max(1, w - 32)}px`
      measurer.style.fontSize = `${fontSize}px`
      try {
        const newPages = paginateChapterDom(html, measurer, h)
        const count = Math.max(1, newPages.length)
        const fontChanged = prevReaderFontRef.current !== fontSize
        const chapterChanged = prevReaderChapterRef.current !== chapterIndex
        prevReaderFontRef.current = fontSize
        prevReaderChapterRef.current = chapterIndex
        let p = pageIndexRef.current
        if (pagePendingRef.current === 'last') p = count - 1
        else if (pagePendingRef.current && typeof pagePendingRef.current === 'object' && pagePendingRef.current.page != null) p = Math.min(count - 1, Math.max(0, pagePendingRef.current.page))
        else if (pagePendingRef.current && typeof pagePendingRef.current === 'object' && pagePendingRef.current.frac != null) p = Math.min(count - 1, Math.max(0, Math.floor(pagePendingRef.current.frac * count)))
        else if (fontChanged && pageCountRef.current > 1) p = Math.min(count - 1, Math.max(0, Math.round((pageIndexRef.current / pageCountRef.current) * count)))
        else p = Math.min(count - 1, Math.max(0, p))
        pagePendingRef.current = null
        const oldCount = pageCountRef.current
        setReaderFallback(false)
        setPages(newPages)
        pageCountRef.current = count
        setPageCount(count)
        if (p !== pageIndexRef.current || count !== oldCount) {
          pageIndexRef.current = p
          setPageIndex(p)
          if (selected && (p !== (selected.progress?.page || 0) || chapterChanged)) {
            saveReaderPage(selected, chapterIndex, p, count, chapters.length)
          }
        }
      } catch (e) {
        // Measurement failed: scrollable whole chapter, never clip.
        setReaderFallback(true)
        setPages([{ html, text: '' }])
        setPageCount(1)
        pageCountRef.current = 1
      }
    }
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(doPaginate, 120) }
    const raf = requestAnimationFrame(() => { const t = setTimeout(doPaginate, 30); return t })
    let ro = null
    if (typeof ResizeObserver !== 'undefined' && pageAreaRef.current) {
      ro = new ResizeObserver(() => {
        const a = pageAreaRef.current
        if (!a) return
        const s = pageAreaSizeRef.current
        if (Math.abs(a.clientWidth - s.w) > 2 || Math.abs(a.clientHeight - s.h) > 2) schedule()
      })
      ro.observe(pageAreaRef.current)
    }
    window.addEventListener('resize', schedule)
    return () => { cancelled = true; cancelAnimationFrame(raf); if (timer) clearTimeout(timer); if (ro) ro.disconnect(); window.removeEventListener('resize', schedule) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, chapterIndex, chapters, fontSize, readerTheme])

  // Full 3D flip drag: the flip follows the finger. Dragging left
  // turns forward, right turns back; progress = |dx| / page width.
  // On release, past ~25% width or a fast flick completes the flip
  // (and the turn); otherwise it snaps back with no page change and
  // no haptic. A tap (no drag) is handled by onReaderClick.
  const readerTouch = useRef(null)
  function onReaderTouchStart(e) {
    cancelFlipAnim()
    const t = e.touches[0]
    // In-app back band: a touch STARTING 56-160px from the left
    // edge is an EXIT candidate, not a page turn. A touch starting
    // in the system gesture zone (<~56px) is NOT an exit candidate
    // — it is left to the system back gesture (see the backButton
    // listener), so the Pixel can no longer steal/confuse it.
    // Anything starting further right is a normal page-turn swipe,
    // whatever direction it goes. The distinction is made HERE, at
    // touch start — not by direction — so a rightward swipe from
    // the middle of the page still turns to the previous page, and
    // only a band-origin rightward swipe exits.
    readerTouch.current = { x: t.clientX, t: Date.now(), moved: false, edge: t.clientX >= 56 && t.clientX <= 160 }
  }
  function onReaderTouchMove(e) {
    const d = readerTouch.current
    if (!d || readerFallback || !chapters.length) return
    const t = e.touches[0]
    const dx = t.clientX - d.x
    const w = pageAreaRef.current ? pageAreaRef.current.clientWidth : 300
    if (d.edge && dx > 8) {
      // Edge-origin rightward drag: follow the finger as an exit
      // drag, and do NOT start a page flip at all.
      setEdgeOffset(Math.min(dx, w * 0.9))
      d.moved = true
      return
    }
    if (d.edge && dx < 0) d.edge = false // edge-origin LEFT swipe is a normal next-page turn
    if (Math.abs(dx) > 8) {
      d.moved = true
      const dir = dx < 0 ? 1 : -1
      const r = nextPageIndex(pageIndexRef.current, pageCountRef.current, dir)
      const boundary = r.chapterChange && (
        (dir > 0 && chapterIndex < chapters.length - 1) ||
        (dir < 0 && chapterIndex > 0)
      )
      if (r.chapterChange && !boundary) return // book edge: no flip, no turn
      setFlipState({ dir, progress: Math.min(1, Math.abs(dx) / w), boundary })
    }
  }
  function onReaderTouchEnd(e) {
    const d = readerTouch.current
    readerTouch.current = null
    if (d && d.edge && d.moved) {
      // Band-origin rightward swipe: past ~80px (or 25% of the width)
      // it exits; otherwise it snaps back with no page change and
      // no haptic. It never turns a page. (A plain tap in the band
      // is NOT a swipe: it falls through to the click handler and
      // behaves as a normal tap.)
      const t = e.changedTouches[0]
      const dx = t.clientX - d.x
      const w = pageAreaRef.current ? pageAreaRef.current.clientWidth : 300
      suppressClickRef.current = true
      if (dx > 80 || dx > w * 0.25) exitReader()
      else setEdgeOffset(0)
      return
    }
    const f = flipRef.current
    if (!d || !d.moved || !f) return
    suppressClickRef.current = true
    const t = e.changedTouches[0]
    const dx = t.clientX - d.x
    const dt = Math.max(1, Date.now() - d.t)
    const w = pageAreaRef.current ? pageAreaRef.current.clientWidth : 300
    const flick = Math.abs(dx) > 50 && (Math.abs(dx) / dt) > 0.5 // px/ms
    if (Math.abs(dx) > w * 0.25 || flick) animateFlipTo(1, f.dir, f.boundary)
    else animateFlipTo(0, f.dir, f.boundary)
  }
  function onReaderClick(e) {
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    if (e.target && e.target.closest && e.target.closest('a,button,input,select,textarea,label')) return
    if (readerFallback) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / Math.max(1, rect.width)
    if (frac < 0.3) prevPage()
    else if (frac > 0.7) nextPage()
    else setReaderToolbar((v) => !v)
  }

  // Pull-to-refresh: library + series + Unsorted views only, and only when the
  // page is already scrolled to the top, so normal vertical scrolling
  // is untouched. No preventDefault: the indicator follows the pull
  // and a release past the threshold reloads metadata from IndexedDB.
  function onPtrTouchStart(e) {
    // Global back swipe (all back-able views except the reader,
    // which handles its own band swipe on its page area): a touch
    // STARTING 56-160px from the left edge is an EXIT candidate,
    // distinguished at touch start, not by direction — so a
    // rightward swipe from the middle of the page is NOT an exit.
    // The system gesture zone (<~56px) is left to the system back
    // gesture, same as in the reader.
    if (view !== 'reader' && backDestinationFor(view) && e.touches[0].clientX >= 56 && e.touches[0].clientX <= 160) {
      navEdgeRef.current = { x: e.touches[0].clientX, t: Date.now(), moved: false }
    }
    if (!['library', 'series', 'series-detail', 'unsorted'].includes(view)) return
    if (window.scrollY > 0) return
    ptrStartY.current = e.touches[0].clientY
  }
  function onPtrTouchMove(e) {
    const ne = navEdgeRef.current
    if (ne) {
      const dx = e.touches[0].clientX - ne.x
      if (dx > 8) {
        ne.moved = true
        const w = window.innerWidth || 300
        setNavEdgeOffset(Math.min(dx, w * 0.9))
        return
      }
      if (dx < -8) navEdgeRef.current = null // edge-origin LEFT drag is not an exit
    }
    if (ptrStartY.current == null || ptrRefreshing) return
    const dy = e.touches[0].clientY - ptrStartY.current
    const d = dy > 0 ? Math.min(dy, 90) : 0
    pullDistRef.current = d
    setPullDist(d)
  }
  async function onPtrTouchEnd(e) {
    const ne = navEdgeRef.current
    navEdgeRef.current = null
    if (ne && ne.moved) {
      const dx = e && e.changedTouches ? e.changedTouches[0].clientX - ne.x : 0
      const w = window.innerWidth || 300
      navEdgeClickBlockRef.current = Date.now()
      if (dx > 80 || dx > w * 0.25) { setNavEdgeOffset(0); navigateBack(view); return }
      setNavEdgeOffset(0)
      return
    }
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
        // For the current chapter the hit jumps to its ACTUAL page
        // (pages are real page divs, so the page is looked up, not
        // estimated). For other chapters the fraction is converted
        // to a real page once that chapter is paginated.
        const page = i === chapterIndex && pages.length ? findPageForText(pages, q) : -1
        hits.push({ chapter: i, title: ch.title, snippet: ch.text.slice(Math.max(0, idx - 60), idx + 120), page: page >= 0 ? page : null, frac: idx / Math.max(1, ch.text.length) })
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
  const headerTitle = view === 'series' || view === 'series-detail' ? 'Series' : view === 'unsorted' ? 'Unsorted' : view === 'settings' ? 'Settings' : view === 'fixes' ? 'Fix Review' : 'Library'
  const detail = selected && books.find((b) => b.id === selected.id)
  const detailPair = detail ? linkedPairFor(detail) : null
  const detailAuto = detail ? autoMatchFor(detail) : null

  return (
    <>
      {view !== 'reader' && <header className="topbar">
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
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>Settings</button>
        </nav>
        {searchOpen && (
          <input className="top-search" type="search" placeholder="Search title, author, or series…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        )}
      </header>}

      <main className={view === 'reader' ? 'reader-main' : ''} style={navEdgeOffset ? { transform: `translateX(${navEdgeOffset}px)` } : undefined} onTouchStart={onPtrTouchStart} onTouchMove={onPtrTouchMove} onTouchEnd={onPtrTouchEnd} onClickCapture={(e) => { if (Date.now() - navEdgeClickBlockRef.current < 300) { e.preventDefault(); e.stopPropagation() } }}>
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

            {scanOnStartup && watchedFolders.length > 0 && !watchPromptDismissed && (
              <div className="card">
                <p><strong>Watched folders saved:</strong> {watchedFolders.map((w) => w.name).join(', ')}.</p>
                <p className="progress">Android does not let this app reopen a saved folder on its own. Tap Rescan to pick them again and import any new books.</p>
                <div className="toolbar">
                  <button onClick={() => { folderPickModeRef.current = 'rescan'; folderRef.current.click() }}>Rescan watched folders</button>
                  <button className="secondary" onClick={() => setWatchPromptDismissed(true)}>Dismiss</button>
                </div>
                {watchStatus && <p className="progress">{watchStatus}</p>}
              </div>
            )}

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
              <input ref={folderRef} type="file" accept=".epub,.pdf,.cbz,.cbr,.m4b,.mp3" multiple hidden webkitdirectory=""
                onChange={(e) => { const mode = folderPickModeRef.current; folderPickModeRef.current = 'library'; handleFolderPick(e.target.files, mode); e.target.value = '' }} />
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
                {filtered.map((b) => <BookGridCard key={b.id} book={b} onOpen={openDirect} onDetail={openBook} />)}
              </div>
            ) : (
              <div className="book-list">
                {filtered.map((b) => <BookRow key={b.id} book={b} onOpen={openDirect} onDetail={openBook} />)}
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
            <h2>{seriesDetail.name}</h2>
            {seriesDetail.gaps.length > 0 && (
              <p className="gap">⚠️ Missing in this series: {seriesDetail.gaps.map((n) => `#${n}`).join(', ')} — you own {seriesDetail.books.map((b) => getSeries(b).index).filter((n) => n !== null).join(', ')}.</p>
            )}
            <div className="book-list">
              {seriesDetail.books.map((b) => <BookRow key={b.id} book={b} onOpen={openDirect} onDetail={openBook} />)}
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
            </div>
            {enrichStatus && <p className="progress">{enrichStatus}</p>}
            {!books.filter(isUnsorted).filter(matchesFormatTab).length ? (
              <div className="card"><p>Unsorted shelf is empty{formatTab !== 'all' ? ' for this bottom tab — try All' : ''}. Every book in the library has a series, or a real title + author + cover.</p></div>
            ) : (
              <div className="book-list">
                {books.filter(isUnsorted).filter(matchesFormatTab).map((b) => <BookRow key={b.id} book={b} onOpen={openDirect} onDetail={openBook} />)}
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
              <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={volumeKeysTurnPages} onChange={(e) => setVolumeKeysTurnPages(e.target.checked)} />
                Volume keys turn pages (in the reader: volume down = next page, volume up = previous page; the volume itself does not change while reading)
              </label>
              <p className="progress">ShelfSort v0.7.1</p>
            </div>
            <div className="card">
              <h2>Library folders (re-pick on each scan — Android does not let this app keep folder access between starts)</h2>
              <p className="progress">Save a folder here and it will be listed below. On startup the app only reminds you to rescan — it cannot silently reopen a saved folder. Rescanning re-opens the phone's folder picker; you pick the folder again and only books not already in the library are imported. No file handles or folder access are stored, only the folder name.</p>
              <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={scanOnStartup} onChange={(e) => setScanOnStartup(e.target.checked)} />
                Scan watched folders on startup (show the rescan prompt in the Library)
              </label>
              <div className="toolbar">
                <button onClick={() => watchFolderRef.current.click()}>Add folder</button>
                <button className="secondary" disabled={!watchedFolders.length} onClick={() => { watchPickModeRef.current = 'rescan'; watchFolderRef.current.click() }}>Rescan watched folders</button>
              </div>
              <input ref={watchFolderRef} type="file" accept=".epub,.pdf,.cbz,.cbr,.m4b,.mp3" multiple hidden webkitdirectory=""
                onChange={(e) => { const mode = watchPickModeRef.current; watchPickModeRef.current = 'add'; handleFolderPick(e.target.files, mode); e.target.value = '' }} />
              {!watchedFolders.length ? (
                <p className="progress">No watched folders yet. Add one with the button above.</p>
              ) : (
                watchedFolders.map((w) => (
                  <div key={w.name} className="toolbar" style={{ justifyContent: 'space-between' }}>
                    <span className="progress"><strong>{w.name}</strong>{w.lastCount !== undefined ? ` — ${w.lastCount} book file(s) found on last scan` : ''}</span>
                    <button className="secondary" onClick={() => setWatchedFolders((prev) => prev.filter((x) => x.name !== w.name))}>Remove</button>
                  </div>
                ))
              )}
              {watchStatus && <p className="progress">{watchStatus}</p>}
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
              <h2>Muse catalog — export / import</h2>
              <p className="progress">Let Muse sort the whole catalog — series, series order, authors, titles — without any backdoor or live access to your phone. Export a metadata-only catalog, share that file, then import the corrected file back. Nothing is applied until you press Apply, and import only changes title, author, publisher, date, ISBN, description, series, and series number. Book files, covers, reading progress, and cloud credentials are never in a catalog file and are never changed by an import.</p>
              <div className="toolbar">
                <button onClick={exportCatalog} disabled={!books.length}>Export catalog ({books.length})</button>
                <button className="secondary" onClick={() => catalogFileRef.current.click()}>Import catalog…</button>
              </div>
              <input ref={catalogFileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { if (e.target.files[0]) previewCatalogFile(e.target.files[0]); e.target.value = '' }} />
              {catalogStatus && <p className="progress">{catalogStatus}</p>}
              {catalogPreview && (
                <div>
                  <p className="progress">{catalogPreview.changes.length} book{catalogPreview.changes.length === 1 ? '' : 's'} would change, {catalogPreview.unchanged} unchanged, {catalogPreview.unmatched.length} unmatched and skipped.</p>
                  {catalogPreview.changes.slice(0, 20).map((c) => (
                    <div key={c.bookId} className="progress">
                      <strong>{c.title || c.fileName}</strong>: {c.diffs.map((d) => `${d.field}: ${d.from === null || d.from === '' ? '—' : d.from} → ${d.to === null || d.to === '' ? '—' : d.to}`).join(' · ')}
                    </div>
                  ))}
                  {catalogPreview.changes.length > 20 && <p className="progress">…and {catalogPreview.changes.length - 20} more.</p>}
                  <div className="toolbar">
                    <button onClick={applyCatalogPreview}>Apply these changes</button>
                    <button className="secondary" onClick={() => setCatalogPreview(null)}>Cancel</button>
                  </div>
                </div>
              )}
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
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
              {coverFor(detail) ? <img src={coverFor(detail)} alt="" style={{ width: 160, borderRadius: 8 }} /> : <div className="cover" style={{ width: 160 }}>No cover</div>}
              <div style={{ flex: 1, minWidth: 240 }}>
                <h2>{detail.metadata.title}</h2>
                <p>{detail.metadata.author || 'Unknown author'} · {formatLabel(detail)}</p>
                <p>Publisher: {detail.metadata.publisher || '—'} · Date: {detail.metadata.date || '—'} · ISBN: {detail.metadata.isbn || '—'}</p>
                <p>Series: {detail.metadata.series || getSeries(detail).name || '—'} {detail.metadata.seriesIndex ? `#${detail.metadata.seriesIndex}` : ''}</p>
                <p>{cleanDescription(detail.metadata.description) || 'No description in this file.'}</p>
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
                <p className="progress">Status: {statusOf(detail)} · {detail.hasFile ? '📱 Local' : 'Download on open'}</p>
                {(!detail.hasFile && detail.r2Key) && (
                  <div className="toolbar">
                    <button onClick={() => openBook(detail)}>Download & open</button>
                  </div>
                )}
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

        {view === 'fixes' && (
          <div>
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
          <div className={`reader-screen ${readerTheme}`} style={edgeOffset ? { transform: `translateX(${edgeOffset}px)` } : undefined}>
            <div className="toolbar reader-header">
              
              <span className="reader-title">{selected.metadata.title}</span>
              <button className="secondary" onClick={() => setReaderToolbar((v) => !v)} aria-label="Reader settings">Aa</button>
            </div>
            {readerToolbar && (
              <>
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
                      <div key={i}><button className="secondary" onClick={() => { pagePendingRef.current = h.page != null ? { page: h.page } : { frac: h.frac }; goToChapter(selected, h.chapter, chapters.length, 0); setReaderHits([]) }}>{h.title}</button> …{h.snippet}…</div>
                    ))}
                  </div>
                )}
              </>
            )}
            {!chapters.length ? <p className="progress">Loading chapters…</p> : readerFallback ? (
              <div className="reader-scroll" style={{ ['--reader-size']: `${fontSize}px` }} dangerouslySetInnerHTML={{ __html: chapters[chapterIndex]?.html || '<p>No readable chapter content found in this EPUB.</p>' }} />
            ) : (
              <>
                <div className="reader-page-area" ref={pageAreaRef} onTouchStart={onReaderTouchStart} onTouchMove={onReaderTouchMove} onTouchEnd={onReaderTouchEnd} onClick={onReaderClick}>
                  <div ref={measurerRef} className="reader-measurer" aria-hidden="true" />
                  {(() => {
                    const cur = pages[pageIndex] || pages[0] || { html: '', text: '' }
                    if (!flip) {
                      return <div className="reader-page" style={{ ['--reader-size']: `${fontSize}px` }} dangerouslySetInnerHTML={{ __html: cur.html }} />
                    }
                    const targetPage = flip.boundary ? null : pages[pageIndex + flip.dir]
                    const angle = flip.dir > 0 ? -180 * flip.progress : 180 * flip.progress
                    const origin = flip.dir > 0 ? 'left center' : 'right center'
                    const lift = Math.sin(Math.PI * flip.progress)
                    // Curl-like fold: the fold line sweeps across the page
                    // as the flip progresses — for a next turn it travels
                    // right-to-left (fold at (1-progress)*100% from the
                    // left), mirrored for a previous turn. Dark band at
                    // the fold, light highlight just on the lifted side
                    // of it. Single left-to-right gradient in both
                    // directions so the stops stay monotonic.
                    const foldPct = flip.dir > 0 ? (1 - flip.progress) * 100 : flip.progress * 100
                    const foldBg = flip.dir > 0
                      ? `linear-gradient(to right, rgba(0,0,0,0) ${Math.max(0, foldPct - 10)}%, rgba(0,0,0,0.5) ${foldPct}%, rgba(255,255,255,0.16) ${Math.min(100, foldPct + 6)}%, rgba(0,0,0,0) ${Math.min(100, foldPct + 14)}%)`
                      : `linear-gradient(to right, rgba(0,0,0,0) ${Math.max(0, foldPct - 14)}%, rgba(255,255,255,0.16) ${Math.max(0, foldPct - 6)}%, rgba(0,0,0,0.5) ${foldPct}%, rgba(0,0,0,0) ${Math.min(100, foldPct + 10)}%)`
                    return (
                      <div className="reader-flip-stage">
                        <div className="reader-page reader-page-under" style={{ ['--reader-size']: `${fontSize}px` }} dangerouslySetInnerHTML={{ __html: targetPage ? targetPage.html : '' }} />
                        <div className="reader-flip-under-shadow" style={{ opacity: 0.35 * lift, background: flip.dir > 0 ? 'linear-gradient(to right, rgba(0,0,0,0.45), rgba(0,0,0,0) 55%)' : 'linear-gradient(to left, rgba(0,0,0,0.45), rgba(0,0,0,0) 55%)' }} aria-hidden="true" />
                        <div className="reader-page reader-page-top" style={{ ['--reader-size']: `${fontSize}px`, transform: `rotateY(${angle}deg) scale(${1 - 0.03 * lift}) translateZ(${28 * lift}px)`, transformOrigin: origin }} dangerouslySetInnerHTML={{ __html: cur.html }} />
                        <div className="reader-flip-fold" style={{ background: foldBg }} aria-hidden="true" />
                        <div className="reader-flip-shadow" style={{ opacity: 0.55 * lift, background: flip.dir > 0 ? 'linear-gradient(to left, rgba(0,0,0,0.6), rgba(0,0,0,0) 60%)' : 'linear-gradient(to right, rgba(0,0,0,0.6), rgba(0,0,0,0) 60%)' }} aria-hidden="true" />
                      </div>
                    )
                  })()}
                </div>
                <div className="toolbar reader-footer">
                  <button className="secondary" onClick={prevPage}>←</button>
                  <span className="progress">Page {pageIndex + 1} of {pageCount} · Chapter {chapterIndex + 1} of {chapters.length} · {pageCount ? Math.round(((pageIndex + 1) / pageCount) * 100) : 0}%</span>
                  <button className="secondary" onClick={nextPage}>→</button>
                </div>
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
      <h2>🎧 {book.metadata.title}</h2>
      <p>{book.metadata.author || 'Unknown author'}</p>
      {playerMode === 'native' && <p className="progress">Native player — keeps playing in the background, with lock-screen / notification controls.</p>}
      {playerMode === 'html' && <p className="progress">In-app player (web fallback).</p>}
      {loading && <p className="progress">Loading audio…</p>}
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
    if (!audioBook || (!audioBook.file && !audioBook.audioFileUri)) return
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
  }, [audioBook && audioBook.id, audioBook && audioBook.file, audioBook && audioBook.audioFileUri])

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
          <h2>Read-along</h2>
        <p>No audiobook is linked to this book yet. Link one from the book detail page (automatic suggestion, or the manual link dropdown), then come back here.</p>
      </div>
    )
  }

  return (
    <div className="card viewer">
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
