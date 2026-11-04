// Watched library folders.
//
// HONEST ANDROID LIMIT, stated here and in the UI: a folder picked
// through an <input type="file"> in a WebView cannot be kept open
// across sessions. The WebView gives the app File objects for that
// pick only; it does not persist a file handle or folder permission
// the app could silently re-open on the next start. So a "watched
// folder" here is only a saved NAME/PATH (localStorage), plus the
// count found on the last scan. Every rescan re-opens the system
// file picker and the user re-picks the folder(s) to grant access
// again. True persistent folder access would need a native Storage
// Access Framework plugin — a separate follow-up, not this change.
// Nothing in this file claims automatic background scanning.

// First path segment of a file picked with webkitdirectory, e.g.
// "My Books/series/book.epub" -> "My Books". Null when the picker
// did not return a relative path (i.e. it fell back to plain files).
export function folderNameOfFile(file) {
  const rel = file && file.webkitRelativePath
  if (!rel || !rel.includes('/')) return null
  const name = rel.split('/')[0].trim()
  return name ? name : null
}

export function folderNameOfFiles(files) {
  for (const f of files) {
    const name = folderNameOfFile(f)
    if (name) return name
  }
  return null
}

// Group picked files by their top-level folder name. Files with no
// relative path go under the null key.
export function groupFilesByFolder(files) {
  const groups = new Map()
  for (const f of files) {
    const key = folderNameOfFile(f)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }
  return groups
}

// Directory of a picked file, for multi-part grouping: the full
// relative directory ("Audiobooks/Scott Lynch/The Lies of Locke
// Lamora") for a webkitdirectory pick, the SAF relative path's
// directory for a lazy SAF file (its .dir), or '' for a flat pick.
// The LAST segment is the book folder; the one before it is the
// author folder (see src/lib/multipart.js).
export function dirOfFile(file) {
  if (!file) return ''
  if (file.dir) return file.dir
  const rel = file.webkitRelativePath
  if (rel && rel.includes('/')) return rel.slice(0, rel.lastIndexOf('/'))
  return ''
}

export function formatOfFileName(name) {
  if (/\.epub$/i.test(name)) return 'epub'
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (/\.cbz$/i.test(name) || /\.cbr$/i.test(name) || /\.cbt$/i.test(name) || /\.cb7$/i.test(name)) return 'comic'
  if (/\.m4b$/i.test(name) || /\.m4a$/i.test(name) || /\.mp4$/i.test(name) || /\.mp3$/i.test(name)) return 'audio'
  return null
}

// Files from a rescan that are NOT already in the library, matched
// by fileName + format. NOTE: importFiles itself does NOT dedupe —
// every import creates a new book — so rescan does its own dedupe
// here instead of relying on importFiles.
export function newFilesForRescan(files, existingBooks) {
  const seen = new Set((existingBooks || []).map((b) => `${b.fileName}::${b.format}`))
  return files.filter((f) => {
    const format = formatOfFileName(f.name)
    return format && !seen.has(`${f.name}::${format}`)
  })
}

export function isSupportedBookFile(file) {
  return /\.(epub|pdf|cbz|cbr|cbt|cb7|m4b|m4a|mp4|mp3)$/i.test(file.name)
}

// Folder-cover candidates, in priority order (v0.7.4): a book folder
// from Smart Audiobook Player carries EmbeddedCover.jpg next to the
// audio file. Matching is case-insensitive on the basename; the
// first candidate found in a folder wins. These are kilobytes, so
// reading one whole is fine — unlike the audio file itself.
export const FOLDER_COVER_NAMES = ['embeddedcover.jpg', 'cover.jpg', 'cover.png', 'folder.jpg']
export function folderCoverRank(name) {
  return FOLDER_COVER_NAMES.indexOf(String(name || '').toLowerCase())
}

// ---- Native SAF (Storage Access Framework) folders (v0.7.2) --------
// A SAF folder is picked once with the system folder picker and its
// tree URI is kept (persistable URI permission), so unlike a WebView
// <input> pick it CAN be re-listed on a later start with no re-pick.
// These helpers are plugin-free: the caller supplies listDir, which
// resolves a path (null = the folder root) to entries shaped
// { name, type } (type 'directory'/'file') or { name, isDir } — the
// scoped-storage plugin returns `type`, so both are accepted.
// Listing covers the folder tree RECURSIVELY, to a max depth of 6
// below the picked root, skipping hidden folders (names starting
// with '.'). The old root + 1 level walk could not see the user's
// real structure — root -> author folder -> book folder -> files —
// so a watched audiobook root found nothing at all. Each result is
// { name, path, dir }: path is the full relative path from the
// picked root, dir is path minus the filename ('' for root files),
// which is exactly the book-folder key multi-part grouping uses.
// Author folders themselves are never returned as books — only
// files are, and grouping happens on dir at import time.
// A directory that fails to list (permission revoked mid-walk,
// folder moved) is skipped, not fatal: the caller reports a
// revoked/moved folder by name when the whole scan finds nothing
// new, and other folders still scan.
export async function listSafBookFiles(listDir) {
  const found = []
  async function walk(relDir, depth) {
    if (depth > 6) return
    let entries = []
    try { entries = await listDir(relDir || null) } catch { return }
    for (const entry of entries || []) {
      const name = entry.name
      if (!name) continue
      const isDir = entry.type === 'directory' || entry.isDir === true
      const path = relDir ? `${relDir}/${name}` : name
      if (isDir) {
        if (name.startsWith('.')) continue
        await walk(path, depth + 1)
      } else if (isSupportedBookFile(entry)) {
        // size passes through when the plugin reports it (readdir
        // entries carry size) — the SAF audio path uses it to decide
        // whether a file is safe to byte-parse (<= 50 MB) or must be
        // played in place with folder-derived metadata instead.
        found.push({ name, path, dir: relDir || '', size: typeof entry.size === 'number' ? entry.size : null })
      }
    }
  }
  await walk('', 0)
  return found
}

// A file-like object importFiles() can consume: it only needs
// `.name` and `.arrayBuffer()`. The bytes are fetched lazily, one
// file at a time, so a whole folder is never held in memory at once.
// `dir` is the SAF relative directory (book folder) when known, so
// multi-part grouping can use it exactly like webkitRelativePath.
export function lazySafFile(name, readBytes, dir = '') {
  return {
    name,
    dir,
    // Marker so the audio import path can refuse to whole-read this
    // file: SAF audio is imported in place (see importSafAudio),
    // never by reading it through this lazy reader.
    safRef: true,
    async arrayBuffer() { return readBytes() },
  }
}

// Chunked base64 -> ArrayBuffer (no giant atob() call that can blow
// the stack on a multi-megabyte book file).
export function base64ToArrayBuffer(b64) {
  const chunk = 32768
  const bytes = new Uint8Array(Math.floor((b64.length * 3) / 4))
  let out = 0
  for (let i = 0; i < b64.length; i += chunk) {
    const bin = atob(b64.slice(i, i + chunk))
    for (let j = 0; j < bin.length; j++) bytes[out++] = bin.charCodeAt(j)
  }
  return bytes.slice(0, out).buffer
}
