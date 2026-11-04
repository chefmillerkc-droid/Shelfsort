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
  const ext = /\.mp3$/i.test(fileName || '') ? 'mp3' : 'm4b'
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

// Returns the file URI to store on the book record, or null if the
// file could not / should not be stored this way (web, or a write
// failure — the caller then falls back to the IndexedDB blob).
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
