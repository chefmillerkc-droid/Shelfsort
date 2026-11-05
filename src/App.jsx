import { useEffect, useMemo, useRef, useState } from 'react'
import { getAllBooksMeta, getBookFile, putBookMeta, putBookFile, deleteBookFile, deleteBook, clearLibrary, saveProgressLocal, loadProgressLocal } from './lib/db.js'
import { parseEpub, parseChapters, fetchAsDataUrl, blobToDataUrl } from './lib/epub.js'
import { parsePdf, loadPdf, renderPdfPage, searchPdf } from './lib/pdf.js'
import { parseComic, loadComicPages } from './lib/comic.js'
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
import { storeAudioFileStream, deleteStoredAudio } from './lib/audioStore.js'
import { buildCorrectedEpub, downloadBlob } from './lib/exportEpub.js'
import { buildCatalog, parseCatalog, computeCatalogChanges } from './lib/catalog.js'
import { exportCatalogFile } from './lib/catalogExport.js'
import { findAudioMatch, findEpubMatch, mapChapters, audioChapterAtTime } from './lib/readalong.js'
import { folderNameOfFile, folderNameOfFiles, groupFilesByFolder, newFilesForRescan, isSupportedBookFile, listSafBookFiles, lazySafFile, base64ToArrayBuffer, dirOfFile, folderCoverRank } from './lib/watchedFolders.js'
import { groupAudioEntries, globalChapters, mapGlobalToPart, resumeForSaved, knownSums, cleanFolderName, lastSegmentOfDir, parentSegmentOfDir, naturalCompare } from './lib/multipart.js'
import { ScopedStorage } from '@daniele-rolli/capacitor-scoped-storage'
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
  if (book.format === 'comic') {
    const m = String(book.fileName || '').match(/\.([a-z0-9]+)$/i)
    return m ? m[1].toUpperCase() : 'Comic'
  }
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

// Shelf view: books standing upright on a shelf board, like physical
// books. CSS only, no image assets. Row count is viewport width only
// (never per-book measurement), so long libraries scroll exactly like
// the grid does — same cover data URLs, same book data, no canvas.
// Tap / long-press / scroll behaviour is the SAME usePressHandlers
// as BookRow and BookGridCard (<500ms tap = open, >=500ms hold =
// detail, >12px move = scroll, never opens). ShelfBook reuses
// coverFor + progressFraction; it does not invent metadata.
// Height variation is deterministic: a hash of the book id picks one
// of five cover heights (108-132px), so a given book is always the
// same height and rows stay bottom-aligned to the board. No-cover
// books render as a titled spine block in a deterministic muted
// colour (horizontal, wrapped, legible text — never a blank card).
const SHELF_PALETTE = ['#5b4a3a', '#3f5a50', '#4a5568', '#6b4a5a', '#555f3a', '#7a5a2e', '#3e4a6b', '#64403a']
function shelfHash(str) {
  let h = 0
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) >>> 0
  return h
}
function shelfColumns(width) {
  if (width < 480) return 4
  if (width < 768) return 5
  if (width < 1100) return 7
  return 9
}
// ShelfBook is cover-only on purpose: the board must sit directly
// under the covers, not under a caption. The caption lives below the
// board (ShelfCaption, same press handlers, same book), aligned to
// its book by identical flex widths/gaps, so tapping either the book
// or its caption opens (tap) / details (long-press) exactly like a
// grid card. Series goes in the accessible name; grid cards show no
// series line, so no visible series line is added here either.
function ShelfBook({ book, onOpen, onDetail }) {
  const cover = coverFor(book)
  const frac = progressFraction(book)
  const press = usePressHandlers(() => onOpen(book), () => onDetail(book))
  const h = shelfHash(book.id || book.metadata.title || '')
  const coverHeight = 108 + (h % 5) * 6 // 108, 114, 120, 126, 132px
  const blockColor = SHELF_PALETTE[h % SHELF_PALETTE.length]
  const series = getSeries(book).name
  return (
    <button
      className="shelf-book"
      {...press}
      aria-label={`${book.metadata.title}${book.metadata.author ? ` by ${book.metadata.author}` : ''}${series ? `, ${series}` : ''}`}
      title={`${book.metadata.title}${book.metadata.author ? ` — ${book.metadata.author}` : ''}`}
    >
      <span className="shelf-cover" style={{ height: `${coverHeight}px` }}>
        {cover ? (
          <img src={cover} alt="" />
        ) : (
          <span className="shelf-nocover" style={{ background: blockColor }}>
            <span className="shelf-nocover-title">{book.metadata.title}</span>
            {book.metadata.author && <span className="shelf-nocover-author">{book.metadata.author}</span>}
          </span>
        )}
        {frac > 0 && (
          <span className="shelf-progress" aria-hidden="true"><span style={{ width: `${Math.round(frac * 100)}%` }} /></span>
        )}
      </span>
    </button>
  )
}
function ShelfCaption({ book, onOpen, onDetail }) {
  const press = usePressHandlers(() => onOpen(book), () => onDetail(book))
  return (
    <button className="shelf-caption-btn" {...press} aria-label={book.metadata.title}>
      <span className="shelf-title">{book.metadata.title}</span>
      <span className="shelf-author">{book.metadata.author || 'Unknown author'}</span>
    </button>
  )
}
function ShelfRows({ books, onOpen, onDetail }) {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 400))
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const cols = shelfColumns(width)
  const rows = []
  for (let i = 0; i < books.length; i += cols) rows.push(books.slice(i, i + cols))
  return (
    <div className="shelf-wrap">
      {rows.map((row, ri) => (
        <div className="shelf-row" key={ri}>
          <div className="shelf-books">
            {row.map((b) => <ShelfBook key={b.id} book={b} onOpen={onOpen} onDetail={onDetail} />)}
          </div>
          <div className="shelf-board" aria-hidden="true" />
          <div className="shelf-captions">
            {row.map((b) => <ShelfCaption key={b.id} book={b} onOpen={onOpen} onDetail={onDetail} />)}
          </div>
        </div>
      ))}
    </div>
  )
}
export default function App() {
  const [books, setBooks] = useState([])
  const [view, setView] = useState('library') // library | detail | reader | fixes | pdf | comic | audio | readalong | series | series-detail | authors | author-detail | unsorted | settings | cloud
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
    if (v === 'author-detail') return 'authors'
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
  // Library view mode: list | grid | shelf. Shelf is the default for
  // a fresh install (no stored choice); a stored list/grid choice is
  // always kept, and any unknown stored value falls back to shelf.
  const [viewMode, setViewMode] = useState(() => {
    try {
      const v = localStorage.getItem('shelfsort-view')
      return ['list', 'grid', 'shelf'].includes(v) ? v : 'shelf'
    } catch { return 'shelf' }
  })
  const [statusTab, setStatusTab] = useState('all')
  const [searchOpen, setSearchOpen] = useState(false)
  const [seriesDetail, setSeriesDetail] = useState(null)
  // Author detail is a NAME, not a snapshot: the detail recomputes
  // its books live from the library, so the search box and format
  // tabs keep filtering inside an open author detail (series-detail
  // keeps its click-time snapshot, as before).
  const [authorDetail, setAuthorDetail] = useState(null)
  // Files for books currently OPEN only (0-2 books). The library list
  // itself is metadata-only, so 300 books never means 300 blobs in RAM.
  const [openFiles, setOpenFiles] = useState({})
  useEffect(() => { try { localStorage.setItem('shelfsort-view', viewMode) } catch { /* ignore */ } }, [viewMode])
  // Release open files whenever we leave a viewer/detail screen.
  useEffect(() => {
    if (['library', 'series', 'series-detail', 'authors', 'author-detail', 'unsorted', 'settings', 'cloud', 'fixes'].includes(view)) setOpenFiles({})
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
  // Cover auto-apply on exact title+author match. Default OFF: a
  // work-level cover can belong to a different edition, so this is
  // opt-in only, and fuzzy/first-result covers are never auto-applied
  // under it (enrich.js gates on high confidence). When on, the cover
  // is recorded in the book's autoApplied list like any auto-fix.
  const [autoApplyCoversExact, setAutoApplyCoversExact] = useState(() => {
    try { return localStorage.getItem('shelfsort-auto-apply-covers-exact') === 'on' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('shelfsort-auto-apply-covers-exact', autoApplyCoversExact ? 'on' : 'off') } catch { /* ignore */ }
  }, [autoApplyCoversExact])
  // True when the current Fix Review list came from a cover-only
  // scan, so the review UI renders the thumbnail grid instead of
  // the generic field list. Cleared by any other enrichment run.
  const [coverReview, setCoverReview] = useState(false)
  // Watched library folders. Two kinds: SAF folders (v0.7.2, saved
  // tree URI + persistable permission — re-listed on startup with
  // no re-pick) and legacy WebView folders (NAME ONLY in
  // localStorage — a WebView <input> pick cannot persist a folder
  // handle, so those still need re-picking on rescan).
  // See src/lib/watchedFolders.js.
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
  // Comic viewer defaults (Settings): manga mode (right-to-left)
  // and webtoon mode (vertical strip) for newly opened comics.
  // Both are also per-comic toggles in the viewer, remembered on
  // that book's progress — the per-comic choice wins over these
  // defaults once set. Both default OFF (normal left-to-right,
  // one-page-at-a-time), matching Kuro's opt-in modes.
  const [mangaDefault, setMangaDefault] = useState(() => {
    try { return localStorage.getItem('shelfsort-manga-default') === 'on' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('shelfsort-manga-default', mangaDefault ? 'on' : 'off') } catch { /* ignore */ } }, [mangaDefault])
  const [webtoonDefault, setWebtoonDefault] = useState(() => {
    try { return localStorage.getItem('shelfsort-webtoon-default') === 'on' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem('shelfsort-webtoon-default', webtoonDefault ? 'on' : 'off') } catch { /* ignore */ } }, [webtoonDefault])
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
  // Native SAF folders (v0.7.2): a tree URI kept with a persistable
  // permission, so it CAN be re-listed on a later start with no
  // re-pick — unlike WebView picks, which are name-only. Legacy
  // entries (no `saf` flag) still use the WebView picker path.
  const safStartupDoneRef = useRef(false)
  // Per-folder rescan for legacy (WebView) rows: the next 'rescan'
  // folder pick matches ONLY this name instead of every saved name.
  const legacyRescanTargetRef = useRef(null)
  const isNative = (() => { try { return Capacitor.isNativePlatform() } catch { return false } })()
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
  // Progressive import (v0.7.5), BATCHED (v0.7.5 crash fix): a book
  // appears in the Library DURING its batch, not only at the end —
  // but NOT one setBooks per book. An unthrottled append per book
  // re-renders the whole Library (hundreds of cover images, no
  // virtualization) per book, and each setImportStatus already
  // re-renders App per book — over a 373-file batch that starves
  // the WebView event loop and is a plausible contributor to the
  // "ShelfSort keeps stopping" crash dialog the user saw on v0.7.4.
  // So appends are buffered and flushed in batches: every 10 books
  // OR every 500 ms since the last flush, whichever comes first,
  // plus a final flush at the end of the import (before the final
  // reload() consistency pass). A small batch (<= 10 books) is
  // covered by that final flush, so it still appears promptly.
  // The 500 ms timer is best-effort wall-clock time: it cannot fire
  // during synchronous parsing work, only while the loop awaits
  // (file reads, IndexedDB writes) — which is where a large import
  // actually spends its time. Metadata only — never a file blob,
  // the same shape reload() returns. Dedupe by id, both inside the
  // buffer and against existing state: the final reload() replaces
  // state wholesale anyway, so a flush plus reload can never yield
  // two entries for one book. Callers must queue ONLY after the
  // book's commit fully succeeds (never on error, never for a
  // half-stored audio group — see importFiles/importSafAudio).
  // Each batcher is created per import call and must be flushed by
  // that call before it returns — never shared across imports.
  const APPEND_BATCH_SIZE = 10
  const APPEND_BATCH_MS = 500
  function createLibraryAppendBatcher() {
    let pending = []
    let timer = null
    function flush() {
      if (timer) { clearTimeout(timer); timer = null }
      if (!pending.length) return
      const batch = pending
      pending = []
      setBooks((prev) => {
        const ids = new Set(prev.map((b) => b.id))
        const fresh = batch.filter((b) => b && b.id && !ids.has(b.id))
        return fresh.length ? [...prev, ...fresh] : prev
      })
    }
    function queue(meta) {
      if (!meta || !meta.id) return
      if (pending.some((b) => b.id === meta.id)) return
      pending.push(meta)
      if (pending.length >= APPEND_BATCH_SIZE) flush()
      else if (!timer) timer = setTimeout(flush, APPEND_BATCH_MS)
    }
    return { queue, flush }
  }
  // Periodic yield on the same batch boundary: lets the WebView
  // event loop, GC, and UI breathe during a multi-hundred-file
  // import. Zero-timeout only, and only every 10 books — never
  // per book, which would slow the import for no benefit.
  async function yieldToEventLoop() {
    await new Promise((r) => setTimeout(r, 0))
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
    if (/\.cbz$/i.test(name) || /\.cbr$/i.test(name) || /\.cbt$/i.test(name) || /\.cb7$/i.test(name)) {
      // CBZ via JSZip, CBR/CBT/CB7 via libarchive.js (WASM). A parse
      // failure here fails just this file's import (importFiles
      // catches per file) — never a fake open, never a batch crash.
      // ComicInfo.xml inside the archive supplies series/author/
      // date/description when present; filename fallback otherwise.
      return { format: 'comic', metadata: await parseComic(buf, name), extra: {} }
    }
    if (/\.m4b$/i.test(name) || /\.m4a$/i.test(name) || /\.mp4$/i.test(name)) {
      // M4A and MP4 are the same MP4 audio container as M4B (M4B is
      // just the bookmarkable audiobook variant), so they parse
      // identically. MP4 here is treated as AUDIO: an MP4 video
      // track, if any, is ignored by the audio-only player — no
      // video player is built for it.
      const parsed = parseAudio(buf, name)
      return { format: 'audio', metadata: { ...parsed, chapters: undefined }, extra: { audioChapters: parsed.chapters, durationSec: parsed.durationSec, album: parsed.album } }
    }
    if (/\.mp3$/i.test(name)) {
      const tags = parseMp3Tags(buf, name)
      return { format: 'audio', metadata: { title: tags.title, titleFromFilename: tags.titleFromFilename, author: tags.author, creators: tags.author ? [tags.author] : [], language: '', publisher: '', date: '', description: '', identifier: '', isbn: '', series: '', seriesIndex: '', coverDataUrl: '' }, extra: { audioChapters: [], durationSec: null, album: tags.album } }
    }
    throw new Error('Unsupported file type')
  }

  // Folder covers for a WebView folder pick (v0.7.4): the caller
  // passes the UNFILTERED picked list so sibling images are visible
  // here (importFiles itself filters to book files). Keyed by the
  // file's directory, best priority wins. A cover file is kilobytes,
  // so reading it whole is fine — unlike the audio file itself.
  function buildFolderCoverMap(allFiles) {
    const map = new Map()
    for (const f of allFiles || []) {
      const rank = folderCoverRank(f.name)
      if (rank < 0) continue
      const dir = dirOfFile(f)
      const cur = map.get(dir)
      if (!cur || rank < cur.rank) map.set(dir, { file: f, rank })
    }
    return map
  }

  async function importFiles(fileList, folderCovers) {
    const files = [...fileList].filter((f) => /\.(epub|pdf|cbz|cbr|cbt|cb7|m4b|m4a|mp4|mp3)$/i.test(f.name))
    if (!files.length) { setImportStatus('No supported files found (.epub, .pdf, .cbz, .cbr, .cbt, .cb7, .m4b, .m4a, .mp4, .mp3).'); return }
    setImportStatus(`Importing ${files.length} file(s)…`)
    setImportErrors([])
    const errors = []
    let imported = 0
    // Batch throttling (v0.7.5 crash fix): appends, status, and
    // yields all happen on the same batch boundary — every 10
    // successfully imported books, plus a final flush at the end.
    const appendBatch = createLibraryAppendBatcher()
    // One book at a time, committed immediately: meta + file are each
    // written before moving on, so a crash mid-import keeps everything
    // imported so far and the user can simply re-import the rest.
    // Only one file buffer is alive at a time; nothing is accumulated.
    // AUDIO (v0.7.4 — the large-audiobook fix): an audio entry is
    // NEVER read whole here. Metadata is parsed from a head slice
    // only (first 16 MB, where the MP4 moov/ilst/chpl boxes and the
    // MP3 ID3 header live); the file itself is stored later by
    // slicing (native) or, for small files on web, by one whole read
    // of a <= 50 MB file. A moov box at the END of a large file is
    // therefore NOT parsed: duration is null and chapters are []
    // for that file, and the native player reports the real duration
    // once it plays — bookmarks are the documented fallback for
    // chapterless files. This is stated, not hidden: do not claim
    // chapters/duration were parsed when they were not.
    const LARGE_AUDIO = 50 * 1024 * 1024
    const HEAD_BYTES = 16 * 1024 * 1024
    const audioEntries = []
    for (const file of files) {
      try {
        const isAudio = /\.(m4b|m4a|mp4|mp3)$/i.test(file.name)
        if (isAudio) {
          // SAF lazy files never reach this path for audio (the SAF
          // importer handles them in place — see importSafAudio);
          // this guard exists so no code path can ever whole-read a
          // large SAF file by accident.
          if (file.safRef) throw new Error('Large audio from a watched folder must be imported through that folder, not by file pick')
          const size = typeof file.size === 'number' ? file.size : null
          let parsed
          if (typeof file.slice === 'function') {
            const head = await file.slice(0, size ? Math.min(size, HEAD_BYTES) : HEAD_BYTES).arrayBuffer()
            parsed = await parseByFormat(file, head)
          } else if (size !== null && size <= LARGE_AUDIO) {
            parsed = await parseByFormat(file, await file.arrayBuffer())
          } else {
            throw new Error('Audio file is too large to import by file pick — add its folder as a watched folder instead, so it can play in place')
          }
          audioEntries.push({
            file,
            size,
            dir: dirOfFile(file),
            parsed: {
              title: parsed.metadata.title,
              author: parsed.metadata.author,
              album: parsed.extra.album || '',
              durationSec: parsed.extra.durationSec || null,
              chapters: parsed.extra.audioChapters || [],
              metadata: parsed.metadata,
            },
          })
          // Audio entries are only collected here (groups import
          // below), but a long parse pass still needs to breathe:
          // yield every 10 collected entries, same boundary.
          if (audioEntries.length % APPEND_BATCH_SIZE === 0) await yieldToEventLoop()
          continue
        }
        const buf = await file.arrayBuffer()
        const parsed = await parseByFormat(file, buf)
        const metadata = { ...parsed.metadata }
        const id = uid()
        const meta = {
          id,
          fileName: file.name,
          format: parsed.format,
          metadata,
          audioChapters: parsed.extra.audioChapters || [],
          addedAt: Date.now(),
          progress: null,
          fixedFields: [],
          hasFile: true,
        }
        await putBookMeta(meta)
        await putBookFile(id, buf)
        // Progressive import (v0.7.5), batched: queue this book —
        // it reaches the Library on the next batch flush (every 10
        // books / 500 ms / end of import), not via a render per book.
        appendBatch.queue(meta)
        imported++
        if (imported % APPEND_BATCH_SIZE === 0) {
          appendBatch.flush()
          setImportStatus(`Imported ${imported} book(s)…`)
          await yieldToEventLoop()
        }
      } catch (e) {
        errors.push(`${file.name}: ${e.message}`)
      }
    }
    // Multi-part audiobooks (see src/lib/multipart.js for the rules):
    // same book folder = one book; flat picks group only on a shared
    // album or a shared prefix + part numbers. Single-file audio
    // entries go through exactly the old path (one book, one URI).
    // Grouping applies to NEW imports only — books already in the
    // library as separate files are NOT merged retroactively (that
    // would rewrite the library without approval; a manual
    // "group these books" action is a future option, not built here).
    for (const group of groupAudioEntries(audioEntries)) {
      try {
        const first = group.entries[0]
        const id = uid()
        const partsMeta = group.entries.map((e) => ({
          durationSec: e.parsed.durationSec,
          chapters: e.parsed.chapters,
        }))
        const isMulti = group.entries.length > 1
        const knownDurations = partsMeta.map((p) => p.durationSec).filter((d) => typeof d === 'number' && d > 0)
        const totalSec = knownDurations.length ? knownDurations.reduce((a, b) => a + b, 0) : null
        const metadata = { ...first.parsed.metadata, title: group.title, author: group.author, creators: group.author ? [group.author] : [] }
        if (totalSec) metadata.durationSec = totalSec
        const meta = {
          id,
          fileName: first.file.name,
          format: 'audio',
          metadata,
          // Global chapters: each part's chapters shifted by its
          // start offset (parts after an unknown-duration part are
          // omitted, never faked — see multipart.js).
          audioChapters: globalChapters(partsMeta),
          addedAt: Date.now(),
          progress: null,
          fixedFields: [],
          hasFile: true,
        }
        await putBookMeta(meta)
        // Store each part (v0.7.4). Native: STREAMING store — the
        // file is sliced and appended, never held whole, so a
        // 629 MB part imports with ~7 MB peak memory. Web: a whole
        // read is allowed ONLY for a <= 50 MB part (the HTML player
        // needs a blob); a larger part on web fails cleanly instead
        // of crashing into IndexedDB. The book-level audioFileUri is
        // the FIRST part's URI: read-along with a multi-part book
        // plays part 1 only (documented limit — read-along is out of
        // scope for the multi-part player).
        // FAILURE CLEANUP (v0.7.4): the old code left the meta (and
        // any partial store) behind on a store failure — an
        // unplayable ghost book plus a half-file on disk. Now a
        // failed group deletes every stored part, every blob part,
        // and the book meta, and reports a per-file error in plain
        // words. A failed import leaves nothing behind to re-break
        // the next startup rescan.
        const audioParts = []
        try {
          for (let i = 0; i < group.entries.length; i++) {
            const entry = group.entries[i]
            const partId = isMulti ? `${id}-p${i}` : id
            let uri = null
            if (isNative && typeof entry.file.slice === 'function') {
              uri = await storeAudioFileStream(partId, entry.file.name, entry.file)
            } else if (!isNative && entry.size !== null && entry.size <= LARGE_AUDIO) {
              await putBookFile(partId, await entry.file.arrayBuffer())
            } else if (!isNative && entry.size === null) {
              // Unknown size with no slice support: never whole-read
              // on a guess — this is the SAF-audio path's safety net
              // (SAF audio is imported in place, never here).
              throw new Error(`"${entry.file.name}" could not be stored (unknown size, no streaming support)`)
            } else {
              throw new Error(`"${entry.file.name}" could not be stored (too large for this import path)`)
            }
            audioParts.push({ partId, fileName: entry.file.name, audioFileUri: uri, durationSec: entry.parsed.durationSec || null })
          }
        } catch (storeErr) {
          for (const p of audioParts) {
            if (p.audioFileUri) await deleteStoredAudio(p.partId, p.fileName)
            else await deleteBookFile(p.partId)
          }
          await deleteBook(id)
          throw storeErr
        }
        // Folder cover (v0.7.4): a sibling EmbeddedCover.jpg /
        // cover.jpg / cover.png / folder.jpg in the same book folder
        // becomes the book's cover — but ONLY as a fallback. A cover
        // already parsed from the audio file itself wins. (MP4
        // parsing in this app does not extract embedded 'covr', so
        // in practice the folder cover is what a Smart Audiobook
        // Player folder's book gets.) position.sabp.dat and other
        // .dat/.txt/.nfo siblings are never book files and never
        // errors — they are simply not in the book-file list.
        const update = { ...meta, metadata: { ...meta.metadata } }
        const embeddedCover = update.metadata.coverDataUrl || update.metadata.coverUrl
        const coverEntry = !embeddedCover && folderCovers ? folderCovers.get(group.dir) : null
        if (coverEntry) {
          try { update.metadata.coverDataUrl = await blobToDataUrl(coverEntry.file) } catch { /* cover is a bonus, never fatal */ }
        }
        if (isMulti) update.audioParts = audioParts
        if (audioParts[0] && audioParts[0].audioFileUri) update.audioFileUri = audioParts[0].audioFileUri
        await putBookMeta(update)
        // Progressive import (v0.7.5), batched: queue the finished
        // GROUP (one book, with its parts/URIs/cover), never the
        // earlier bare meta above and never once per part file.
        appendBatch.queue(update)
        imported++
        if (imported % APPEND_BATCH_SIZE === 0) {
          appendBatch.flush()
          setImportStatus(`Imported ${imported} book(s)…`)
          await yieldToEventLoop()
        }
      } catch (e) {
        for (const entry of group.entries) errors.push(`${entry.file.name}: ${e.message}`)
      }
    }
    // Final flush (v0.7.5 crash fix): any books still buffered
    // (including every book of a small batch) appear NOW, before
    // the Done message and the reload() consistency pass below.
    appendBatch.flush()
    setImportErrors(errors)
    setImportStatus(`Done — imported ${imported} book(s) from ${files.length} file(s).${errors.length ? ` ${errors.length} failed (see below).` : ''}`)
    // Metadata only — never reload full file blobs after an import.
    // Consistency pass only (v0.7.5): books already appended one by
    // one above are re-read from IndexedDB; reload() replaces state
    // wholesale, so it cannot duplicate them.
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
    // Folder covers come from the UNFILTERED pick (v0.7.4): the
    // book-file filter below would drop EmbeddedCover.jpg etc.
    const folderCovers = buildFolderCoverMap([...fileList])
    const files = [...fileList].filter(isSupportedBookFile)
    if (!files.length) {
      const msg = 'No supported files found (.epub, .pdf, .cbz, .cbr, .cbt, .cb7, .m4b, .m4a, .mp4, .mp3).'
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
      // Per-folder rescan (legacy rows): match only the tapped folder.
      const target = legacyRescanTargetRef.current
      legacyRescanTargetRef.current = null
      const wanted = target
        ? new Set([target.toLowerCase()])
        : new Set(watchedFolders.map((w) => w.name.toLowerCase()))
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
      await importFiles(toImport, folderCovers)
      setWatchStatus(`Rescan done — imported ${toImport.length} new book(s) from ${Object.keys(found).join(', ')}.`)
      return
    }
    // 'library' and 'add': import everything picked.
    const folderName = folderNameOfFiles(files)
    await importFiles(files, folderCovers)
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

  // ---- Native SAF watched folders (v0.7.2) --------------------------
  // Primary Add-folder path on Android: the system folder picker
  // (ACTION_OPEN_DOCUMENT_TREE). The user navigates to a folder and
  // confirms it with one tap — no select-all, no long-press, no
  // individual file selection. The plugin keeps a persistable URI
  // permission for the tree, so the saved id (a tree URI, NOT a
  // filesystem path) can be re-listed on later starts with no
  // re-pick. On web, or if the plugin is unavailable, the WebView
  // folder/file inputs below remain as fallback.
  function safFolderRef(w) { return { id: w.id, name: w.name } }
  async function safListEntries(w, path) {
    const args = { folder: safFolderRef(w) }
    if (path) args.path = path
    const res = await ScopedStorage.readdir(args)
    return res.entries || []
  }
  async function scanSafFolder(w) {
    const found = await listSafBookFiles((path) => safListEntries(w, path))
    return found
  }
  // SAF audio, imported IN PLACE (v0.7.4 — the large-audiobook
  // fix). The old path read every SAF file whole through
  // ScopedStorage.readFile (base64, no offset support) and then
  // stored a second copy — a 629 MB file became an ~840 MB base64
  // string plus a 629 MB buffer, twice. That is gone for audio:
  //   * The file is NEVER read for storage. ScopedStorage
  //     .getUriForPath gives a content URI for the file where it
  //     already lives, and that URI is stored as audioFileUri —
  //     exactly how Smart Audiobook Player treats its folders (no
  //     629 MB copy). The persistable SAF permission for the
  //     watched folder keeps the URI valid across starts; if the
  //     user revokes the permission or moves the folder, playback
  //     fails with the player's normal error and the folder must be
  //     re-picked — the app never silently copies the file then.
  //   * Bytes are parsed ONLY for a file the plugin reports as
  //     <= 50 MB (or when size is unknown-but-small in practice —
  //     no: unknown size is treated as large, see below). A larger
  //     file is never byte-read at all: title comes from the book
  //     folder name, author from the parent (author) folder name —
  //     the user's structure already carries both — duration is
  //     null and chapters are [] (the native player reports the
  //     real duration once it plays; bookmarks are the documented
  //     fallback for chapterless files).
  //   * Dedupe is at GROUP level, not file level: a book folder is
  //     skipped whole if every part is already in the library, and
  //     also skipped (counted in skippedPartial) if only SOME parts
  //     are present — importing the rest as a second book would
  //     duplicate it. No retroactive merging of already-imported
  //     separate books, as before.
  //   * Folder covers: a sibling EmbeddedCover.jpg / cover.jpg /
  //     cover.png / folder.jpg in the same book folder (first found,
  //     in that order) becomes the book's cover. Small files, read
  //     whole as base64 — fine. position.sabp.dat and other
  //     .dat/.txt/.nfo siblings are ignored, never books or errors.
  // Returns { imported, skippedPartial, errors } (errors are plain
  // per-file messages; a failed group creates NO meta and NO copy,
  // so nothing ghost-like is left behind).
  async function importSafAudio(w, audioFound, knownFileNames) {
    const LARGE_AUDIO = 50 * 1024 * 1024
    const byDir = new Map()
    for (const f of audioFound) {
      const dir = f.dir || ''
      if (!byDir.has(dir)) byDir.set(dir, [])
      byDir.get(dir).push(f)
    }
    let imported = 0
    let skippedPartial = 0
    const errors = []
    // Batch throttling, same as importFiles (v0.7.5 crash fix):
    // appends flush every 10 books, with a yield on that boundary,
    // plus a final flush before returning.
    const appendBatch = createLibraryAppendBatcher()
    // Presence is judged ONLY against the library as it stood
    // before this scan: two different book folders may legitimately
    // share a part filename (e.g. part1.m4b in both), and the second
    // one must not be blocked by the first one imported in this
    // same scan. So knownFileNames is read-only here.
    for (const [dir, list] of byDir) {
      list.sort((a, b) => naturalCompare(a.name, b.name))
      const present = list.filter((f) => knownFileNames.has(f.name)).length
      if (present === list.length) continue
      if (present > 0) { skippedPartial++; continue }
      const isMulti = list.length > 1
      const title = dir
        ? cleanFolderName(lastSegmentOfDir(dir))
        : list[0].name.replace(/\.(m4b|m4a|mp4|mp3)$/i, '').replace(/[_-]+/g, ' ').trim()
      const author = dir ? cleanFolderName(parentSegmentOfDir(dir)) : ''
      try {
        // URIs first, meta last: nothing is created until every
        // part has a playable URI, so a failure leaves no meta.
        const parts = []
        for (let i = 0; i < list.length; i++) {
          const f = list[i]
          const res = await ScopedStorage.getUriForPath({ folder: safFolderRef(w), path: f.path })
          if (!res || !res.uri) throw new Error(`"${f.name}" has no playable URI in its folder`)
          let durationSec = null
          let chapters = []
          if (typeof f.size === 'number' && f.size <= LARGE_AUDIO) {
            try {
              const data = await ScopedStorage.readFile({ folder: safFolderRef(w), path: f.path, encoding: 'base64' })
              const parsed = await parseByFormat({ name: f.name }, base64ToArrayBuffer(data.data))
              durationSec = parsed.extra.durationSec || null
              chapters = parsed.extra.audioChapters || []
            } catch { /* small-file parse failure: folder metadata stands */ }
          }
          parts.push({ fileName: f.name, audioFileUri: res.uri, durationSec, chapters })
        }
        const id = uid()
        const knownDurations = parts.map((p) => p.durationSec).filter((d) => typeof d === 'number' && d > 0)
        const totalSec = knownDurations.length ? knownDurations.reduce((a, b) => a + b, 0) : null
        const metadata = { title, author, creators: author ? [author] : [], language: '', publisher: '', date: '', description: '', identifier: '', isbn: '', series: '', seriesIndex: '', coverDataUrl: '' }
        if (totalSec) metadata.durationSec = totalSec
        // Folder cover (small read, first candidate that exists).
        // SAF paths are case-sensitive, so each candidate is tried
        // in its common casings (the real file here is
        // EmbeddedCover.jpg, not the lowercased rank key).
        for (const coverName of ['EmbeddedCover.jpg', 'embeddedcover.jpg', 'cover.jpg', 'Cover.jpg', 'cover.png', 'Cover.png', 'folder.jpg', 'Folder.jpg']) {
          const coverPath = dir ? `${dir}/${coverName}` : coverName
          try {
            const data = await ScopedStorage.readFile({ folder: safFolderRef(w), path: coverPath, encoding: 'base64' })
            if (data && data.data) {
              const mime = coverName.endsWith('.png') ? 'image/png' : 'image/jpeg'
              metadata.coverDataUrl = `data:${mime};base64,${data.data}`
              break
            }
          } catch { /* candidate absent — try the next name */ }
        }
        const partsMeta = parts.map((p) => ({ durationSec: p.durationSec, chapters: p.chapters }))
        const meta = {
          id,
          fileName: list[0].name,
          format: 'audio',
          metadata,
          audioChapters: globalChapters(partsMeta),
          addedAt: Date.now(),
          progress: null,
          fixedFields: [],
          hasFile: true,
        }
        if (isMulti) meta.audioParts = parts.map((p, i) => ({ partId: `${id}-p${i}`, fileName: p.fileName, audioFileUri: p.audioFileUri, durationSec: p.durationSec }))
        if (parts[0]) meta.audioFileUri = parts[0].audioFileUri
        await putBookMeta(meta)
        // Progressive import (v0.7.5), batched: SAF audio does NOT
        // go through importFiles, so this is the one import entry
        // point that would otherwise bypass appends. Queue here,
        // only after the URIs + cover + final meta are committed.
        appendBatch.queue(meta)
        imported++
        if (imported % APPEND_BATCH_SIZE === 0) {
          appendBatch.flush()
          await yieldToEventLoop()
        }
      } catch (e) {
        errors.push(`${list.map((f) => f.name).join(', ')}: ${e.message}`)
      }
    }
    // Final flush: any SAF audio books still buffered (including
    // every book of a small scan) appear before the caller reports.
    appendBatch.flush()
    return { imported, skippedPartial, errors }
  }

  // Import one SAF folder's books, deduped against the library by
  // fileName+format (the same rule as WebView rescan) for non-audio,
  // and by whole book folder for audio (see importSafAudio). Returns
  // { found, imported } and updates ONLY this folder's row.
  async function importSafFolder(w) {
    const found = await scanSafFolder(w)
    const existing = await getAllBooksMeta()
    const audioFound = found.filter((f) => /\.(m4b|m4a|mp4|mp3)$/i.test(f.name))
    const otherFound = found.filter((f) => !/\.(m4b|m4a|mp4|mp3)$/i.test(f.name))
    const toImport = newFilesForRescan(otherFound, existing)
    const lazyByPath = new Map()
    for (const f of otherFound) {
      if (!toImport.some((t) => t.path === f.path)) continue
      lazyByPath.set(f.path, lazySafFile(f.name, async () => {
        const res = await ScopedStorage.readFile({ folder: safFolderRef(w), path: f.path, encoding: 'base64' })
        return base64ToArrayBuffer(res.data)
      }, f.dir || ''))
    }
    // Paths are unique by construction (full relative path), so two
    // book folders with the same part filenames (e.g. "part1.m4b"
    // in two books) both import — the old name-keyed dedupe here
    // dropped the second one. Library-level dedupe above still
    // skips a file already in the library (no retroactive merge).
    const lazyFiles = []
    for (const t of toImport) {
      const lazy = lazyByPath.get(t.path)
      if (lazy) lazyFiles.push(lazy)
    }
    // Audio in place FIRST (no bytes read for large files), then
    // non-audio through the normal path. Import status/errors for
    // SAF audio live on the watch status, not the import panel:
    // setImportErrors would be overwritten by the non-audio import.
    const knownFileNames = new Set()
    for (const b of existing) {
      if (b.fileName) knownFileNames.add(b.fileName)
      for (const p of b.audioParts || []) if (p.fileName) knownFileNames.add(p.fileName)
    }
    const audioRes = audioFound.length ? await importSafAudio(w, audioFound, knownFileNames) : { imported: 0, skippedPartial: 0, errors: [] }
    if (lazyFiles.length) await importFiles(lazyFiles)
    else await reload()
    const audioNote = [
      audioRes.imported ? `${audioRes.imported} audiobook(s) linked in place` : '',
      audioRes.skippedPartial ? `${audioRes.skippedPartial} audiobook folder(s) skipped (partly imported already — remove the old entries first, then rescan)` : '',
      audioRes.errors.length ? `audio errors: ${audioRes.errors.join('; ')}` : '',
    ].filter(Boolean).join(' — ')
    if (audioNote) setWatchStatus(audioNote)
    setWatchedFolders((prev) => prev.map((x) => (
      x.saf && x.id === w.id
        ? { ...x, lastCount: found.length, lastScannedAt: Date.now() } : x
    )))
    return { found: found.length, imported: lazyFiles.length + audioRes.imported }
  }
  async function addSafFolder() {
    let picked
    try {
      picked = await ScopedStorage.pickFolder()
    } catch (e) {
      // User cancelled the picker: not an error, just nothing to do.
      if (String(e && e.message || e).includes('cancel')) { setWatchStatus('Folder pick cancelled.'); return }
      setWatchStatus(`Could not open the folder picker: ${e && e.message ? e.message : e}`)
      return
    }
    const folder = picked && picked.folder
    if (!folder || !folder.id) { setWatchStatus('The folder picker did not return a folder. Try again.'); return }
    const name = folder.name || 'Picked folder'
    const w = { name, id: folder.id, saf: true }
    setWatchedFolders((prev) => {
      const rest = prev.filter((x) => !(x.saf && x.id === folder.id))
      return [...rest, { ...w, lastCount: undefined, lastScannedAt: Date.now() }]
    })
    try {
      const { found, imported } = await importSafFolder(w)
      setWatchStatus(`Folder "${name}" saved — ${found} book file(s) found, ${imported} new imported. It will be rescanned automatically on startup; no re-pick needed.`)
    } catch (e) {
      // The folder was picked and saved, but listing/reading failed
      // (permission revoked between pick and scan, folder moved, …).
      setWatchStatus(`Folder "${name}" was saved, but it could not be read right now (${e && e.message ? e.message : e}). Re-pick it from Settings if it was moved, or tap its Rescan button to try again.`)
    }
  }
  async function rescanSafFolder(w) {
    try {
      const { found, imported } = await importSafFolder(w)
      setWatchStatus(imported
        ? `Rescan of "${w.name}" done — imported ${imported} new book(s) (${found} found).`
        : `Rescan of "${w.name}" done — no new books (${found} found, everything already in the library).`)
    } catch (e) {
      setWatchStatus(`"${w.name}" could not be opened — its permission may have been revoked, or the folder was moved or deleted. Re-pick just that folder from Settings (Remove, then Add folder) to restore it. (${e && e.message ? e.message : e})`)
    }
  }
  async function rescanAllSafFolders() {
    const saf = watchedFolders.filter((w) => w.saf && w.id)
    if (!saf.length) { setWatchStatus('No saved-folder-access folders to rescan. Older folders still need the folder picker — use their per-folder Rescan button.'); return }
    const lines = []
    for (const w of saf) {
      try {
        const { found, imported } = await importSafFolder(w)
        lines.push(`"${w.name}": ${imported} new of ${found} found`)
      } catch (e) {
        lines.push(`"${w.name}": could not be opened — permission may have been revoked or the folder moved/deleted. Re-pick just that folder from Settings.`)
      }
    }
    setWatchStatus(`Startup rescan done — ${lines.join('; ')}`)
  }
  // TRUE startup scan (SAF folders only): runs once per app start
  // when the toggle is ON, with no tap and no re-pick. Legacy
  // (WebView) folders are NOT scanned here — they still need the
  // Library prompt's Rescan, because the app holds no permission
  // for them. A revoked/moved folder is reported by name, never
  // silently skipped and never a crash: the loop continues.
  useEffect(() => {
    if (safStartupDoneRef.current) return
    safStartupDoneRef.current = true
    if (!scanOnStartup || !isNative) return
    const saf = watchedFolders.filter((w) => w.saf && w.id)
    if (!saf.length) return
    ;(async () => {
      const lines = []
      for (const w of saf) {
        try {
          const { found, imported } = await importSafFolder(w)
          lines.push(`"${w.name}": ${imported} new of ${found} found`)
        } catch {
          lines.push(`"${w.name}": could not be opened — permission may have been revoked or the folder moved/deleted. Re-pick just that folder from Settings.`)
        }
      }
      setWatchStatus(`Startup rescan done — ${lines.join('; ')}`)
    })()
    // Only the mount run: watchedFolders/scanOnStartup are read
    // from localStorage on first render, and re-running on every
    // list change would re-import on every Add/Remove.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    // scan; 'covers' scans ONLY books with no cover (neither
    // coverDataUrl nor coverUrl) and collects ONLY cover proposals —
    // every other missing field is ignored in that run, and a book
    // that already has a cover is never scanned or overwritten.
    // Import itself never enriches — books arrive as-is.
    const noCover = (b) => !(b.metadata.coverDataUrl || b.metadata.coverUrl)
    const scopeBooks = scope === 'unsorted' ? books.filter(isUnsorted)
      : scope === 'covers' ? books.filter(noCover)
      : [...books]
    if (!scopeBooks.length) {
      setEnrichStatus(scope === 'unsorted' ? 'Unsorted shelf is empty — nothing to fix.'
        : scope === 'covers' ? 'Every book already has a cover — nothing to find.'
        : 'No books to check.')
      return
    }
    setEnriching(true)
    setEnrichStatus(scope === 'covers'
      ? `Finding covers for ${scopeBooks.length} book${scopeBooks.length === 1 ? '' : 's'} with no cover…`
      : `Checking ${scope === 'unsorted' ? 'Unsorted shelf' : 'all books'} for missing metadata…`)
    setProposals([])
    setAutoFixedSummary([])
    setCoverReview(scope === 'covers')
    const review = []
    const autoSummary = []
    // Snapshot the library at run start: auto-applying mutates books,
    // so later lookups must not re-read the mutated state mid-run.
    const snapshot = scopeBooks
    for (let i = 0; i < snapshot.length; i++) {
      setEnrichStatus(`Checking ${i + 1} of ${snapshot.length}: ${snapshot[i].metadata.title}`)
      try {
        const result = await enrichBook(snapshot[i], { coverAutoApplyExact: autoApplyCoversExact })
        if (!result) continue
        // Cover-only run: drop everything except the cover proposal
        // before any auto-apply or review step, so no other field
        // can be auto-applied or reviewed by a covers scan.
        const coverOnly = (obj) => (obj && obj.coverUrl ? { coverUrl: obj.coverUrl } : {})
        const autoPart = scope === 'covers' ? coverOnly(result.autoProposals) : (result.autoProposals || {})
        const reviewPart = scope === 'covers' ? coverOnly(result.reviewProposals) : (result.reviewProposals || {})
        const fullPart = scope === 'covers' ? coverOnly(result.proposals) : (result.proposals || {})
        // High-confidence, auto-apply ON: apply immediately, no prompt.
        // The review-only remainder (e.g. a non-ISBN cover when the
        // exact-cover toggle is off) still goes to Fix Review, even
        // for a high-confidence book.
        if (autoApplyHigh && Object.keys(autoPart).length) {
          const updated = await applyValuesToBook(snapshot[i], autoPart, {
            source: result.source,
            confidenceReason: result.confidenceReason,
          })
          const fields = Object.keys(autoPart).map((f) => (f === 'coverUrl' ? 'cover' : f))
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
        const reviewFields = autoApplyHigh ? reviewPart : fullPart
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
      // 'cover' diffs are NOT metadata fields: route them through
      // applyValuesToBook's cover handling (fetch to a data URL,
      // record fixedFields 'cover', store the URL even if the fetch
      // fails) and never overwrite a cover that appeared since the
      // preview was computed.
      const coverDiff = change.diffs.find((d) => d.field === 'cover')
      const patch = {}
      for (const d of change.diffs) if (d.field !== 'cover') patch[d.field] = d.to
      let updated = { ...book, metadata: { ...book.metadata, ...patch } }
      if (change.diffs.some((d) => d.field === 'title')) updated.titleFromFilename = false
      await putBookMeta(updated)
      if (coverDiff && !updated.metadata.coverDataUrl && !updated.metadata.coverUrl) {
        updated = await applyValuesToBook(updated, { coverUrl: coverDiff.to }, null)
      }
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
  // between — exactly as the old Read/Play buttons did.
  async function openDirect(book) {
    if (book.format === 'epub') return openReader(book)
    if (book.format === 'pdf') return openViewer(book, 'pdf')
    if (book.format === 'comic') return openViewer(book, 'comic')
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
  // destination (Library, Series, Authors, Settings) exits the app.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let handle = null
    ;(async () => {
      try {
        handle = await CapApp.addListener('backButton', () => {
          const v = viewRef.current
          if (backDestinationFor(v)) {
            if (navigateBackRef.current) navigateBackRef.current(v)
          } else if (v === 'library' || v === 'series' || v === 'authors' || v === 'settings') {
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
  // On release, past ~12% width, or a flick (over ~40px at over
  // ~0.25 px/ms), completes the flip (and the turn); only a tiny,
  // slow drag snaps back with no page change and no haptic — the
  // old ~25% / 0.5 px/ms bar made a normal relaxed swipe fail both
  // tests, so the page turned halfway and snapped back and the user
  // needed a second, harder swipe to turn one page (v0.7.2 fix).
  // A tap (no drag) is handled by onReaderClick.
  const readerTouch = useRef(null)
  function onReaderTouchStart(e) {
    cancelFlipAnim()
    // If a flip animation was in flight, cancelFlipAnim stops its
    // frames but leaves the page stuck at a partial rotation — a
    // tap during an animation would then freeze the page mid-flip
    // with no animation left to finish it, and the next swipe
    // would start from that frozen state. Clear the flip outright
    // so the new gesture starts from the current page cleanly;
    // the first >8px of movement re-creates the flip for the drag.
    if (flipRef.current) setFlipState(null)
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
    const flick = Math.abs(dx) > 40 && (Math.abs(dx) / dt) > 0.25 // px/ms
    if (Math.abs(dx) > w * 0.12 || flick) animateFlipTo(1, f.dir, f.boundary)
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
    if (!['library', 'series', 'series-detail', 'authors', 'author-detail', 'unsorted'].includes(view)) return
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
  // Authors mirror Series exactly: same base (format tab + search
  // over title/author/series/fileName, so typing an author name
  // filters the list to that author), grouped by trimmed author,
  // A-Z with "Unknown author" last. Books with no author land in
  // "Unknown author", never in a blank or first row.
  const authorNameOf = (b) => ((b.metadata.author || '').trim() || 'Unknown author')
  const authorGroups = useMemo(() => {
    const map = new Map()
    for (const b of seriesBase) {
      const name = authorNameOf(b)
      if (!map.has(name)) map.set(name, [])
      map.get(name).push(b)
    }
    const groups = [...map.entries()].map(([name, books]) => ({ name, books: sortBooks(books, 'author') }))
    groups.sort((a, b) => ((a.name === 'Unknown author' ? 1 : 0) - (b.name === 'Unknown author' ? 1 : 0)) || a.name.localeCompare(b.name))
    return groups
  }, [seriesBase])
  const headerTitle = view === 'series' || view === 'series-detail' ? 'Series' : view === 'authors' || view === 'author-detail' ? 'Authors' : view === 'unsorted' ? 'Unsorted' : view === 'settings' ? 'Settings' : view === 'fixes' ? 'Fix Review' : 'Library'
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
            <button
              className="icon-btn"
              onClick={() => setViewMode(viewMode === 'list' ? 'grid' : viewMode === 'grid' ? 'shelf' : 'list')}
              aria-label={`Library view: ${viewMode === 'list' ? 'List' : viewMode === 'grid' ? 'Grid' : 'Shelf'} (tap to change)`}
              title={`Library view: ${viewMode === 'list' ? 'List' : viewMode === 'grid' ? 'Grid' : 'Shelf'}`}
            >
              {viewMode === 'list' ? '▦' : viewMode === 'grid' ? '📚' : '☰'}
            </button>
          )}
          <button className="icon-btn" onClick={() => setView('settings')} aria-label="Settings">⋮</button>
        </div>
        <nav className="topnav">
          <button className={view === 'library' ? 'active' : ''} onClick={() => setView('library')}>Library</button>
          <button className={view === 'series' || view === 'series-detail' ? 'active' : ''} onClick={() => setView('series')}>Series</button>
          <button className={view === 'authors' || view === 'author-detail' ? 'active' : ''} onClick={() => setView('authors')}>Authors</button>
          <button className={view === 'unsorted' ? 'active' : ''} onClick={() => setView('unsorted')}>Unsorted{books.filter(isUnsorted).length ? ` (${books.filter(isUnsorted).length})` : ''}</button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>Settings</button>
        </nav>
        {searchOpen && (
          <input className="top-search" type="search" placeholder="Search title, author, or series…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        )}
      </header>}

      <main className={view === 'reader' ? 'reader-main' : ''} style={navEdgeOffset ? { transform: `translateX(${navEdgeOffset}px)` } : undefined} onTouchStart={onPtrTouchStart} onTouchMove={onPtrTouchMove} onTouchEnd={onPtrTouchEnd} onClickCapture={(e) => { if (Date.now() - navEdgeClickBlockRef.current < 300) { e.preventDefault(); e.stopPropagation() } }}>
        {['library', 'series', 'series-detail', 'authors', 'author-detail', 'unsorted'].includes(view) && (pullDist > 0 || ptrRefreshing) && (
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
                <p className="progress">Folders with saved folder access are rescanned automatically on startup. Older folders (no saved access) still need re-picking: tap Rescan and pick the folder again to import any new books.</p>
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
              <input ref={fileRef} type="file" accept=".epub,.pdf,.cbz,.cbr,.cbt,.cb7,.m4b,.m4a,.mp4,.mp3" multiple hidden onChange={(e) => importFiles(e.target.files)} />
              <input ref={folderRef} type="file" accept=".epub,.pdf,.cbz,.cbr,.cbt,.cb7,.m4b,.m4a,.mp4,.mp3" multiple hidden webkitdirectory=""
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
            ) : viewMode === 'shelf' ? (
              <ShelfRows books={filtered} onOpen={openDirect} onDetail={openBook} />
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
            {/* A series detail is a shelf by definition: ALWAYS
                ShelfRows, regardless of the flat Library's
                List/Grid/Shelf toggle (which controls the flat
                Library view only). Books keep their series order
                (seriesIndex, then title) from groupBySeries. */}
            <ShelfRows books={seriesDetail.books} onOpen={openDirect} onDetail={openBook} />
          </div>
        )}

        {view === 'authors' && (
          <div className="series-list">
            {!authorGroups.length && <div className="card"><p>No authors yet — authors come from a book's own metadata, or a manual edit on its detail page. Books with no author are listed under "Unknown author".</p></div>}
            {authorGroups.map((g) => (
              <button key={g.name} className="series-row" onClick={() => { setAuthorDetail(g.name); setView('author-detail') }}>
                <span className="series-tag">✍️</span>
                <span className="series-name">{g.name}</span>
                <span className="series-count">{g.books.length}</span>
              </button>
            ))}
          </div>
        )}

        {view === 'author-detail' && authorDetail && (() => {
          // Live recompute (not a snapshot): format tab + search
          // keep filtering inside an open author detail, exactly
          // like the Series base does for its list.
          const q = search.trim().toLowerCase()
          let list = books.filter(matchesFormatTab).filter((b) => authorNameOf(b) === authorDetail)
          if (q) {
            list = list.filter((b) => [b.metadata.title, b.metadata.author, getSeries(b).name, b.fileName].join(' ').toLowerCase().includes(q))
          }
          const groups = groupBySeries(list)
          return (
            <div>
              <h2>{authorDetail}</h2>
              {!list.length ? (
                <div className="card"><p>No books match this filter for this author.</p></div>
              ) : groups.map((g) => (
                <div className="series-group" key={g.key}>
                  {/* groupBySeries orders series groups A-Z with
                      books by seriesIndex inside, and Standalone
                      last — so an author with several series is
                      never one jumbled shelf. */}
                  <h2>{g.name} ({g.books.length})</h2>
                  <ShelfRows books={g.books} onOpen={openDirect} onDetail={openBook} />
                </div>
              ))}
            </div>
          )
        })()}

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
              <p className="progress">Library view: {viewMode === 'list' ? 'List' : viewMode === 'grid' ? 'Grid' : 'Shelf'} — tap the view button in the top bar in the Library to cycle List → Grid → Shelf.</p>
              <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={volumeKeysTurnPages} onChange={(e) => setVolumeKeysTurnPages(e.target.checked)} />
                Volume keys turn pages (in the reader: volume down = next page, volume up = previous page; the volume itself does not change while reading)
              </label>
              <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={mangaDefault} onChange={(e) => setMangaDefault(e.target.checked)} />
                Comics open in manga mode by default (right-to-left page order; can still be toggled per comic in the viewer)
              </label>
              <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={webtoonDefault} onChange={(e) => setWebtoonDefault(e.target.checked)} />
                Comics open in webtoon mode by default (continuous vertical strip; can still be toggled per comic in the viewer)
              </label>
              <p className="progress">ShelfSort v0.7.5</p>
            </div>
            <div className="card">
              <h2>Library folders</h2>
              <p className="progress">On Android, Add folder opens your phone's system folder picker: navigate to a folder and confirm it with one tap — no selecting individual files, no select-all, no long-press. The app keeps permission for that folder and rescans it automatically on startup (with the toggle below on), importing only books not already in the library. Older folders saved before this, and folders on the web, still work the old way: only the folder name is stored, so they need re-picking on rescan. If a saved folder's permission was revoked or it was moved/deleted, its rescan says so by name instead of silently skipping it. A true folder scan with no re-pick is only possible for these saved-permission folders — the WebView folder/file inputs below remain as a fallback.</p>
              <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={scanOnStartup} onChange={(e) => setScanOnStartup(e.target.checked)} />
                Scan watched folders on startup (saved-permission folders scan automatically; older folders show the rescan prompt in the Library)
              </label>
              <div className="toolbar">
                <button onClick={() => { if (isNative) addSafFolder(); else watchFolderRef.current.click() }}>Add folder</button>
                <button className="secondary" disabled={!watchedFolders.length} onClick={() => { if (isNative) rescanAllSafFolders(); else { watchPickModeRef.current = 'rescan'; watchFolderRef.current.click() } }}>Rescan watched folders</button>
              </div>
              <input ref={watchFolderRef} type="file" accept=".epub,.pdf,.cbz,.cbr,.cbt,.cb7,.m4b,.m4a,.mp4,.mp3" multiple hidden webkitdirectory=""
                onChange={(e) => { const mode = watchPickModeRef.current; watchPickModeRef.current = 'add'; handleFolderPick(e.target.files, mode); e.target.value = '' }} />
              {!watchedFolders.length ? (
                <p className="progress">No watched folders yet. Add one with the button above.</p>
              ) : (
                watchedFolders.map((w) => (
                  <div key={w.saf ? w.id : w.name} className="toolbar" style={{ justifyContent: 'space-between' }}>
                    <span className="progress"><strong>{w.name}</strong>{w.saf ? ' · saved folder access' : ''}{w.lastCount !== undefined ? ` — ${w.lastCount} book file(s) found on last scan` : ''}</span>
                    <span className="toolbar">
                      <button className="secondary" onClick={() => {
                        if (w.saf && w.id) rescanSafFolder(w)
                        else { legacyRescanTargetRef.current = w.name; watchPickModeRef.current = 'rescan'; watchFolderRef.current.click() }
                      }}>Rescan</button>
                      <button className="secondary" onClick={() => setWatchedFolders((prev) => prev.filter((x) => w.saf ? !(x.saf && x.id === w.id) : x.name !== w.name))}>Remove</button>
                    </span>
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
              <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={autoApplyCoversExact} onChange={(e) => setAutoApplyCoversExact(e.target.checked)} />
                Auto-apply covers on exact title+author match
              </label>
              <p className="progress">Cover auto-apply is off by default for a reason: a cover from a title+author search can belong to a different edition than yours, so an auto-applied cover can be the wrong edition's cover. Turn it on only if you accept that — fuzzy or first-result covers are never auto-applied, and any auto-applied cover is recorded on the book's detail page so you can correct it.</p>
              <div className="toolbar">
                <button onClick={() => runEnrichment('unsorted')} disabled={enriching || !books.filter(isUnsorted).length}>
                  {enriching ? 'Checking…' : `Scan Unsorted shelf (${books.filter(isUnsorted).length})`}
                </button>
                <button className="secondary" onClick={() => runEnrichment('all')} disabled={enriching || !books.length}>
                  {enriching ? 'Checking…' : 'Find fixes (all books)'}
                </button>
                <button className="secondary" onClick={() => runEnrichment('covers')} disabled={enriching || !books.filter((b) => !(b.metadata.coverDataUrl || b.metadata.coverUrl)).length}>
                  {enriching ? 'Checking…' : `Find missing covers (${books.filter((b) => !(b.metadata.coverDataUrl || b.metadata.coverUrl)).length})`}
                </button>
              </div>
              {enrichStatus && <p className="progress">{enrichStatus}</p>}
              <p className="progress">High confidence means an ISBN match to the same edition, or an exact title + author match with a single result. Everything uncertain goes to Fix Review. “Find missing covers” only scans books with no cover, only proposes covers (never other fields, never overwriting a cover), and shows them as thumbnails in Fix Review — apply per book, or all at once.</p>
            </div>
            <div className="card">
              <h2>Muse catalog — export / import</h2>
              <p className="progress">Let Muse sort the whole catalog — series, series order, authors, titles — without any backdoor or live access to your phone. Export a metadata-only catalog, share that file, then import the corrected file back. Nothing is applied until you press Apply, and import only changes title, author, publisher, date, ISBN, description, series, and series number — plus a coverUrl, but only for a book that currently has no cover (an existing cover is never overwritten by a catalog import). Book files, reading progress, and cloud credentials are never in a catalog file and are never changed by an import.</p>
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
                      <strong>{c.title || c.fileName}</strong>: {c.diffs.map((d) => d.field === 'cover'
                        ? `cover: — → ${d.to}`
                        : `${d.field}: ${d.from === null || d.from === '' ? '—' : d.from} → ${d.to === null || d.to === '' ? '—' : d.to}`).join(' · ')}
                      {c.diffs.filter((d) => d.field === 'cover').map((d) => (
                        <img key={d.to} src={d.to} alt="" style={{ width: 60, height: 90, objectFit: 'cover', borderRadius: 4, marginLeft: 8, verticalAlign: 'middle' }} onError={(e) => { e.target.style.display = 'none' }} />
                      ))}
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
                  <div className="progress">
                    This CBR was imported before CBR opening was added. Opening it re-reads the archive with the new unpacker and updates this book — nothing to convert by hand.
                  </div>
                )}
                {detail.format === 'audio' && detail.audioParts && detail.audioParts.length > 1 && (
                  <p>Multi-part audiobook: {detail.audioParts.length} parts, played in order with one combined position.</p>
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
                  {detail.format === 'comic' && <button onClick={() => openViewer(detail, 'comic')}>Open comic</button>}
                  {detail.format === 'audio' && <button onClick={() => openViewer(detail, 'audio')}>Play audiobook</button>}
                  {detail.format === 'audio' && detailPair && <button className="secondary" onClick={() => openReadAlong(detail)}>🎧 Read along</button>}
                  {detail.format === 'epub' && <button className="secondary" onClick={() => exportBook(detail)} disabled={exporting}>{exporting ? 'Exporting…' : 'Download corrected EPUB'}</button>}
                  <button className="secondary" onClick={async () => { if (confirm('Remove this book from ShelfSort?')) { if (detail.audioParts) for (const p of detail.audioParts) await deleteBookFile(p.partId); await deleteBook(detail.id); setView('library'); await reload() } }}>Remove</button>
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
            <div className="toolbar">
              <button className="secondary" onClick={() => runEnrichment('covers')} disabled={enriching || !books.filter((b) => !(b.metadata.coverDataUrl || b.metadata.coverUrl)).length}>
                {enriching ? 'Checking…' : `Find missing covers (${books.filter((b) => !(b.metadata.coverDataUrl || b.metadata.coverUrl)).length})`}
              </button>
            </div>
            <p className="progress">“Find missing covers” scans only books with no cover and proposes covers only — never other fields, never overwriting a cover you already have.</p>
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
            <p className="progress">Nothing in the review list below is applied until you press Apply. Edit any proposed value before applying it.{coverReview && proposals.length > 0 ? ' Covers below are shown as thumbnails so you can eyeball them before applying — a wrong-edition cover can be corrected later from the book\'s detail page “Edit metadata”.' : ''}</p>
            {proposals.length > 0 && <button onClick={applyAllProposals}>{coverReview ? 'Apply all covers' : 'Apply all proposed fixes'}</button>}
            {coverReview && proposals.filter((p) => (edits[p.bookId] || p.proposals).coverUrl).length > 0 && (
              <div className="cover-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginTop: 12 }}>
                {proposals.filter((p) => (edits[p.bookId] || p.proposals).coverUrl).map((p) => {
                  const book = books.find((b) => b.id === p.bookId)
                  if (!book) return null
                  const values = edits[p.bookId] || p.proposals
                  return (
                    <div className="card" key={p.bookId} style={{ margin: 0 }}>
                      {values.coverUrl
                        ? <img src={values.coverUrl} alt="" style={{ width: '100%', aspectRatio: '2/3', objectFit: 'cover', borderRadius: 4 }} onError={(e) => { e.target.style.display = 'none' }} />
                        : <div className="cover">No preview</div>}
                      <strong style={{ display: 'block', marginTop: 6 }}>{book.metadata.title}</strong>
                      <span className="progress" style={{ display: 'block' }}>{book.metadata.author || 'Unknown author'}</span>
                      <span className="progress" style={{ display: 'block' }}>{p.source} · {p.isbnMatch ? 'ISBN match' : 'Title+author match'} · {p.confidence}</span>
                      <div className="toolbar" style={{ marginTop: 6 }}>
                        <button onClick={() => applyProposal(p.bookId, values)}>Apply</button>
                        <button className="secondary" onClick={() => setProposals((prev) => prev.filter((x) => x.bookId !== p.bookId))}>Dismiss</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {!(coverReview && proposals.filter((p) => (edits[p.bookId] || p.proposals).coverUrl).length) && proposals.map((p) => {
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
                        <div className="reader-page reader-page-top" style={{ ['--reader-size']: `${fontSize}px`, transform: `rotateY(${angle}deg) scale(${1 - 0.03 * lift}) translateZ(${10 * lift}px)`, transformOrigin: origin }} dangerouslySetInnerHTML={{ __html: cur.html }} />
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
        {view === 'comic' && selected && <ComicViewer book={withFile(selected)} mangaDefault={mangaDefault} webtoonDefault={webtoonDefault} onBack={() => setView('detail')} onSave={async (book, progress) => { const { file: _f, ...u } = { ...book, progress }; await putBookMeta(u); setSelected(u); await reload() }} onMigrate={async (book, metadata) => { const { file: _f, ...u } = { ...book, metadata, cbrUnsupported: false }; await putBookMeta(u); setSelected(u); await reload(); return u }} />}
        {view === 'audio' && selected && <AudioPlayer book={withFile(selected)} onBack={() => setView('detail')} onSave={async (book, progress) => { const { file: _f, ...u } = { ...book, progress }; await putBookMeta(u); setSelected(u); }} readAlongPair={linkedPairFor(selected)} onReadAlong={() => openReadAlong(selected)} />}
        {view === 'readalong' && selected && <ReadAlongView epubBook={detailPair ? withFile(detailPair.epub) : withFile(selected)} audioBook={detailPair ? withFile(detailPair.audio) : null} books={books} onBack={() => setView('detail')} onSave={async (book, progress) => { const { file: _f, ...u } = { ...book, progress }; await putBookMeta(u); }} />}
      </main>

      {['library', 'series', 'series-detail', 'authors', 'author-detail', 'unsorted'].includes(view) && (
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

function ComicViewer({ book, mangaDefault, webtoonDefault, onBack, onSave, onMigrate }) {
  const [pages, setPages] = useState([])
  // displayPage is the position IN READING ORDER (what the footer
  // shows: "Page N of total"). Progress is saved as the ARCHIVE
  // index instead, so toggling manga mode never moves the bookmark:
  //   archiveIndex = manga ? (total - 1 - displayPage) : displayPage
  //   displayPage  = manga ? (total - 1 - archiveIndex) : archiveIndex
  const [displayPage, setDisplayPage] = useState(0)
  const [fit, setFit] = useState('width')
  const [status, setStatus] = useState('Loading comic…')
  // Per-comic modes, remembered on the book's progress. A saved
  // per-comic choice wins over the Settings defaults; the defaults
  // apply only when the book has no saved choice yet.
  const [manga, setManga] = useState(() => (book.progress && typeof book.progress.manga === 'boolean') ? book.progress.manga : !!mangaDefault)
  const [webtoon, setWebtoon] = useState(() => (book.progress && typeof book.progress.webtoon === 'boolean') ? book.progress.webtoon : !!webtoonDefault)
  const urlsRef = useRef([])
  const touchRef = useRef(null)
  const webtoonRef = useRef(null)
  const scrollTimerRef = useRef(null)
  const mangaRef = useRef(manga)
  const webtoonRefState = useRef(webtoon)
  mangaRef.current = manga
  webtoonRefState.current = webtoon
  const total = pages.length
  const archiveIndexOf = (disp) => (manga ? total - 1 - disp : disp)
  const displayIndexOf = (arch) => (manga ? total - 1 - arch : arch)

  function saveProgressFor(disp) {
    if (!total) return
    onSave(book, { page: archiveIndexOf(disp), manga: mangaRef.current, webtoon: webtoonRefState.current, at: Date.now() })
  }

  function goToDisplay(i) {
    if (i < 0 || i >= total) return
    setDisplayPage(i)
    saveProgressFor(i)
  }

  // MANGA SWIPE/TAP MAPPING (documented, Kuro-style):
  //   LTR (normal): swipe LEFT = next page, swipe RIGHT = previous;
  //                 tap RIGHT third = next, tap LEFT third = previous.
  //   RTL (manga):  swipe RIGHT = next page in reading order, swipe
  //                 LEFT = previous; tap LEFT third = next, tap RIGHT
  //                 third = previous. The next page in a manga sits on
  //                 the LEFT, so you move toward the left to advance —
  //                 which is why both the swipe and the tap zone flip.
  // The middle third never turns a page (it would fight with
  // scrolling/zooming). A drag over 40px counts as a swipe; a
  // shorter touch counts as a tap. One-page mode only — webtoon
  // scrolls instead, so it has no swipe/tap page turns.
  function onTouchStart(e) {
    if (webtoon || total < 2) return
    const t = e.touches[0]
    touchRef.current = { x: t.clientX, y: t.clientY, time: Date.now() }
  }
  function onTouchEnd(e) {
    if (webtoon || !touchRef.current) return
    const start = touchRef.current
    touchRef.current = null
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      // Swipe. RTL flips the direction: rightward = forward.
      const forward = manga ? dx > 0 : dx < 0
      goToDisplay(displayPage + (forward ? 1 : -1))
      return
    }
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      // Tap: divide the page into thirds by touch position.
      const rect = e.currentTarget.getBoundingClientRect()
      const relX = (t.clientX - rect.left) / Math.max(1, rect.width)
      if (relX < 0.33) goToDisplay(displayPage + (manga ? 1 : -1))
      else if (relX > 0.67) goToDisplay(displayPage + (manga ? -1 : 1))
    }
  }

  // Webtoon: on scroll-stop, save the page nearest the top as the
  // resume point (archive index, like one-page mode).
  function onWebtoonScroll() {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
    scrollTimerRef.current = setTimeout(() => {
      const container = webtoonRef.current
      if (!container || !total) return
      const imgs = container.querySelectorAll('[data-display-index]')
      const top = container.getBoundingClientRect().top
      let nearest = 0
      let nearestDist = Infinity
      imgs.forEach((img) => {
        const dist = Math.abs(img.getBoundingClientRect().top - top)
        if (dist < nearestDist) { nearestDist = dist; nearest = Number(img.getAttribute('data-display-index')) }
      })
      saveProgressFor(nearest)
    }, 300)
  }

  useEffect(() => {
    let cancelled = false
    if (!book.file) { setStatus('Loading comic…'); return () => { cancelled = true } }
    ;(async () => {
      try {
        let meta = book.metadata
        // MIGRATION for books imported before CBR/CBT/CB7 support:
        // they carry cbrUnsupported (or no pageNames at all). Re-parse
        // the stored blob with the new unpacker, save the fresh
        // metadata (series, cover, page list), and open the viewer —
        // never a fake open, and a failed re-parse is a clear error
        // that stays on this screen instead of a broken viewer.
        if (book.cbrUnsupported || !(meta.pageNames && meta.pageNames.length)) {
          setStatus('Re-reading this archive with the new unpacker…')
          const parsed = await parseComic(book.file, book.fileName)
          if (onMigrate) {
            const updated = await onMigrate(book, parsed)
            if (updated) meta = updated.metadata
          } else meta = parsed
        }
        const names = meta.pageNames || []
        const loaded = await loadComicPages(book.file, names, book.fileName)
        if (cancelled) return
        const urls = loaded.map(({ name, blob }) => ({ name, url: URL.createObjectURL(blob) }))
        urlsRef.current = urls
        setPages(urls)
        const saved = book.progress
        const arch = saved && typeof saved.page === 'number' && saved.page >= 0 && saved.page < urls.length ? saved.page : 0
        setDisplayPage(mangaRef.current ? urls.length - 1 - arch : arch)
        setStatus('')
      } catch (e) {
        if (!cancelled) setStatus(`Could not open comic: ${e.message}`)
      }
    })()
    return () => {
      cancelled = true
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u.url))
      urlsRef.current = []
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, book.file])

  // Reopening a webtoon resumes near the saved page once loaded.
  useEffect(() => {
    if (!webtoon || !total) return
    const container = webtoonRef.current
    if (!container) return
    const el = container.querySelector(`[data-display-index="${displayPage}"]`)
    if (el) el.scrollIntoView({ block: 'start' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webtoon, total])

  // The pages array is in ARCHIVE order; the page shown is the
  // archive page at this reading-order position (in manga mode
  // that is the mirror index — see archiveIndexOf above).
  const current = total ? pages[archiveIndexOf(displayPage)] : undefined

  return (
    <div className="card viewer">
      <h2>{book.metadata.title}</h2>
      <div className="toolbar">
        <button className="secondary" disabled={webtoon || displayPage <= 0} onClick={() => goToDisplay(displayPage - 1)}>← Previous page</button>
        <span>Page {total ? displayPage + 1 : '…'} of {total}{manga ? ' · right-to-left' : ''}{webtoon ? ' · webtoon' : ''}</span>
        <button className="secondary" disabled={webtoon || displayPage >= total - 1} onClick={() => goToDisplay(displayPage + 1)}>Next page →</button>
        <button className="secondary" disabled={webtoon} onClick={() => setFit(fit === 'width' ? 'page' : 'width')}>Fit: {fit === 'width' ? 'width' : 'page'}</button>
      </div>
      <div className="toolbar">
        <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={manga} onChange={(e) => {
            const next = e.target.checked
            // Keep the same ARCHIVE page bookmarked across the flip:
            // convert the current display page to archive, flip the
            // mode, then convert back — the book does not jump.
            const arch = archiveIndexOf(displayPage)
            setManga(next)
            mangaRef.current = next
            setDisplayPage(next ? total - 1 - arch : arch)
            onSave(book, { page: arch, manga: next, webtoon: webtoonRefState.current, at: Date.now() })
          }} />
          Manga mode (right-to-left)
        </label>
        <label className="progress" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={webtoon} onChange={(e) => {
            const next = e.target.checked
            setWebtoon(next)
            webtoonRefState.current = next
            saveProgressFor(displayPage)
          }} />
          Webtoon mode (vertical strip)
        </label>
      </div>
      {status && <p className="progress">{status}</p>}
      {webtoon ? (
        <div className="comic-webtoon" ref={webtoonRef} onScroll={onWebtoonScroll}>
          {pages.map((p, i) => {
            const arch = manga ? total - 1 - i : i
            return <img key={p.name} data-display-index={i} src={pages[arch].url} alt={`Page ${i + 1}`} className="comic-page fit-width" />
          })}
        </div>
      ) : (
        current && (
          <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <img src={current.url} alt={`Page ${displayPage + 1}`} className={fit === 'width' ? 'comic-page fit-width' : 'comic-page fit-page'} />
          </div>
        )
      )}
      {!webtoon && total > 1 && (
        <div className="thumb-strip">
          {pages.map((p, i) => {
            // Thumbnails follow READING order (display order), so in
            // manga mode the strip runs right-to-left too.
            const arch = manga ? total - 1 - i : i
            const thumb = pages[arch]
            return (
              <button key={p.name} className={i === displayPage ? 'thumb active' : 'thumb'} onClick={() => goToDisplay(i)} aria-label={`Go to page ${i + 1}`}>
                <img src={thumb.url} alt="" loading="lazy" />
                <span>{i + 1}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}


function AudioPlayer({ book, onBack, onSave, readAlongPair, onReadAlong }) {
  // ---- Parts -------------------------------------------------------
  // A single-file book has no audioParts: it is exactly one part
  // derived from the book itself, so single-file behaviour (play,
  // seek, save, display) is byte-for-byte identical to before and
  // no part UI is shown. A multi-part book's audioParts were built
  // at import (see importFiles + src/lib/multipart.js): each part
  // keeps its own fileName, its own import-time stored URI (true
  // extension preserved), and its own durationSec where known.
  const parts = useMemo(() => {
    if (book.audioParts && book.audioParts.length) return book.audioParts
    return [{ partId: book.id, fileName: book.fileName, audioFileUri: book.audioFileUri || null, durationSec: book.metadata.durationSec || null }]
  }, [book])
  const isMulti = parts.length > 1
  const initialDurations = useMemo(() => parts.map((p) => p.durationSec || null), [parts])

  // ---- State -------------------------------------------------------
  const [current, setCurrent] = useState(0) // GLOBAL position (sec)
  const [partDurations, setPartDurations] = useState(initialDurations)
  const [partIndex, setPartIndex] = useState(() => resumeForSaved(book.progress, initialDurations).partIndex)
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
  const partIndexRef = useRef(partIndex)
  const chapterRef = useRef(0)
  const bookmarksRef = useRef(bookmarks)
  const ctrlRef = useRef(null)
  const bookRef = useRef(book)
  const partDurationsRef = useRef(partDurations)
  const startOffsetRef = useRef(resumeForSaved(book.progress, initialDurations).offsetInPart)
  const autoplayRef = useRef(false)
  const chaptersRef = useRef([])
  bookRef.current = book
  bookmarksRef.current = bookmarks
  partIndexRef.current = partIndex
  partDurationsRef.current = partDurations

  // Global totals. knownTotal = sum of KNOWN part durations; when
  // every part's duration is known it is the true total. An MP3
  // part's duration is unknown until it plays, so the total GROWS
  // as parts report theirs — the UI shows remaining with a '+'
  // while the total is incomplete, never presenting a partial
  // total as final (see the seek row below).
  const knownTotal = partDurations.reduce((a, d) => (typeof d === 'number' && d > 0 ? a + d : a), 0)
  const totalComplete = partDurations.every((d) => typeof d === 'number' && d > 0)
  const total = knownTotal
  const remaining = Math.max(0, total - current)
  // Chapters: the stored list is authoritative. For a single-part
  // book it is that file's chapters, unchanged. For a multi-part
  // book it is the GLOBAL list built at import (each part's
  // chapters shifted by its start offset, parts after an
  // unknown-duration part omitted, never faked — see multipart.js).
  // Playback never re-derives it, so it cannot double-shift.
  const chs = book.audioChapters || []
  chaptersRef.current = chs

  function saveProgress(pos, partIdx, chap) {
    const progress = { positionSec: pos, partIndex: partIdx, chapterIndex: chap, bookmarks: bookmarksRef.current, at: Date.now() }
    onSave(bookRef.current, progress)
  }
  const saveProgressRef = useRef(saveProgress)
  saveProgressRef.current = saveProgress

  // ---- Controller per part -----------------------------------------
  // The controller surface is single-track (one Playlist item, one
  // <audio> element), so multi-part playback is a track manager on
  // top of it: one controller per part, created when the part
  // starts, destroyed when it ends or the user jumps parts. On a
  // part's natural end the next part starts automatically (and
  // keeps playing if playback was playing — it always is at a
  // natural end). Cross-part seeks and part buttons reuse the same
  // path: set the start offset, flip partIndex, let this effect
  // build the new controller. No gap handling beyond a normal
  // track change — that is the documented behaviour, not a bug.
  // The controller is NOT paused on unmount: native background
  // playback keeps going after leaving this screen, as before.
  // The final position is saved on unmount via the refs above.
  useEffect(() => {
    let cancelled = false
    let ctrl = null
    setLoading(true)
    setPlayerError('')
    const part = parts[partIndex]
    const startPos = startOffsetRef.current || 0
    startOffsetRef.current = 0
    const sums = knownSums(partDurationsRef.current)
    currentRef.current = sums[partIndex] + startPos
    lastSavedRef.current = currentRef.current
    setCurrent(currentRef.current)
    ;(async () => {
      let fileBuf = null
      if (!part.audioFileUri) {
        try { fileBuf = await getBookFile(part.partId) } catch { /* fall through to book.file */ }
        if (!fileBuf && book.file) fileBuf = book.file
      }
      const partBook = {
        id: part.partId,
        fileName: part.fileName,
        metadata: book.metadata,
        audioFileUri: part.audioFileUri || null,
      }
      try {
        const c = await createAudioController({
          book: partBook,
          fileBuf,
          startPosition: startPos,
          pauseOnDestroy: false,
          cbs: {
            onPosition: (pos, dur) => {
              if (cancelled) return
              const idx = partIndexRef.current
              if (dur > 0 && partDurationsRef.current[idx] !== dur) {
                setPartDurations((prev) => {
                  const next = [...prev]
                  next[idx] = dur
                  return next
                })
              }
              const global = knownSums(partDurationsRef.current)[idx] + pos
              currentRef.current = global
              setCurrent(global)
              const chs = chaptersRef.current
              if (chs.length) {
                let ci = 0
                for (let i = 0; i < chs.length; i++) if (chs[i].start <= global + 0.5) ci = i
                if (ci !== chapterRef.current) { chapterRef.current = ci; setChapterIndex(ci) }
              }
              if (Math.abs(global - lastSavedRef.current) > 5) {
                lastSavedRef.current = global
                saveProgressRef.current(global, idx, chapterRef.current)
              }
            },
            onPlaying: (p) => { if (!cancelled) setPlaying(p) },
            onEnded: () => {
              if (cancelled) return
              const idx = partIndexRef.current
              if (idx < parts.length - 1) {
                // Advance to the next part, still playing.
                autoplayRef.current = true
                startOffsetRef.current = 0
                setPartIndex(idx + 1)
              } else {
                setPlaying(false)
              }
            },
            onError: () => { if (!cancelled) setPlayerError('Playback reported an error. Try pressing play again, or re-import the file.') },
          },
        })
        if (cancelled) { c.destroy(); return }
        ctrl = c
        ctrlRef.current = c
        setPlayerMode(c.mode)
        if (c.fallbackFromNative) setPlayerError('Native player was unavailable, so this is playing with the in-app player (no background playback).')
        if (autoplayRef.current) { autoplayRef.current = false; c.play() }
        setLoading(false)
      } catch {
        if (!cancelled) { setPlayerError('Could not start playback for this file.'); setLoading(false) }
      }
    })()
    return () => {
      cancelled = true
      if (currentRef.current > 0) saveProgressRef.current(currentRef.current, partIndexRef.current, chapterRef.current)
      if (ctrl) ctrl.destroy()
      else if (ctrlRef.current) ctrlRef.current.destroy()
      ctrlRef.current = null
      if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, partIndex])

  // ---- Seeking (GLOBAL) --------------------------------------------
  function seekToGlobal(sec) {
    const target = Math.max(0, total > 0 ? Math.min(total, sec) : sec)
    const { partIndex: idx, offsetInPart } = mapGlobalToPart(target, partDurationsRef.current)
    const chs = chaptersRef.current
    let ci = 0
    for (let i = 0; i < chs.length; i++) if (chs[i].start <= target + 0.5) ci = i
    chapterRef.current = ci
    setChapterIndex(ci)
    currentRef.current = target
    setCurrent(target)
    saveProgress(target, idx, ci)
    if (idx !== partIndexRef.current) {
      // Cross-part seek: rebuild the controller on the new part.
      // Keep the playing state: a seek while playing resumes
      // playing on the new part; a seek while paused stays paused.
      autoplayRef.current = playing
      startOffsetRef.current = offsetInPart
      setPartIndex(idx)
    } else if (ctrlRef.current) {
      ctrlRef.current.seekTo(offsetInPart)
    }
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
    onSave(book, { positionSec: currentRef.current, partIndex: partIndexRef.current, chapterIndex: chapterRef.current, bookmarks: next, at: Date.now() })
  }

  function seekChapter(delta) {
    const chs = chaptersRef.current
    if (!chs.length) return
    if (delta > 0) {
      const next = chs.find((c) => c.start > currentRef.current + 1)
      if (next) seekToGlobal(next.start)
    } else {
      let prev = null
      for (const c of chs) if (c.start < currentRef.current - 1) prev = c
      if (prev) seekToGlobal(prev.start)
      else seekToGlobal(0)
    }
  }

  function seekPart(delta) {
    if (!isMulti) return
    const idx = partIndexRef.current + delta
    if (idx < 0 || idx >= parts.length) return
    autoplayRef.current = playing
    startOffsetRef.current = 0
    const target = knownSums(partDurationsRef.current)[idx]
    currentRef.current = target
    setCurrent(target)
    saveProgress(target, idx, chapterRef.current)
    setPartIndex(idx)
  }

  const cover = book.metadata.coverDataUrl || book.metadata.coverUrl || ''
  return (
    <div className="card viewer audio-player-dark">
      <h2>{book.metadata.title}</h2>
      <p>{book.metadata.author || 'Unknown author'}</p>
      {isMulti && <p className="progress">Part {partIndex + 1} of {parts.length} · {parts[partIndex].fileName}</p>}
      {playerMode === 'native' && <p className="progress">Native player — keeps playing in the background, with lock-screen / notification controls.</p>}
      {playerMode === 'html' && <p className="progress">In-app player (web fallback).</p>}
      {loading && <p className="progress">Loading audio…</p>}
      {playerError && <p className="error">{playerError}</p>}
      <div className="audio-player-main">
        <div className="audio-cover-wrap" onClick={togglePlay} role="button" aria-label={playing ? 'Pause' : 'Play'}>
          {cover
            ? <img src={cover} alt="" className="audio-cover" />
            : <div className="audio-cover audio-cover-placeholder">🎧</div>}
          <button className="audio-cover-play" onClick={(e) => { e.stopPropagation(); togglePlay() }} disabled={loading} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? '⏸' : '▶'}
          </button>
        </div>
        <div className="audio-seek">
          <input type="range" min="0" max={Math.max(total, current)} step="1" value={Math.min(current, Math.max(total, current))} onChange={(e) => seekToGlobal(Number(e.target.value))} />
          <div className="audio-times">
            <span>{formatTime(current)}</span>
            <span>{total > 0 ? `-${formatTime(remaining)}${totalComplete ? '' : '+'}` : '—'}</span>
          </div>
          {!totalComplete && total > 0 && <p className="progress">Total still growing: an MP3 part's length is not known until it plays, so the remaining time is a lower bound for now.</p>}
        </div>
        <div className="toolbar audio-skip-row">
          <button className="secondary" onClick={() => seekToGlobal(current - 60)}>−1m</button>
          <button className="secondary" onClick={() => seekToGlobal(current - 10)}>−10s</button>
          <button onClick={togglePlay} disabled={loading}>{playing ? '⏸ Pause' : '▶ Play'}</button>
          <button className="secondary" onClick={() => seekToGlobal(current + 10)}>+10s</button>
          <button className="secondary" onClick={() => seekToGlobal(current + 60)}>+1m</button>
        </div>
        <div className="toolbar">
          <label>Speed
            <select value={speed} onChange={(e) => { const s = Number(e.target.value); setSpeed(s); if (ctrlRef.current) ctrlRef.current.setRate(s) }}>
              {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => <option key={s} value={s}>{s.toFixed(1)}x</option>)}
            </select>
          </label>
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
          <button className="secondary" disabled={!chs.length} onClick={() => seekChapter(-1)}>⏮ Chapter</button>
          <button className="secondary" disabled={!chs.length} onClick={() => seekChapter(1)}>Chapter ⏭</button>
          {isMulti && <button className="secondary" disabled={partIndex <= 0} onClick={() => seekPart(-1)}>⏮ Part</button>}
          {isMulti && <button className="secondary" disabled={partIndex >= parts.length - 1} onClick={() => seekPart(1)}>Part ⏭</button>}
          {readAlongPair && <button onClick={onReadAlong}>🎧 Read along with EPUB</button>}
        </div>
      </div>
      {chs.length > 0 ? (
        <details open>
          <summary><h3 style={{ display: 'inline' }}>Chapters ({chs.length})</h3></summary>
          {chs.map((ch, i) => (
            <div key={i} className={i === chapterIndex ? 'chapter-row active' : 'chapter-row'}>
              <button className="secondary" onClick={() => seekToGlobal(ch.start)}>{ch.title}</button>
              <span>{formatTime(ch.start)}</span>
            </div>
          ))}
        </details>
      ) : (
        <p className="progress">No chapters embedded in this file. Use bookmarks above to mark places instead — playback position is still saved.</p>
      )}
      {bookmarks.length > 0 && (
        <details open>
          <summary><h3 style={{ display: 'inline' }}>Bookmarks</h3></summary>
          {bookmarks.map((b, i) => (
            <div key={i}><button className="secondary" onClick={() => seekToGlobal(b.time)}>{b.label}</button></div>
          ))}
        </details>
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
