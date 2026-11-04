// Audio file store — import-time storage for native playback.
//
// WHY THIS EXISTS: the native Playlist/ExoPlayer plugin can only play
// a real file URI, never an IndexedDB blob URL. The old design copied
// the whole M4B out of IndexedDB into the Cache directory AT PLAY TIME
// (chunked base64 conversion of a hundreds-of-MB file, on every first
// open) — that was the "hit play, wait, maybe it plays" step.
//
// NEW DESIGN: the file is written ONCE, AT IMPORT TIME, to Capacitor's
// persistent Data directory (not Cache — Android may clear Cache, but
// Data survives until the app is uninstalled). Playback then passes
// the already-existing file URI straight to the plugin: no copy, no
// conversion, no loading step at play time. Hit play, ExoPlayer plays.
//
// Consequences, stated plainly:
//   - Audio books are NOT stored as blobs in IndexedDB books-files, so
//     there is no double storage for audio.
//   - Deleting/uninstalling the app deletes these files with it. A
//     fresh install must re-import audiobooks. The user accepts this.
//   - On web (no native Filesystem), this returns null and import
//     falls back to the IndexedDB blob + HTML player path.
//
// API note (checked against the installed @capacitor/filesystem):
// the web implementation accepts a Blob for writeFile, but the native
// bridge expects base64 — so on native we use the proven chunked
// base64 append (chunk length a multiple of 3, so no padding issues),
// exactly as the old cache copy did, just moved to import time.
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'

export function audioStorePath(bookId, fileName) {
  // Preserve the TRUE extension: ExoPlayer and the HTML player both
  // sniff content, but a stored .m4a must not silently become .m4b
  // (and .mp4 must stay .mp4) — the playback URI should describe
  // the file that was actually imported.
  const m = String(fileName || '').match(/\.(mp3|m4a|mp4|m4b)$/i)
  const ext = m ? m[1].toLowerCase() : 'm4b'
  const safeId = String(bookId).replace(/[^a-zA-Z0-9_-]/g, '_')
  return `shelfsort-audio/audio-${safeId}.${ext}`
}

function chunkToBase64(buf, byteOffset, byteLength) {
  const bytes = new Uint8Array(buf, byteOffset, byteLength)
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(out)
}

// v0.7.4 — STREAMING store (the large-audiobook fix). The old
// storeAudioFile below takes a whole buffer, and import used to call
// file.arrayBuffer() TWICE for every audio file (once to parse, once
// to store). A 629 MB audiobook therefore became an ~840 MB base64
// string plus a 629 MB buffer, twice over — that is the incomplete
// import / crash mechanism. This function NEVER holds the whole file:
// it slices the File/Blob into 3 MiB chunks (a multiple of 3, so each
// chunk's base64 has no padding and chunks concatenate cleanly),
// base64-encodes one chunk at a time, and appends it to the Data
// store, releasing the chunk before reading the next. Peak memory is
// roughly one chunk plus its base64 (~7 MB), not the file size.
// On any write failure the partial file is deleted and the error is
// THROWN (not swallowed to null) — the caller must delete the book
// meta too, so a failed import leaves no unplayable ghost book and
// no half-file on disk. Callers must not fall back to an IndexedDB
// blob for a large audio file after this fails (see importFiles).
export async function storeAudioFileStream(bookId, fileName, file) {
  if (!Capacitor.isNativePlatform()) return null
  if (!file || typeof file.slice !== 'function' || typeof file.size !== 'number') {
    throw new Error('Audio file cannot be streamed (no slice support)')
  }
  const path = audioStorePath(bookId, fileName)
  const CHUNK = 3 * 1024 * 1024 // 3 MiB, multiple of 3
  try {
    let first = true
    for (let off = 0; off < file.size; off += CHUNK) {
      const chunkBuf = await file.slice(off, Math.min(file.size, off + CHUNK)).arrayBuffer()
      const b64 = chunkToBase64(chunkBuf, 0, chunkBuf.byteLength)
      if (first) {
        await Filesystem.writeFile({ path, data: b64, directory: Directory.Data, recursive: true })
        first = false
      } else {
        await Filesystem.appendFile({ path, data: b64, directory: Directory.Data })
      }
    }
    if (file.size === 0) throw new Error('Audio file is empty')
    const uri = await Filesystem.getUri({ path, directory: Directory.Data })
    if (!uri || !uri.uri) throw new Error('Stored audio file has no URI')
    return uri.uri
  } catch (e) {
    try { await Filesystem.deleteFile({ path, directory: Directory.Data }) } catch { /* already gone */ }
    throw e
  }
}

// Delete a stored audio file, ignoring "not there" errors. Used by
// import cleanup and by nothing else — playback never deletes.
export async function deleteStoredAudio(bookId, fileName) {
  try { await Filesystem.deleteFile({ path: audioStorePath(bookId, fileName), directory: Directory.Data }) } catch { /* ignore */ }
}

// Returns the file URI to store on the book record, or null if the
// file could not / should not be stored this way (web, or a write
// failure — the caller then falls back to the IndexedDB blob).
// Kept for small files only; audio import uses storeAudioFileStream.
export async function storeAudioFile(bookId, fileName, buf) {
  if (!Capacitor.isNativePlatform()) return null
  if (!buf || !buf.byteLength) return null
  const path = audioStorePath(bookId, fileName)
  try {
    const CHUNK = 3 * 256 * 1024 // 786432 bytes, multiple of 3
    let first = true
    for (let off = 0; off < buf.byteLength; off += CHUNK) {
      const len = Math.min(CHUNK, buf.byteLength - off)
      const b64 = chunkToBase64(buf, off, len)
      if (first) {
        await Filesystem.writeFile({ path, data: b64, directory: Directory.Data, recursive: true })
        first = false
      } else {
        await Filesystem.appendFile({ path, data: b64, directory: Directory.Data })
      }
    }
    const uri = await Filesystem.getUri({ path, directory: Directory.Data })
    return uri && uri.uri ? uri.uri : null
  } catch {
    return null
  }
}
