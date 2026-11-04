// Catalog export that actually produces a file on Android.
//
// WHY THIS EXISTS: the old export used downloadBlob() — an anchor
// <a download> with a blob URL. Android's in-app WebView silently
// swallows that, so tapping Export said "Exported N books" while NO
// file ever appeared in Files/Downloads (confirmed by the user,
// 2026-11-04). That path is kept only for web, where it works.
//
// NATIVE PATH (the fix): write the JSON to Capacitor's Cache
// directory first, then open the native share sheet with that file.
// Cache is the directory Capacitor's FileProvider shares by default
// on Android, so no android/ or workflow change is needed to share
// from it — and the workflow regenerates android/ fresh every run
// anyway, so a FileProvider edit would not survive. The user picks
// a destination in the share sheet (Files, Drive, Muse, …) and that
// destination is where the file actually lands.
//
// FALLBACK, stated honestly: if the share sheet is unavailable or
// fails, the file is written to the Documents directory instead and
// the caller is told the exact filename to look for. If BOTH writes
// fail, the caller is told plainly that NO file was created, with
// the reason — never "Exported N books" for a file that does not
// exist. A dismissed share sheet is NOT a failure: the Cache file
// was created, the user just did not pick a destination, so the
// caller should say so and invite another Export tap.
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { downloadBlob } from './exportEpub.js'

export const CATALOG_FILE_NAME = 'shelfsort-catalog.json'

function textToBase64Chunks(text, chunkBytes) {
  const bytes = new TextEncoder().encode(text)
  const chunks = []
  for (let off = 0; off < bytes.length; off += chunkBytes) {
    const slice = bytes.subarray(off, off + chunkBytes)
    let out = ''
    for (let i = 0; i < slice.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000))
    }
    chunks.push(btoa(out))
  }
  return chunks
}

async function writeJsonFile(path, directory, jsonText) {
  const CHUNK = 3 * 256 * 1024 // multiple of 3, so no base64 padding issues
  const chunks = textToBase64Chunks(jsonText, CHUNK)
  if (!chunks.length) chunks.push(btoa(''))
  await Filesystem.writeFile({ path, data: chunks[0], directory, recursive: true })
  for (let i = 1; i < chunks.length; i++) {
    await Filesystem.appendFile({ path, data: chunks[i], directory })
  }
  const uri = await Filesystem.getUri({ path, directory })
  return uri && uri.uri ? uri.uri : null
}

function isShareCanceled(e) {
  return /cancel/i.test(e && e.message ? String(e.message) : '')
}

// Returns { ok, method, detail } where method is one of:
// 'share' (native share sheet opened and completed), 'share-canceled'
// (Cache file exists, user dismissed the sheet), 'documents'
// (share unavailable/failed, file written to Documents), 'browser'
// (web anchor download), 'error' (no file was created).
export async function exportCatalogFile(jsonText) {
  if (!Capacitor.isNativePlatform()) {
    downloadBlob(new Blob([jsonText], { type: 'application/json' }), CATALOG_FILE_NAME)
    return { ok: true, method: 'browser', detail: `Downloaded ${CATALOG_FILE_NAME} via the browser.` }
  }
  // Native: Cache first, because that is what the share sheet can read.
  try {
    const cacheUri = await writeJsonFile(CATALOG_FILE_NAME, Directory.Cache, jsonText)
    if (!cacheUri) throw new Error('Could not write the catalog to the app cache.')
    try {
      await Share.share({
        title: 'ShelfSort catalog',
        dialogTitle: `Share ${CATALOG_FILE_NAME}`,
        files: [cacheUri],
      })
      return { ok: true, method: 'share', detail: `Shared ${CATALOG_FILE_NAME} via the system share sheet — pick a destination (Files, Drive, Muse, …) to save or send it.` }
    } catch (shareErr) {
      if (isShareCanceled(shareErr)) {
        return { ok: true, method: 'share-canceled', detail: `${CATALOG_FILE_NAME} was written to the app cache, but the share sheet was dismissed before a destination was picked — tap Export again to share it.` }
      }
      throw shareErr
    }
  } catch (e) {
    // Share unavailable or failed, or the Cache write failed: try
    // Documents as a last resort, and say exactly where it went.
    try {
      await writeJsonFile(CATALOG_FILE_NAME, Directory.Documents, jsonText)
      return { ok: true, method: 'documents', detail: `The share sheet was not available, so ${CATALOG_FILE_NAME} was saved to the app's Documents folder instead — look for ${CATALOG_FILE_NAME} in Files.` }
    } catch (docErr) {
      const reason = (e && e.message) || (docErr && docErr.message) || 'unknown error'
      return { ok: false, method: 'error', detail: `No catalog file was created: ${reason}. Nothing was exported — try Export again.` }
    }
  }
}
