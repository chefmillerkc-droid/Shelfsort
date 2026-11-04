// Cloudflare R2 client, via the S3-compatible API.
// R2 is S3-compatible, so the AWS SDK v3 works against it with:
//   endpoint: https://<accountId>.r2.cloudflarestorage.com
//   region:   "auto" (R2's documented value)
// Credentials are supplied at runtime from the app's own Settings screen
// and stored ONLY in this browser (localStorage, key below). They are
// never hard-coded, never logged, and never sent anywhere except to the
// configured R2 endpoint. The user enters them in the app itself, never
// in chat, and they must never be committed to the repo.
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'

export const R2_SETTINGS_KEY = 'shelfsort-r2'
export const R2_PREFIX = 'shelfsort'

export function loadR2Settings() {
  try {
    const raw = localStorage.getItem(R2_SETTINGS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed.accountId || !parsed.bucket || !parsed.accessKeyId || !parsed.secretAccessKey) return null
    return parsed
  } catch {
    return null
  }
}

export function saveR2Settings(settings) {
  try {
    localStorage.setItem(R2_SETTINGS_KEY, JSON.stringify(settings))
  } catch { /* storage is best-effort */ }
}

export function clearR2Settings() {
  try { localStorage.removeItem(R2_SETTINGS_KEY) } catch { /* ignore */ }
}

export function r2Endpoint(settings) {
  if (settings.endpoint && settings.endpoint.trim()) return settings.endpoint.trim().replace(/\/$/, '')
  return `https://${settings.accountId}.r2.cloudflarestorage.com`
}

export function makeR2Client(settings) {
  if (!settings) throw new Error('R2 is not configured yet. Open Cloud / Settings and enter your R2 details first.')
  return new S3Client({
    region: 'auto',
    endpoint: r2Endpoint(settings),
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    // R2 (like S3) uses virtual-hosted style by default in the SDK; the
    // account endpoint above is what R2 documents for S3 clients.
    forcePathStyle: false,
  })
}

// Plain-language error mapping. Browser CORS failures surface as a bare
// "Failed to fetch" with no status, so that case is called out explicitly
// instead of pretending we know the server's answer.
export function friendlyR2Error(err) {
  const msg = (err && err.message) || String(err || 'Unknown error')
  const status = err && err.$metadata && err.$metadata.httpStatusCode
  if (/failed to fetch|networkerror|network error|load failed/i.test(msg)) {
    return 'Could not reach R2 (network error). If you are in a browser, this is usually a CORS problem: check that your bucket CORS policy allows this app origin (see the CORS snippet in Cloud / Settings), or check your connection.'
  }
  if (status === 403 || /forbidden|signature|invalid access|not authorized/i.test(msg)) {
    return 'R2 rejected the credentials (403). Check the Access Key / Secret Key, and that the API token has Object Read & Write permission for this bucket only.'
  }
  if (status === 404 || /notfound|no such bucket|no such key/i.test(msg)) {
    return 'Not found (404). Check the bucket name and Account ID, and that the object / bucket actually exists.'
  }
  if (status === 400 || /bad request/i.test(msg)) {
    return `R2 returned a bad request (400): ${msg}`
  }
  return msg
}

export function sanitizeTitle(title) {
  return (title || 'book')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'book'
}

export function extFor(book) {
  const name = book.fileName || ''
  const m = name.match(/\.([a-z0-9]+)$/i)
  if (m) return m[1].toLowerCase()
  if (book.format === 'pdf') return 'pdf'
  if (book.format === 'comic') return 'cbz'
  if (book.format === 'audio') return 'm4b'
  return 'epub'
}

// Stable key so re-uploading the same book overwrites the same object
// instead of creating duplicates: shelfsort/<format>/<title>-<id>.<ext>
export function r2KeyFor(book) {
  return `${R2_PREFIX}/${book.format}/${sanitizeTitle(book.metadata && book.metadata.title)}-${book.id}.${extFor(book)}`
}

export function cloudStatus(book) {
  const hasLocal = !!book.file
  const hasCloud = !!book.r2Key
  if (hasLocal && hasCloud) return 'both'
  if (hasCloud) return 'cloud'
  return 'local'
}

export function cloudStatusLabel(book) {
  const s = cloudStatus(book)
  if (s === 'both') return '☁️ + 📱 Both'
  if (s === 'cloud') return '☁️ Cloud only'
  return '📱 Local only'
}

async function streamToArrayBuffer(body) {
  if (!body) return new ArrayBuffer(0)
  if (body instanceof ArrayBuffer) return body
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.arrayBuffer()
  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.byteLength }
    return out.buffer
  }
  // Node-style async iterable fallback.
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let total = 0
    for await (const c of body) {
      const u = c instanceof Uint8Array ? c : new Uint8Array(c)
      chunks.push(u); total += u.byteLength
    }
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.byteLength }
    return out.buffer
  }
  throw new Error('Could not read the downloaded file from R2.')
}

// Multipart upload via lib-storage for large files (M4B/CBZ). For small
// files it behaves like a single PutObject. Progress is reported as
// loaded/total when the SDK provides it; otherwise it is indeterminate.
export async function uploadToR2(settings, book, onProgress) {
  if (!book.file) throw new Error('This book has no local file to upload. Download it from R2 first, or re-import it.')
  const client = makeR2Client(settings)
  const key = book.r2Key || r2KeyFor(book)
  const blob = new Blob([book.file])
  const upload = new Upload({
    client,
    params: { Bucket: settings.bucket, Key: key, Body: blob, ContentType: blob.type || 'application/octet-stream' },
    queueSize: 4,
    partSize: 1024 * 1024 * 5, // 5 MB parts
    leavePartsOnError: false,
  })
  if (onProgress) {
    upload.on('httpUploadProgress', (p) => {
      if (p && p.total) onProgress({ loaded: p.loaded || 0, total: p.total, pct: Math.round(((p.loaded || 0) / p.total) * 100) })
      else onProgress({ loaded: p ? p.loaded || 0 : 0, total: null, pct: null })
    })
  }
  try {
    await upload.done()
  } catch (e) {
    throw new Error(friendlyR2Error(e))
  }
  return key
}

export async function downloadFromR2(settings, key, onProgress) {
  const client = makeR2Client(settings)
  let res
  try {
    res = await client.send(new GetObjectCommand({ Bucket: settings.bucket, Key: key }))
  } catch (e) {
    throw new Error(friendlyR2Error(e))
  }
  if (onProgress && res.ContentLength) onProgress({ loaded: 0, total: res.ContentLength, pct: 0 })
  const buf = await streamToArrayBuffer(res.Body)
  if (onProgress && res.ContentLength) onProgress({ loaded: buf.byteLength, total: res.ContentLength, pct: 100 })
  return buf
}

export async function headR2Object(settings, key) {
  const client = makeR2Client(settings)
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: key }))
    return { exists: true, size: res.ContentLength || null }
  } catch (e) {
    const status = e && e.$metadata && e.$metadata.httpStatusCode
    if (status === 404 || /notfound|no such key/i.test(e.message || '')) return { exists: false, size: null }
    throw new Error(friendlyR2Error(e))
  }
}

export async function deleteFromR2(settings, key) {
  const client = makeR2Client(settings)
  try {
    await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: key }))
  } catch (e) {
    throw new Error(friendlyR2Error(e))
  }
}

export async function listR2Objects(settings, maxKeys = 1000) {
  const client = makeR2Client(settings)
  try {
    const res = await client.send(new ListObjectsV2Command({ Bucket: settings.bucket, Prefix: `${R2_PREFIX}/`, MaxKeys: maxKeys }))
    return (res.Contents || []).map((o) => ({ key: o.Key, size: o.Size || null, lastModified: o.LastModified || null }))
  } catch (e) {
    throw new Error(friendlyR2Error(e))
  }
}

export async function testR2Connection(settings) {
  const client = makeR2Client(settings)
  try {
    await client.send(new ListObjectsV2Command({ Bucket: settings.bucket, Prefix: `${R2_PREFIX}/`, MaxKeys: 1 }))
    return true
  } catch (e) {
    throw new Error(friendlyR2Error(e))
  }
}

// Parse an id back out of a key we created, for Sync from Cloud.
export function idFromR2Key(key) {
  const m = key.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9]+)$/i)
  return m ? m[1] : null
}

export function titleFromR2Key(key) {
  const base = key.split('/').pop().replace(/\.[a-z0-9]+$/i, '')
  const withoutId = base.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '')
  return withoutId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Unknown book'
}

export const R2_CORS_JSON = JSON.stringify([
  {
    AllowedOrigins: ['http://localhost:5173', 'http://localhost:4173'],
    AllowedMethods: ['GET', 'PUT', 'DELETE', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3600,
  },
], null, 2)
