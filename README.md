# ShelfSort

ShelfSort is a **personal, self-hosted library app** — mostly just for its owner. There is **no Google Play goal** and no account, backend, or paid API. It runs as a web app (and can be wrapped with Capacitor later, purely for personal sideloading if wanted).

ShelfSort is an EPUB library app that:

1. **Scans / imports EPUBs** from your device — pick individual files, pick a folder, or drag-and-drop them.
2. **Reads each book's own metadata first** — title, author, publisher, date, description, ISBN, series, and cover, straight from the EPUB's OPF package file.
3. **Finds and fixes missing metadata and covers** — it queries Open Library first (ISBN, then title + author) and Google Books as a fallback, and shows every proposed fix on a **Fix Review** screen. Nothing is applied silently: you can apply all, apply per book, skip, or edit a value first.
4. **Sorts by series on its own** — series are read from Calibre series metadata when present, otherwise parsed from titles like “Name #2”, “Book 2 of Name”, and “Name, Book 2”. Books are grouped by series, ordered by series number (so Book 10 comes after Book 2), and gaps in owned series numbers are highlighted (you own 1 and 3, missing 2).
5. **Reads the books** — chapter navigation, chapter list, font-size control, light/dark/sepia themes, saved reading progress, and in-book text search.
6. **Exports a corrected EPUB** — download a rebuilt EPUB with the corrected metadata (and a new cover, if one was applied) written back into its OPF. Your original library file is left untouched.

No backend, no paid APIs, no account. Your library (EPUB files + metadata) is stored in your browser/app's IndexedDB, so it survives reloads.

## v2 — more formats, audiobooks, read-along, light/dark mode

- **PDF:** import `.pdf`, read it in a pdf.js viewer (page prev/next, jump to page, zoom, in-PDF text search). Title/author come from PDF metadata when present, otherwise the filename. PDFs live in the same library grid, search, and sort as EPUBs.
- **Comics — CBZ fully supported:** a CBZ is a zip of images. ShelfSort lists its images in natural page order (page 2 before page 10), renders one page at a time, with fit-width / fit-page and a thumbnail strip, and saves your page.
- **Comics — CBR honestly NOT supported yet:** CBR is a RAR archive, not a zip. The browser-usable RAR package checked for this build (`unrar-js` 0.2.3) turned out to be Node-only (fs / child-process based), and no reliable, maintained browser RAR5 unpacker was found that can be bundled without a server. So CBR files are detected, kept in the library, and shown a clear message instead of a fake reader. **Convert CBR → CBZ** (a zip of the same images) with 7-Zip, or in Calibre, then import the CBZ. Do not expect a CBR file to open in this build.
- **Audiobooks — M4B (+ MP3):** import `.m4b` / `.mp3`, play with play/pause, seek, 0.5×–2× speed, ±15s / ±30s skip, a 15/30/60-minute sleep timer, and saved playback position. Chapters are parsed from the MP4 container where a Nero `chpl` atom is present; if no chapters are embedded, the player falls back to a single track with time-based bookmarks. Audiobook progress shows in the library.
- **Read-along (EPUB + M4B):** an EPUB and an audiobook for the same book are matched automatically by normalized title + author (score ≥ 70), and you can also link them manually on a book's detail page. In read-along mode the EPUB chapter text sits alongside the audio player. **Sync is chapter-level, not word-by-word:** when the audio chapter changes, the EPUB advances to the matching chapter (by title similarity, otherwise by order); when you change EPUB chapter, the audio seeks to that chapter's start. Ordinary EPUB + M4B pairs do not contain word timing data, so word highlighting / word sync is not claimed. If a pair has no embedded audio chapters, read-along still works by EPUB-chapter changes seeking is not possible — use the audio player alone in that case.
- **Light / dark mode:** a prominent ☀️ / 🌙 toggle in the header, persisted in localStorage, respecting your system preference on first load. Library, detail, Fix Review, EPUB reader, PDF viewer, comic viewer, and audio player all respect both themes (no hard-coded white backgrounds leaking through in dark mode). The EPUB reader keeps its own light / dark / sepia option on top of that.
- **One library, format filter:** EPUB, PDF, Comic, and Audiobook all appear together, filterable by format (All / EPUB / PDF / Comic / Audiobook), searchable by title/author/series, and series grouping still works for EPUBs — and for other formats when series metadata is present or you edit it manually on the detail page.

## v3 — Cloud shelf (Cloudflare R2)

Goal: keep the catalog on your phone and the big files in a free cloud bucket, so you can clear phone space and pull a book back whenever you need it.

- **Catalog stays local.** Titles, covers, series, progress, links, and Fix Review data stay in IndexedDB on the device. Only the book *file* moves to R2.
- **Per-book status** is shown everywhere: 📱 Local only / ☁️ Cloud only / ☁️ + 📱 Both.
- **Upload:** per book (detail page or Cloud view) or **Upload All** (skips books already in R2, per-file errors do not abort the rest). Files go to a stable key like `shelfsort/epub/dune-<id>.epub`, so re-uploading overwrites the same object instead of duplicating it.
- **Clear Local:** per book or bulk. Before deleting a local copy, ShelfSort verifies the cloud copy with a HeadObject request — if R2 does not contain it, the local copy is *not* deleted. Metadata, cover thumbnail, series, and progress are kept, so the book stays in the library as Cloud only.
- **Download on demand:** opening a Cloud-only book downloads it from R2 (with progress), stores it locally again, then opens it in the normal reader / PDF viewer / comic viewer / audio player. Read-along downloads both the EPUB and the audiobook first.
- **Delete from Cloud:** explicit confirm step in the detail page. It removes the R2 object and clears the cloud link; a local copy, if any, is kept.
- **Sync from Cloud:** Cloud view lists objects under `shelfsort/` in the bucket and shows any not in the local library, with an option to add them as Cloud-only entries (title derived from the filename). Opening one downloads it; for full parsed metadata, re-importing the downloaded file locally is the reliable path, because a Cloud-only entry created from a key alone has no embedded OPF/PDF/audio metadata to parse.
- **Settings:** header → **☁️ Cloud / Settings**. Fields: Account ID, Bucket name, Access Key ID, Secret Access Key, optional custom endpoint (default `https://<accountId>.r2.cloudflarestorage.com`, region `auto`). **Credentials are stored only in this browser's localStorage** (`shelfsort-r2`, separate from book data). They are never hard-coded, never logged, never committed to the repo, and never sent anywhere except to the configured R2 endpoint. The user enters them in the app itself, never in chat. There is a **Test Connection** button (a ListObjects request, limit 1) and a **Clear Credentials** button. Until settings are saved, R2 buttons are hidden/disabled and the library works exactly as before — no R2 is required.

### Set up R2 (once, in Cloudflare)

1. Cloudflare Dashboard → **R2** → Create a bucket (e.g. `shelfsort-books`).
2. **Keep the bucket PRIVATE.** Do not enable public access or a public domain. ShelfSort authenticates with your API token; a public bucket would make your books downloadable by anyone with the link.
3. R2 → Manage API Tokens → Create API Token → **Object Read & Write**, scoped to **that bucket only**. Copy the Access Key ID and Secret Access Key into ShelfSort's Cloud / Settings.
4. **Enable CORS on the bucket** (Settings → CORS Policy), or browser requests will be blocked. Paste this, and add your own hosted app origin to `AllowedOrigins` if you deploy ShelfSort somewhere other than localhost:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173", "http://localhost:4173"],
    "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

### Free-tier reality check

Cloudflare's R2 free tier includes **10 GB of storage**. EPUBs are small (usually 1–5 MB), so a whole EPUB library fits easily. M4B audiobooks (hundreds of MB each) and CBZ comics (100 MB+) fill 10 GB much faster — this frees *phone* space, it does not make storage unlimited. Check usage in the Cloudflare dashboard, and prefer uploading EPUBs/PDFs plus the audiobooks/comics you actually want to keep in the cloud.

### Limitations (v3, honest ones)

- **Not runtime-tested against a real R2 bucket in this environment.** `npm run build` passes, and key generation / status / sync-key parsing / error mapping were unit-checked in Node, but no real bucket, token, or CORS policy was available here — test with Test Connection, then a small EPUB upload → Clear Local → open again, before trusting it with a large library.
- **CORS is mandatory for browser use.** Without the bucket CORS policy above, R2 requests fail in the browser as a bare network error; ShelfSort maps that to a plain-language CORS message, but it cannot bypass CORS.
- **No presigned public URLs.** Files are fetched with the SDK using your token in the browser, from a private bucket. That keeps them private, but it also means the app itself must hold the token while it runs — do not use ShelfSort's R2 settings on a shared/untrusted device.
- **Multipart upload:** large files use the AWS SDK's multipart `Upload` (5 MB parts, progress callbacks). Upload/download progress is shown when the SDK reports totals; for downloads, progress is reported at start/end because the SDK streams the body.
- **Sync imports are metadata-light** (see above): a Cloud-only entry added from a key has filename-derived title only until the file is downloaded and parsed.
- **Corrected-EPUB export, CBR, and other v1/v2 limits are unchanged** — see Limitations below.

## Run it

```bash
npm install
npm run dev      # development server
npm run build    # production build into dist/
npm run preview  # preview the production build
```

## Wrap it for Android (Capacitor)

`capacitor.config.json` is included so the web build can be wrapped later. This does **not** require the Android SDK to build or test the web app.

```bash
npm install
npm run build
npm install @capacitor/core @capacitor/cli
npx cap add android
npx cap sync
npx cap open android   # opens Android Studio; build/run from there
```

On a real Android device you will still need to add a file/folder picker plugin for scoped-storage folder access if you want a native folder picker instead of the web file input — the web folder picker works in Chrome/WebView, but a production Android build should use the Storage Access Framework (SAF) directory picker. That is the one native piece intentionally left out of this web-first v1.

## Android storage — please read

Android does **not** let an app silently scan your whole phone. ShelfSort cannot do that, and it does not pretend to. On Android, use the folder picker to grant access to the folder your EPUBs live in (for example Downloads, or your ebook folder). The empty-state screen in the app says the same thing. Files you import are copied into the app's own IndexedDB storage; the app does not delete or move your original files.

## Privacy

No data leaves your device except (a) enrichment queries: when you press “Find fixes”, ShelfSort sends a title/author/ISBN query to Open Library (openlibrary.org) and, if that finds nothing, to Google Books — the same kind of query a web search would make; and (b) files you explicitly upload to your own private R2 bucket via Cloud / Settings (v3). Without R2 configured, it never uploads your book files, and it never sends your library list anywhere.

## Limitations (honest ones)

- **Series data is inconsistent across sources.** Open Library and Google Books do not reliably report series, so ShelfSort deliberately does **not** auto-propose series from those sources — a wrong series would mis-sort a book. Series comes from the EPUB itself, from title/filename patterns, or from your manual edit on the book detail screen. That edit is then used for sorting and for corrected-EPUB export.
- **Enrichment is best-effort with review.** A title + author search can return the wrong edition. That is why every proposal shows its source and a confidence note (“High — matched by ISBN” vs “Medium — first search result, please check it”), and why nothing is applied without your review.
- **Corrected-EPUB export:** the rebuilt EPUB copies the spine and all content files unchanged and rewrites only the OPF (plus a new cover file when supplied). One EPUB-spec detail is not preserved: the spec wants the `mimetype` entry first and uncompressed, and JSZip cannot guarantee store-only for a single entry in this simple rebuild. Most readers accept a normally-compressed mimetype entry; if a strict reader ever rejects an exported file, the original library file is still intact.
- **Chapter rendering:** chapters are rendered from the EPUB's XHTML with scripts and event handlers stripped and images resolved to blob URLs. Very unusual EPUBs (DRM-protected files, heavily scripted fixed-layout books) may not render perfectly. DRM-protected EPUBs cannot be opened at all — ShelfSort does not remove DRM.
- **Covers:** a proposed cover is fetched to a data URL only when you apply that fix, so reviewing proposals does not download covers in bulk.
- **CBR:** see above — detected, not opened. Converting to CBZ is the supported path in this build.
- **PDF viewer:** rendered with pdf.js in the browser; the build target was raised to `esnext` because pdf.js uses top-level await. Very large PDFs will be slower, and text search depends on pdf.js text extraction working for that file.
- **M4B chapters:** only Nero `chpl` chapters are parsed. QuickTime chapter tracks (a separate text track) are not decoded in this build, so an M4B whose chapters live only in a chapter track will show as "no embedded chapters" — bookmarks and saved position still work.
- **Read-along:** chapter-level only, as above. It does not do word-level narration sync, and it does not invent chapter timings when the audiobook has none.
- **Runtime testing in this environment:** the production build passes, and CBZ natural ordering, M4B `chpl` chapter parsing, read-along matching/mapping, and series gaps were tested with generated sample files in Node. PDF rendering and EPUB chapter rendering run in the browser (DOM/canvas) and were not executed against a real file in this headless environment — import a real PDF/EPUB/CBZ/M4B in `npm run dev` as a smoke test before relying on it.
