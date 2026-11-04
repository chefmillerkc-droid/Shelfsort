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

export function formatOfFileName(name) {
  if (/\.epub$/i.test(name)) return 'epub'
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (/\.cbz$/i.test(name)) return 'comic'
  if (/\.cbr$/i.test(name)) return 'comic'
  if (/\.m4b$/i.test(name) || /\.mp3$/i.test(name)) return 'audio'
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
  return /\.(epub|pdf|cbz|cbr|m4b|mp3)$/i.test(file.name)
}
