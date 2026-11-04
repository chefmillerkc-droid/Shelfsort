// Native audio for ShelfSort — capacitor-plugin-playlist (v8) on native
// platforms, plain HTML <audio> on web or whenever the native plugin
// is unavailable / fails. Never leaves the user with no player.
//
// What the native path gives (Android, via the plugin's MediaSession
// service + ExoPlayer / media3):
//   - Playback that keeps going when the app is backgrounded or the
//     screen locks, with lock-screen / notification play-pause controls.
//   - No custom notification is built here: the plugin's MediaService
//     provides the MediaStyle notification. Its AndroidManifest (merged
//     automatically by `cap sync`) already includes WAKE_LOCK,
//     FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK and the
//     MediaService. Do NOT edit AndroidManifest by hand — android/ is
//     generated on the GitHub runner, not stored in this repo.
//
// What stays custom in ShelfSort (not the plugin's job):
//   - The whole player UI, chapter list, bookmarks, sleep timer,
//     playback speed, and progress saving (see AudioPlayer in App.jsx).
//
// Filesystem cache note:
//   The plugin can only play a real file URI, not an IndexedDB blob,
//   so the audio book's bytes are copied to Capacitor's Cache
//   directory (stable filename per book id). The copy is reused on
//   later opens when its size matches the library file, so a large M4B
//   is NOT recopied every time. Clearing the app cache does NOT delete
//   the library file in IndexedDB — the cache copy is simply rebuilt
//   on the next open.
//
// Android 13+ POST_NOTIFICATIONS — known limitation, not faked:
//   The plugin does NOT merge POST_NOTIFICATIONS, and this codebase
//   has no permissions plugin (adding one just for this would be a
//   new native dependency for a single permission). No runtime request
//   is attempted here. If the notification does not appear on a device,
//   the user must allow notifications for ShelfSort in system settings
//   (Settings > Apps > ShelfSort > Notifications). Playback itself is
//   unaffected; only the notification/lock-screen controls depend on it.
//
// Status message numbers (RmxAudioStatusMessage, from the plugin):
//   30 = PLAYING, 35 = PAUSE, 40 = PLAYBACK_POSITION,
//   50 = COMPLETED, 55 = DURATION, 5 = ERROR, 11 = CANPLAY.
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'

const MSG_PLAYING = 30
const MSG_PAUSE = 35
const MSG_POSITION = 40
const MSG_COMPLETED = 50
const MSG_DURATION = 55
const MSG_ERROR = 5
const MSG_CANPLAY = 11

function extFor(fileName) {
  return /\.mp3$/i.test(fileName || '') ? 'mp3' : 'm4b'
}

function mimeFor(fileName) {
  return /\.mp3$/i.test(fileName || '') ? 'audio/mpeg' : 'audio/mp4'
}

// Chunked ArrayBuffer -> base64. Chunk byte length is a multiple of 3
// so each chunk's base64 has no padding, which is what makes the
// writeFile + appendFile chunked copy below safe.
function chunkToBase64(buf, byteOffset, byteLength) {
  const bytes = new Uint8Array(buf, byteOffset, byteLength)
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(out)
}

async function ensureCacheFile(book, fileBuf) {
  const ext = extFor(book.fileName)
  const fileName = `audio-${String(book.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`
  const path = `shelfsort-audio/${fileName}`
  try {
    const st = await Filesystem.stat({ path, directory: Directory.Cache })
    if (st && st.size === fileBuf.byteLength) {
      const uri = await Filesystem.getUri({ path, directory: Directory.Cache })
      return uri.uri
    }
  } catch { /* no cached copy yet, or stat unsupported — write it */ }
  const CHUNK = 3 * 256 * 1024 // 786432 bytes, multiple of 3
  let first = true
  for (let off = 0; off < fileBuf.byteLength; off += CHUNK) {
    const len = Math.min(CHUNK, fileBuf.byteLength - off)
    const b64 = chunkToBase64(fileBuf, off, len)
    if (first) {
      await Filesystem.writeFile({ path, data: b64, directory: Directory.Cache, recursive: true })
      first = false
    } else {
      await Filesystem.appendFile({ path, data: b64, directory: Directory.Cache })
    }
  }
  const uri = await Filesystem.getUri({ path, directory: Directory.Cache })
  return uri.uri
}

async function ensureCoverUri(book) {
  const cover = book.metadata && book.metadata.coverDataUrl
  if (!cover) return undefined
  if (/^https?:\/\//i.test(cover)) return cover
  // data: URL artwork is not usable as MediaSession art on Android,
  // so write it to the cache and hand the plugin a file URI instead.
  try {
    const m = /^data:image\/([a-z]+);base64,(.+)$/i.exec(cover)
    if (!m) return undefined
    const path = `shelfsort-audio/${String(book.id).replace(/[^a-zA-Z0-9_-]/g, '_')}-cover.${m[1] === 'png' ? 'png' : 'jpg'}`
    await Filesystem.writeFile({ path, data: m[2], directory: Directory.Cache, recursive: true })
    const uri = await Filesystem.getUri({ path, directory: Directory.Cache })
    return uri.uri
  } catch { return undefined }
}

// Build an HTML <audio> controller with the same surface as the native
// one, so AudioPlayer / ReadAlongView never care which backend won.
function createHtmlController({ fileBuf, fileName, startPosition, cbs }) {
  const type = mimeFor(fileName)
  const url = URL.createObjectURL(new Blob([fileBuf], { type }))
  const el = new Audio()
  el.src = url
  el.preload = 'metadata'
  let destroyed = false
  const state = { position: startPosition || 0, duration: 0, playing: false }
  el.addEventListener('timeupdate', () => {
    state.position = el.currentTime
    if (Number.isFinite(el.duration)) state.duration = el.duration
    cbs.onPosition && cbs.onPosition(state.position, state.duration)
  })
  el.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(el.duration)) state.duration = el.duration
    cbs.onPosition && cbs.onPosition(state.position, state.duration)
  })
  el.addEventListener('play', () => { state.playing = true; cbs.onPlaying && cbs.onPlaying(true) })
  el.addEventListener('pause', () => { state.playing = false; cbs.onPlaying && cbs.onPlaying(false) })
  el.addEventListener('ended', () => { state.playing = false; cbs.onPlaying && cbs.onPlaying(false); cbs.onEnded && cbs.onEnded() })
  if (startPosition) {
    // Seek once metadata is known; setting currentTime earlier is
    // ignored by most browsers for a fresh blob URL.
    const seekOnce = () => { el.currentTime = startPosition; el.removeEventListener('loadedmetadata', seekOnce) }
    el.addEventListener('loadedmetadata', seekOnce)
  }
  return {
    mode: 'html',
    async play() { if (!destroyed) await el.play().catch(() => {}) },
    async pause() { el.pause() },
    async seekTo(sec) { el.currentTime = Math.max(0, sec); state.position = el.currentTime },
    async setRate(rate) { el.playbackRate = rate },
    getPosition() { return state.position },
    getDuration() { return state.duration },
    isPlaying() { return state.playing },
    destroy() {
      destroyed = true
      el.pause()
      el.removeAttribute('src')
      URL.revokeObjectURL(url)
    },
  }
}

async function createNativeController({ book, fileBuf, startPosition, cbs, pauseOnDestroy }) {
  const { Playlist } = await import('capacitor-plugin-playlist')
  let handle = null
  let destroyed = false
  let pendingSeek = startPosition || 0
  let seekApplied = !pendingSeek
  const state = { position: startPosition || 0, duration: 0, playing: false }

  const assetUrl = await ensureCacheFile(book, fileBuf)
  const albumArt = await ensureCoverUri(book)

  await Playlist.setOptions({ verbose: false })
  await Playlist.initialize()
  handle = await Playlist.addListener('status', (data) => {
    if (destroyed) return
    const status = (data && data.status) || {}
    const msg = status.msgType
    const value = status.value || {}
    if (typeof value.currentPosition === 'number') state.position = value.currentPosition
    if (typeof value.duration === 'number' && value.duration > 0) state.duration = value.duration
    if (msg === MSG_PLAYING) { state.playing = true; cbs.onPlaying && cbs.onPlaying(true) }
    else if (msg === MSG_PAUSE) { state.playing = false; cbs.onPlaying && cbs.onPlaying(false) }
    else if (msg === MSG_POSITION || msg === MSG_DURATION) {
      cbs.onPosition && cbs.onPosition(state.position, state.duration)
    } else if (msg === MSG_COMPLETED) {
      state.playing = false; cbs.onPlaying && cbs.onPlaying(false); cbs.onEnded && cbs.onEnded()
    } else if (msg === MSG_ERROR) {
      cbs.onError && cbs.onError(value)
    }
    if (msg === MSG_CANPLAY && !seekApplied && pendingSeek > 0) {
      seekApplied = true
      Playlist.seekTo({ position: pendingSeek }).catch(() => {})
    }
  })

  await Playlist.setPlaylistItems({
    items: [{
      trackId: String(book.id),
      assetUrl,
      title: book.metadata.title || book.fileName || 'Audiobook',
      artist: book.metadata.author || 'Unknown author',
      album: book.metadata.series || 'ShelfSort',
      albumArt,
      isStream: false,
      startPosition: startPosition || 0,
    }],
    options: { startPaused: true },
  })
  // Belt-and-braces seek: startPosition on the track is a resume hint,
  // not a guarantee, so seek explicitly too (CANPLAY handler retries
  // it once the player is ready).
  if (startPosition > 0) {
    try { await Playlist.seekTo({ position: startPosition }); seekApplied = true } catch { /* CANPLAY retry covers it */ }
  }

  return {
    mode: 'native',
    async play() { if (!destroyed) await Playlist.play() },
    async pause() { if (!destroyed) await Playlist.pause() },
    async seekTo(sec) {
      state.position = Math.max(0, sec)
      if (!destroyed) await Playlist.seekTo({ position: state.position })
      cbs.onPosition && cbs.onPosition(state.position, state.duration)
    },
    async setRate(rate) { if (!destroyed) await Playlist.setPlaybackRate({ rate }) },
    getPosition() { return state.position },
    getDuration() { return state.duration },
    isPlaying() { return state.playing },
    async destroy() {
      destroyed = true
      try { if (handle) await handle.remove() } catch { /* ignore */ }
      // Leaving the player screen must NOT stop background playback:
      // the foreground MediaService keeps playing until the user
      // pauses (in-app or from the notification) or another book
      // replaces the playlist. Callers that want stop-on-leave
      // (read-along) pass pauseOnDestroy: true.
      if (pauseOnDestroy) { try { await Playlist.pause() } catch { /* ignore */ } }
    },
  }
}

// One entry point for both players. `pauseOnDestroy` is false for the
// standalone player (background playback is the point) and true for
// read-along (leaving the read-along screen should stop the audio,
// matching the old HTML behaviour there).
export async function createAudioController(opts) {
  const { book, fileBuf, startPosition = 0 } = opts
  if (!book || !fileBuf) throw new Error('No audio file to play.')
  if (Capacitor.isNativePlatform()) {
    try {
      return await createNativeController(opts)
    } catch (e) {
      // Native failed (plugin missing, cache write failed, ExoPlayer
      // rejected the file, …) — fall back to HTML rather than silence.
      // The caller may surface opts.cbs.onError / the returned mode.
      try {
        const html = createHtmlController({ fileBuf, fileName: book.fileName, startPosition, cbs: opts.cbs || {} })
        html.fallbackFromNative = true
        html.fallbackError = e
        return html
      } catch { throw e }
    }
  }
  return createHtmlController({ fileBuf, fileName: book.fileName, startPosition, cbs: opts.cbs || {} })
}
