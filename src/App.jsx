import { useEffect, useMemo, useRef, useState } from 'react'
import { getAllBooks, putBook, deleteBook, clearLibrary, saveProgressLocal, loadProgressLocal } from './lib/db.js'
import { parseEpub, parseChapters, fetchAsDataUrl } from './lib/epub.js'
import { parsePdf, loadPdf, renderPdfPage, searchPdf } from './lib/pdf.js'
import { parseCbz, getCbzPageBlob, isCbrFile } from './lib/comic.js'
import { parseAudio, parseMp3Tags, formatTime } from './lib/audio.js'
import { enrichBook } from './lib/enrich.js'
import { groupBySeries, getSeries, sortBooks } from './lib/series.js'
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

function BookCard({ book, onOpen }) {
  const cover = coverFor(book)
  const s = getSeries(book)
  const prog = book.progress
  return (
    <button className="book" onClick={() => onOpen(book)}>
      {cover ? <img src={cover} alt="" /> : <div className="cover">No cover</div>}
      <h3>{book.metadata.title}</h3>
      <p>{book.metadata.author || 'Unknown author'}</p>
      <p className="format-badge">{formatLabel(book)}
        {book.format === 'pdf' && book.metadata.pageCount ? ` · ${book.metadata.pageCount} pages` : ''}
        {book.format === 'comic' && book.metadata.pageCount ? ` · ${book.metadata.pageCount} pages` : ''}
        {book.format === 'audio' && book.metadata.durationSec ? ` · ${formatTime(book.metadata.durationSec)}` : ''}
        {book.format === 'audio' && prog && prog.positionSec ? ` · ▶ ${formatTime(prog.positionSec)}` : ''}
      </p>
      <p>{cloudStatusLabel(book)}</p>
      {s.name && <p>📚 {s.name}{s.index !== null ? ` #${s.index}` : ''}</p>}
      {book.linkedAudioId && <p>🎧 Read-along linked</p>}
      {book.fixedFields && book.fixedFields.length > 0 && <p>✓ Fixed: {book.fixedFields.join(', ')}</p>}
    </button>
  )
}

export default function App() {
  const [books, setBooks] = useState([])
  const [view, setView] = useState('library') // library | detail | reader | fixes | pdf | comic | audio | readalong
  const [selected, setSelected] = useState(null)
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState('series')
  const [formatFilter, setFormatFilter] = useState('all')
  const [expanded, setExpanded] = useState({})
  const [importStatus, setImportStatus] = useState('')
  const [importErrors, setImportErrors] = useState([])
  const [drag, setDrag] = useState(false)
  const [proposals, setProposals] = useState([])
  const [enriching, setEnriching] = useState(false)
  const [enrichStatus, setEnrichStatus] = useState('')
  const [edits, setEdits] = useState({})
  const [chapters, setChapters] = useState([])
  const [chapterIndex, setChapterIndex] = useState(0)
  const [fontSize, setFontSize] = useState(18)
  const [readerTheme, setReaderTheme] = useState('light')
  const [readerSearch, setReaderSearch] = useState('')
  const [readerHits, setReaderHits] = useState([])
  const [exporting, setExporting] = useState(false)
  // App-wide light/dark mode: persisted, system preference on first load.
  const [appTheme, setAppTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('shelfsort-theme')
      if (saved === 'light' || saved === 'dark') return saved
    } catch { /* ignore */ }
    return (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'
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

  async function reload() {
    const all = await getAllBooks()
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
      return { format: 'comic', metadata: { title: clean, author: '', creators: [], language: '', publisher: '', date: '', description: '', identifier: '', isbn: '', series: '', seriesIndex: '', coverDataUrl: '', pageCount: 0 }, extra: { cbrUnsupported: true } }
    }
    if (/\.m4b$/i.test(name)) {
      const parsed = parseAudio(buf, name)
      return { format: 'audio', metadata: { ...parsed, chapters: undefined }, extra: { audioChapters: parsed.chapters, durationSec: parsed.durationSec } }
    }
    if (/\.mp3$/i.test(name)) {
      const tags = parseMp3Tags(buf, name)
      return { format: 'audio', metadata: { title: tags.title, author: tags.author, creators: tags.author ? [tags.author] : [], language: '', publisher: '', date: '', description: '', identifier: '', isbn: '', series: '', seriesIndex: '', coverDataUrl: '' }, extra: { audioChapters: [], durationSec: null } }
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
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer()
        const parsed = await parseByFormat(file, buf)
        // For audio, duration/chapters live on the book record, not
        // in metadata (enrichment must not overwrite them).
        const metadata = { ...parsed.metadata }
        if (parsed.extra.durationSec) metadata.durationSec = parsed.extra.durationSec
        const book = {
          id: uid(),
          fileName: file.name,
          file: buf,
          format: parsed.format,
          metadata,
          audioChapters: parsed.extra.audioChapters || [],
          cbrUnsupported: !!parsed.extra.cbrUnsupported,
          addedAt: Date.now(),
          progress: null,
          fixedFields: [],
        }
        await putBook(book)
        imported++
        setImportStatus(`Imported ${imported} of ${files.length}…`)
      } catch (e) {
        errors.push(`${file.name}: ${e.message}`)
      }
    }
    setImportErrors(errors)
    setImportStatus(`Done — imported ${imported} of ${files.length} file(s).${errors.length ? ` ${errors.length} failed (see below).` : ''}`)
    await reload()
  }

  // ---- Enrichment / Fix Review ---------------------------------------
  async function runEnrichment() {
    setEnriching(true)
    setEnrichStatus('Checking books for missing metadata…')
    setProposals([])
    const found = []
    for (let i = 0; i < books.length; i++) {
      setEnrichStatus(`Checking ${i + 1} of ${books.length}: ${books[i].metadata.title}`)
      try {
        const result = await enrichBook(books[i])
        if (result) found.push(result)
      } catch { /* a failed lookup is not a failed book */ }
    }
    setProposals(found)
    const initial = {}
    for (const p of found) initial[p.bookId] = { ...p.proposals }
    setEdits(initial)
    setEnriching(false)
    setEnrichStatus(found.length ? `Found proposed fixes for ${found.length} book(s). Review them below — nothing has been applied yet.` : 'No fixes found. Your books may already be complete, or the sources had no match.')
    setView('fixes')
  }

  async function applyProposal(bookId, values) {
    const book = books.find((b) => b.id === bookId)
    if (!book) return
    const updated = { ...book, metadata: { ...book.metadata }, fixedFields: [...(book.fixedFields || [])] }
    for (const [field, value] of Object.entries(values)) {
      if (field === 'coverUrl') {
        try {
          updated.metadata.coverDataUrl = await fetchAsDataUrl(value)
          updated.metadata.coverUrl = value
        } catch {
          updated.metadata.coverUrl = value
        }
        if (!updated.fixedFields.includes('cover')) updated.fixedFields.push('cover')
      } else {
        updated.metadata[field] = value
        if (!updated.fixedFields.includes(field)) updated.fixedFields.push(field)
      }
    }
    await putBook(updated)
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
    await putBook(updated)
    setSelected(updated)
    await reload()
  }

  async function linkBooks(epubBook, audioBook) {
    const epubUpdated = { ...epubBook, linkedAudioId: audioBook ? audioBook.id : null }
    await putBook(epubUpdated)
    if (audioBook) {
      const audioUpdated = { ...audioBook, linkedEpubId: epubBook.id }
      await putBook(audioUpdated)
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
  async function ensureLocal(book) {
    if (book.file) return book
    if (!book.r2Key) throw new Error('This book has no local file and no cloud copy.')
    const settings = requireR2()
    setCloudProgress(`Downloading ${book.metadata.title} from R2…`)
    try {
      const buf = await downloadFromR2(settings, book.r2Key, (p) => {
        if (p.total) setCloudProgress(`Downloading ${book.metadata.title}… ${p.pct}%`)
      })
      const updated = { ...book, file: buf }
      await putBook(updated)
      setSelected(updated)
      await reload()
      setCloudProgress('')
      return updated
    } catch (e) {
      setCloudProgress('')
      throw e
    }
  }

  async function uploadBook(book, force = false) {
    const settings = requireR2()
    if (book.r2Key && !force) return book
    if (!book.file) throw new Error(`"${book.metadata.title}" has no local file to upload.`)
    const key = book.r2Key || r2KeyFor(book)
    setCloudProgress(`Uploading ${book.metadata.title}…`)
    const uploadedKey = await uploadToR2({ ...settings }, { ...book, r2Key: key }, (p) => {
      setCloudProgress(p.total ? `Uploading ${book.metadata.title}… ${p.pct}%` : `Uploading ${book.metadata.title}…`)
    })
    const updated = { ...book, r2Key: uploadedKey }
    await putBook(updated)
    setCloudProgress('')
    return updated
  }

  async function clearLocalFor(book) {
    const settings = requireR2()
    if (!book.r2Key) throw new Error('This book is not in R2 yet — upload it first, so clearing local does not lose it.')
    if (!book.file) return book
    // Verify the cloud copy actually exists before deleting the only
    // local copy. A failed verification aborts the clear, by design.
    const head = await headR2Object(settings, book.r2Key)
    if (!head.exists) throw new Error('R2 does not contain this book (HeadObject found nothing), so the local copy was NOT deleted.')
    const updated = { ...book, file: null }
    await putBook(updated)
    return updated
  }

  async function deleteFromCloudFor(book) {
    const settings = requireR2()
    if (!book.r2Key) return book
    await deleteFromR2(settings, book.r2Key)
    const updated = { ...book, r2Key: null }
    await putBook(updated)
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
    // Cloud-only books are downloaded on demand, then opened exactly
    // like a local book. If the download fails, fall back to the detail
    // page (with cloud actions) instead of a broken viewer.
    let local = book
    if (!book.file && book.r2Key) {
      try {
        setCloudMsg(`Downloading ${book.metadata.title} from R2…`)
        local = await ensureLocal(book)
        setCloudMsg('')
      } catch (e) {
        setCloudMsg(`Could not download "${book.metadata.title}": ${friendlyR2Error(e)}`)
        setSelected(book)
        setView('detail')
        return
      }
    }
    setSelected(local)
    if (local.format === 'pdf') { setView('pdf'); return }
    if (local.format === 'comic') { setView('comic'); return }
    if (local.format === 'audio') { setView('audio'); return }
    setView('detail')
  }

  async function openReader(book) {
    let local = book
    try { local = await ensureLocal(book) } catch (e) { alert(`Could not download this book: ${friendlyR2Error(e)}`); return }
    setSelected(local)
    setChapters([])
    setReaderHits([])
    setReaderSearch('')
    const parsed = await parseChapters(local.file)
    setChapters(parsed)
    const saved = book.progress || loadProgressLocal(book.id)
    setChapterIndex(saved && saved.chapterIndex < parsed.length ? saved.chapterIndex : 0)
    setView('reader')
  }

  async function goToChapter(book, index) {
    setChapterIndex(index)
    const progress = { chapterIndex: index, at: Date.now() }
    saveProgressLocal(book.id, progress)
    const updated = { ...book, progress }
    await putBook(updated)
    setSelected(updated)
    setBooks((prev) => prev.map((b) => (b.id === book.id ? updated : b)))
  }

  async function openViewer(book, targetView) {
    let local = book
    try { local = await ensureLocal(book) } catch (e) { alert(`Could not download this book: ${friendlyR2Error(e)}`); return }
    setSelected(local)
    setView(targetView)
  }

  async function openReadAlong(book) {
    const pair = linkedPairFor(book)
    if (!pair) { setView('readalong'); return }
    try {
      const epubLocal = await ensureLocal(pair.epub)
      const audioLocal = await ensureLocal(pair.audio)
      // Refresh the pair in state so ReadAlongView gets local files.
      await reload()
      setSelected(epubLocal.format === 'epub' ? epubLocal : audioLocal)
      setView('readalong')
    } catch (e) {
      alert(`Could not download the read-along pair: ${friendlyR2Error(e)}`)
    }
  }

  function searchInBook() {
    const q = readerSearch.trim().toLowerCase()
    if (!q) { setReaderHits([]); return }
    const hits = []
    chapters.forEach((ch, i) => {
      const idx = ch.text.toLowerCase().indexOf(q)
      if (idx >= 0) {
        hits.push({ chapter: i, title: ch.title, snippet: ch.text.slice(Math.max(0, idx - 60), idx + 120) })
      }
    })
    setReaderHits(hits)
  }

  async function exportBook(book) {
    setExporting(true)
    try {
      const blob = await buildCorrectedEpub(book, book.metadata, book.metadata.coverDataUrl || '')
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
    let list = books
    if (formatFilter !== 'all') list = list.filter((b) => b.format === formatFilter)
    if (q) {
      list = list.filter((b) => {
        const s = getSeries(b)
        return [b.metadata.title, b.metadata.author, s.name, b.fileName].join(' ').toLowerCase().includes(q)
      })
    }
    return sortBooks(list, sortMode)
  }, [books, search, sortMode, formatFilter])

  const groups = useMemo(() => (sortMode === 'series' ? groupBySeries(filtered) : null), [filtered, sortMode])
  const detail = selected && books.find((b) => b.id === selected.id)
  const detailPair = detail ? linkedPairFor(detail) : null
  const detailAuto = detail ? autoMatchFor(detail) : null

  return (
    <>
      <header>
        <div>
          <h1>📖 ShelfSort</h1>
          <div className="tagline">EPUB · PDF · Comics · Audiobooks — fix metadata & covers · sort by series</div>
        </div>
        <div className="toolbar" style={{ marginLeft: 'auto' }}>
          <button className="theme-toggle" onClick={() => setAppTheme(appTheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle light/dark mode">
            {appTheme === 'dark' ? '☀️ Light mode' : '🌙 Dark mode'}
          </button>
          <button onClick={() => { setSelected(null); setView('library') }}>Library</button>
          <button className="secondary" onClick={() => setView('cloud')}>☁️ Cloud / Settings</button>
          <button className="secondary" onClick={runEnrichment} disabled={enriching || !books.length}>
            {enriching ? 'Checking…' : 'Find fixes'}
          </button>
        </div>
      </header>

      <main>
        {view === 'library' && (
          <>
            <div
              className={`dropzone ${drag ? 'drag' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); importFiles(e.dataTransfer.files) }}
            >
              <p><strong>Drop files or a folder here</strong>, or use the buttons below.</p>
              <p className="progress">EPUB, PDF, CBZ, CBR, M4B, MP3. CBR files are detected but cannot be opened in this build — see the note on a CBR book's detail page.</p>
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
              <input type="search" placeholder="Search title, author, or series…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <select value={formatFilter} onChange={(e) => setFormatFilter(e.target.value)} aria-label="Format filter">
                <option value="all">All formats</option>
                <option value="epub">EPUB</option>
                <option value="pdf">PDF</option>
                <option value="comic">Comic</option>
                <option value="audio">Audiobook</option>
              </select>
              <select value={sortMode} onChange={(e) => setSortMode(e.target.value)} aria-label="Sort">
                <option value="series">Sort: Series</option>
                <option value="author">Sort: Author</option>
                <option value="title">Sort: Title</option>
                <option value="recent">Sort: Recently added</option>
              </select>
              <button className="secondary" onClick={async () => { if (confirm('Remove all books from ShelfSort? Files on your phone are not deleted.')) { await clearLibrary(); await reload() } }}>
                Clear library
              </button>
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
            ) : sortMode === 'series' && groups ? (
              groups.map((g) => (
                <section className="series-group" key={g.key}>
                  <h2 onClick={() => setExpanded((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}>
                    {expanded[g.key] === false ? '▶' : '▼'} {g.name} ({g.books.length})
                  </h2>
                  {g.gaps.length > 0 && (
                    <p className="gap">⚠️ Missing in this series: {g.gaps.map((n) => `#${n}`).join(', ')} — you own {g.books.map((b) => getSeries(b).index).filter((n) => n !== null).join(', ')}.</p>
                  )}
                  {expanded[g.key] !== false && (
                    <div className="grid">
                      {g.books.map((b) => <BookCard key={b.id} book={b} onOpen={openBook} />)}
                    </div>
                  )}
                </section>
              ))
            ) : (
              <div className="grid">
                {filtered.map((b) => <BookCard key={b.id} book={b} onOpen={openBook} />)}
              </div>
            )}
          </>
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
                {cloudProgress && <p className="progress">{cloudProgress}</p>}
                {cloudMsg && <p className="progress">{cloudMsg}</p>}
                <div className="toolbar">
                  {!r2Settings && <button className="secondary" onClick={() => setView('cloud')}>Set up Cloud / R2</button>}
                  {r2Settings && detail.file && !detail.r2Key && <button className="secondary" onClick={async () => { try { const u = await uploadBook(detail); setSelected(u); await reload(); setCloudMsg(`Uploaded "${detail.metadata.title}" to R2.`) } catch (e) { setCloudMsg(`Upload failed: ${friendlyR2Error(e)}`) } }}>☁️ Upload to R2</button>}
                  {r2Settings && detail.file && detail.r2Key && <button className="secondary" onClick={async () => { try { const u = await uploadBook(detail, true); setSelected(u); await reload(); setCloudMsg(`Re-uploaded "${detail.metadata.title}" to R2.`) } catch (e) { setCloudMsg(`Upload failed: ${friendlyR2Error(e)}`) } }}>☁️ Re-upload to R2</button>}
                  {r2Settings && detail.file && detail.r2Key && <button className="secondary" onClick={async () => { try { const u = await clearLocalFor(detail); setSelected(u); await reload(); setCloudMsg(`Local copy cleared for "${detail.metadata.title}". Metadata, cover, series and progress are kept; open it anytime to download it again.`) } catch (e) { setCloudMsg(`Clear local failed: ${friendlyR2Error(e)}`) } }}>🧹 Clear local (keep in R2)</button>}
                  {r2Settings && !detail.file && detail.r2Key && <button onClick={() => openBook(detail)}>☁️ Download from R2 & open</button>}
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
              const pending = books.filter((b) => b.file && !b.r2Key)
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
              for (const b of books.filter((x) => x.file && x.r2Key)) {
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
                file: null,
                format,
                metadata: { title: titleFromR2Key(obj.key), author: '', creators: [], language: '', publisher: '', date: '', description: '', identifier: '', isbn: '', series: '', seriesIndex: '', coverDataUrl: '', pageCount: 0 },
                audioChapters: [],
                cbrUnsupported: ext === 'cbr',
                addedAt: Date.now(),
                progress: null,
                fixedFields: [],
                r2Key: obj.key,
              }
              await putBook(book)
              await reload()
              setSyncMsg(`Added "${book.metadata.title}" as Cloud only. Open it to download it, then its real metadata/cover will be parsed on import — or download it and re-import locally for full metadata.`)
            }}
            onDownloadBook={async (book) => {
              try { await ensureLocal(book); setCloudMsg(`Downloaded "${book.metadata.title}" — it is now local again.`) } catch (e) { setCloudMsg(`Download failed: ${friendlyR2Error(e)}`) }
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
            <p className="progress">Nothing here is applied until you press Apply. Edit any proposed value before applying it.</p>
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
              <button className="secondary" disabled={chapterIndex <= 0} onClick={() => goToChapter(selected, chapterIndex - 1)}>← Previous chapter</button>
              <button className="secondary" disabled={chapterIndex >= chapters.length - 1} onClick={() => goToChapter(selected, chapterIndex + 1)}>Next chapter →</button>
              <select value={chapterIndex} onChange={(e) => goToChapter(selected, Number(e.target.value))}>
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
                  <div key={i}><button className="secondary" onClick={() => goToChapter(selected, h.chapter)}>{h.title}</button> …{h.snippet}…</div>
                ))}
              </div>
            )}
            {!chapters.length ? <p className="progress">Loading chapters…</p> : (
              <article className="chapter" style={{ ['--reader-size']: `${fontSize}px` }}
                dangerouslySetInnerHTML={{ __html: chapters[chapterIndex]?.html || '<p>No readable chapter content found in this EPUB.</p>' }} />
            )}
          </div>
        )}

        {view === 'pdf' && selected && <PdfViewer book={selected} onBack={() => setView('detail')} onSave={async (book, progress) => { const u = { ...book, progress }; await putBook(u); setSelected(u); await reload() }} />}
        {view === 'comic' && selected && <ComicViewer book={selected} onBack={() => setView('detail')} onSave={async (book, progress) => { const u = { ...book, progress }; await putBook(u); setSelected(u); await reload() }} />}
        {view === 'audio' && selected && <AudioPlayer book={selected} onBack={() => setView('detail')} onSave={async (book, progress) => { const u = { ...book, progress }; await putBook(u); setSelected(u); }} readAlongPair={linkedPairFor(selected)} onReadAlong={() => openReadAlong(selected)} />}
        {view === 'readalong' && selected && <ReadAlongView epubBook={detailPair ? detailPair.epub : selected} audioBook={detailPair ? detailPair.audio : null} books={books} onBack={() => setView('detail')} onSave={async (book, progress) => { const u = { ...book, progress }; await putBook(u); }} />}
      </main>
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
              {b.file && !b.r2Key && <button className="secondary" onClick={() => onUploadBook(b)}>Upload</button>}
              {b.file && b.r2Key && <button className="secondary" onClick={() => onClearLocalBook(b)}>Clear local</button>}
              {!b.file && b.r2Key && <button className="secondary" onClick={() => onDownloadBook(b)}>Download</button>}
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
    loadPdf(book.file).then((doc) => {
      if (cancelled) return
      docRef.current = doc
      setTotal(doc.numPages)
      const saved = book.progress
      if (saved && saved.page >= 1 && saved.page <= doc.numPages) setPage(saved.page)
      setStatus('')
    }).catch((e) => setStatus(`Could not open PDF: ${e.message}`))
    return () => { cancelled = true }
  }, [book.id])

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
  }, [book.id])

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
  const audioRef = useRef(null)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(book.metadata.durationSec || 0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [sleepMin, setSleepMin] = useState(0)
  const [sleepLeft, setSleepLeft] = useState(0)
  const [bookmarks, setBookmarks] = useState((book.progress && book.progress.bookmarks) || [])
  const [url, setUrl] = useState('')
  const [chapterIndex, setChapterIndex] = useState(0)
  const sleepTimerRef = useRef(null)
  const lastSavedRef = useRef(0)

  useEffect(() => {
    const type = book.fileName && /\.mp3$/i.test(book.fileName) ? 'audio/mpeg' : 'audio/mp4'
    const u = URL.createObjectURL(new Blob([book.file], { type }))
    setUrl(u)
    const saved = book.progress
    if (saved && saved.positionSec) setCurrent(saved.positionSec)
    return () => URL.revokeObjectURL(u)
  }, [book.id])

  useEffect(() => {
    const el = audioRef.current
    if (!el || !url) return
    el.currentTime = current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  useEffect(() => () => { if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current) }, [])

  function saveProgress(pos, chap) {
    const progress = { positionSec: pos, chapterIndex: chap, bookmarks, at: Date.now() }
    onSave(book, progress)
  }

  function onTimeUpdate() {
    const el = audioRef.current
    if (!el) return
    setCurrent(el.currentTime)
    if (el.duration && Number.isFinite(el.duration)) setDuration(el.duration)
    const chapters = book.audioChapters || []
    if (chapters.length) {
      let idx = 0
      for (let i = 0; i < chapters.length; i++) if (chapters[i].start <= el.currentTime + 0.5) idx = i
      if (idx !== chapterIndex) setChapterIndex(idx)
    }
    if (Math.abs(el.currentTime - lastSavedRef.current) > 5) {
      lastSavedRef.current = el.currentTime
      saveProgress(el.currentTime, chapterIndex)
    }
  }

  function seekTo(sec) {
    const el = audioRef.current
    if (!el) return
    el.currentTime = Math.max(0, Math.min(duration || sec, sec))
    setCurrent(el.currentTime)
    saveProgress(el.currentTime, chapterIndex)
  }

  function setSleep(min) {
    setSleepMin(min)
    if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current)
    if (!min) { setSleepLeft(0); return }
    setSleepLeft(min * 60)
    sleepTimerRef.current = setTimeout(() => {
      if (audioRef.current) audioRef.current.pause()
      setPlaying(false)
      setSleepLeft(0)
      setSleepMin(0)
    }, min * 60 * 1000)
  }

  function addBookmark() {
    const next = [...bookmarks, { time: Math.floor(current), label: `Bookmark ${formatTime(current)}` }]
    setBookmarks(next)
    onSave(book, { positionSec: current, chapterIndex, bookmarks: next, at: Date.now() })
  }

  const chapters = book.audioChapters || []
  return (
    <div className="card viewer">
      <button className="secondary" onClick={() => { saveProgress(current, chapterIndex); onBack() }}>← Back to book</button>
      <h2>🎧 {book.metadata.title}</h2>
      <p>{book.metadata.author || 'Unknown author'}</p>
      <audio ref={audioRef} src={url} preload="metadata"
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={(e) => { if (Number.isFinite(e.target.duration)) setDuration(e.target.duration) }}
        onPlay={() => setPlaying(true)}
        onPause={() => { setPlaying(false); saveProgress(audioRef.current ? audioRef.current.currentTime : current, chapterIndex) }}
        onEnded={() => setPlaying(false)}
      />
      <div className="audio-controls">
        <input type="range" min="0" max={duration || 0} step="1" value={Math.min(current, duration || 0)} onChange={(e) => seekTo(Number(e.target.value))} />
        <div className="toolbar">
          <span>{formatTime(current)} / {formatTime(duration)}</span>
          <button className="secondary" onClick={() => seekTo(current - 15)}>−15s</button>
          <button className="secondary" onClick={() => seekTo(current - 30)}>−30s</button>
          <button onClick={() => { const el = audioRef.current; if (!el) return; if (el.paused) el.play(); else el.pause() }}>{playing ? '⏸ Pause' : '▶ Play'}</button>
          <button className="secondary" onClick={() => seekTo(current + 15)}>+15s</button>
          <button className="secondary" onClick={() => seekTo(current + 30)}>+30s</button>
          <label>Speed
            <select value={speed} onChange={(e) => { const s = Number(e.target.value); setSpeed(s); if (audioRef.current) audioRef.current.playbackRate = s }}>
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
  const audioRef = useRef(null)
  const [epubChapters, setEpubChapters] = useState([])
  const [epubIndex, setEpubIndex] = useState(0)
  const [current, setCurrent] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [url, setUrl] = useState('')
  const [fontSize, setFontSize] = useState(18)
  const syncingFromAudioRef = useRef(false)

  const audioChapters = (audioBook && audioBook.audioChapters) || []
  const mapping = useMemo(() => mapChapters(epubChapters, audioChapters), [epubChapters, audioChapters])

  useEffect(() => {
    if (!epubBook) return
    parseChapters(epubBook.file).then((ch) => {
      setEpubChapters(ch)
      const saved = epubBook.progress
      if (saved && saved.chapterIndex < ch.length) setEpubIndex(saved.chapterIndex)
    }).catch(() => {})
  }, [epubBook && epubBook.id])

  useEffect(() => {
    if (!audioBook) return
    const type = audioBook.fileName && /\.mp3$/i.test(audioBook.fileName) ? 'audio/mpeg' : 'audio/mp4'
    const u = URL.createObjectURL(new Blob([audioBook.file], { type }))
    setUrl(u)
    const saved = audioBook.progress
    if (saved && saved.positionSec) setCurrent(saved.positionSec)
    return () => URL.revokeObjectURL(u)
  }, [audioBook && audioBook.id])

  useEffect(() => {
    const el = audioRef.current
    if (el && url && current) el.currentTime = current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  function goToEpubChapter(index, seekAudio = true) {
    setEpubIndex(index)
    if (epubBook) onSave(epubBook, { chapterIndex: index, at: Date.now() })
    if (seekAudio && audioBook && audioChapters.length) {
      const audioIdx = mapping[index]
      if (audioIdx >= 0 && audioRef.current) {
        audioRef.current.currentTime = audioChapters[audioIdx].start
        setCurrent(audioChapters[audioIdx].start)
      }
    }
  }

  function onAudioTime() {
    const el = audioRef.current
    if (!el) return
    setCurrent(el.currentTime)
    if (!audioChapters.length || !epubChapters.length) return
    const aIdx = audioChapterAtTime(audioChapters, el.currentTime)
    // Reverse mapping: first EPUB chapter mapped to this audio chapter.
    let eIdx = mapping.indexOf(aIdx)
    if (eIdx < 0) eIdx = Math.min(aIdx, epubChapters.length - 1)
    if (eIdx !== epubIndex && !syncingFromAudioRef.current) {
      syncingFromAudioRef.current = true
      setEpubIndex(eIdx)
      if (epubBook) onSave(epubBook, { chapterIndex: eIdx, at: Date.now() })
      setTimeout(() => { syncingFromAudioRef.current = false }, 200)
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
      <audio ref={audioRef} src={url} preload="metadata" controls
        onTimeUpdate={onAudioTime}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <p className="progress">{formatTime(current)} · Audio chapter: {audioChapters.length ? (audioChapters[audioChapterAtTime(audioChapters, current)]?.title || '—') : 'No embedded chapters — sync follows EPUB chapter order only when you change chapters'} · EPUB chapter {epubChapters.length ? epubIndex + 1 : '…'} of {epubChapters.length}</p>
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
