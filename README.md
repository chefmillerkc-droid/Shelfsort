# ShelfSort

ShelfSort is a **personal, self-hosted library app** — mostly just for its owner. There is **no Google Play goal** and no account, backend, or paid API. It runs as a web app (and can be wrapped with Capacitor later, purely for personal sideloading if wanted).

ShelfSort is an EPUB library app that:

1. **Scans / imports EPUBs** from your device — pick individual files, pick a folder, or drag-and-drop them.
2. **Reads each book's own metadata first** — title, author, publisher, date, description, ISBN, series, and cover, straight from the EPUB's OPF package file.
3. **Finds and fixes missing metadata and covers — only asking when unsure** — it queries Open Library first (ISBN, then title + author) and Google Books as a fallback. **High-confidence fixes are auto-applied immediately, without a prompt; only uncertain fixes go to a Fix Review screen**, where you can apply all, apply per book, skip, or edit a value first. A header toggle, **“Auto-apply high-confidence fixes (only ask when unsure)”**, is ON by default — turn it OFF to restore the old ask-every-time behaviour. **High confidence means, strictly:** an ISBN match to the same edition, OR an exact title + exact author match with a single unambiguous search result. Anything else — first search result only, fuzzy title/author, multiple candidates, or a cover that could belong to a different edition — is uncertain and is never auto-applied. Even for a high-confidence title/author match, a cover is review-only unless it came from an ISBN match. After a Find Fixes run, an **“Auto-fixed” summary** lists every book auto-fixed, which fields changed, the source, and the confidence reason, and each book's detail page records its auto-applied fixes so you can correct them with “Edit metadata” later. Auto-apply is therefore visible and reversible, never hidden or irreversible. Series is still never auto-proposed from these sources (see Limitations).
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
- **Enrichment is best-effort, with auto-apply only for high confidence.** A title + author search can return the wrong edition. That is why confidence is classified strictly (ISBN to the same edition, or exact title + exact author with a single unambiguous result), why uncertain proposals always go to Fix Review, why non-ISBN covers are always review-only, and why every auto-applied fix is listed in the Auto-fixed summary and recorded on the book's detail page. If an auto-fix is wrong, correct it with “Edit metadata” on that book's detail page, or turn the auto-apply toggle OFF to go back to asking every time. A proposal's source and confidence reason are still shown in Fix Review for anything uncertain.
- **Corrected-EPUB export:** the rebuilt EPUB copies the spine and all content files unchanged and rewrites only the OPF (plus a new cover file when supplied). One EPUB-spec detail is not preserved: the spec wants the `mimetype` entry first and uncompressed, and JSZip cannot guarantee store-only for a single entry in this simple rebuild. Most readers accept a normally-compressed mimetype entry; if a strict reader ever rejects an exported file, the original library file is still intact.
- **Chapter rendering:** chapters are rendered from the EPUB's XHTML with scripts and event handlers stripped and images resolved to blob URLs. Very unusual EPUBs (DRM-protected files, heavily scripted fixed-layout books) may not render perfectly. DRM-protected EPUBs cannot be opened at all — ShelfSort does not remove DRM.
- **Covers:** a proposed cover is fetched to a data URL only when you apply that fix, so reviewing proposals does not download covers in bulk.
- **CBR:** see above — detected, not opened. Converting to CBZ is the supported path in this build.
- **PDF viewer:** rendered with pdf.js in the browser; the build target was raised to `esnext` because pdf.js uses top-level await. Very large PDFs will be slower, and text search depends on pdf.js text extraction working for that file.
- **M4B chapters:** only Nero `chpl` chapters are parsed. QuickTime chapter tracks (a separate text track) are not decoded in this build, so an M4B whose chapters live only in a chapter track will show as "no embedded chapters" — bookmarks and saved position still work.
- **Read-along:** chapter-level only, as above. It does not do word-level narration sync, and it does not invent chapter timings when the audiobook has none.
- **Runtime testing in this environment:** the production build passes, and CBZ natural ordering, M4B `chpl` chapter parsing, read-along matching/mapping, and series gaps were tested with generated sample files in Node. PDF rendering and EPUB chapter rendering run in the browser (DOM/canvas) and were not executed against a real file in this headless environment — import a real PDF/EPUB/CBZ/M4B in `npm run dev` as a smoke test before relying on it.

## v0.4.0 — split storage (crash/persistence fix) + clean library UI

**The problem this fixes:** with only ~300 EPUBs imported, the old build loaded
every book's whole file into memory on launch (EPUB parsing via JSZip plus
whole-file blobs in the library load), crashed after about a minute, and then
showed an empty library on reopen — because the import had crashed before
finishing. EPUBs alone were enough to trigger it; no PDFs, comics, or audio
were involved.

**Split storage + migration:**
- IndexedDB is now two stores: `books-meta` (metadata, cover, series,
  progress, links, `r2Key`, `fileName`, `format`, `hasFile` — no file blob)
  and `books-files` (id → ArrayBuffer).
- The library list, search, sort, series grouping, and Find Fixes all run
  off metadata only, so loading 300 books is trivially stable.
- A book's file is loaded only when that book is actually opened
  (EPUB reader, PDF, comic, audio, read-along, corrected-EPUB export), and
  released when you leave the viewer.
- Import is sequential, one book at a time, committing meta + file per book
  immediately, with `Imported X of Y — <title>` status. A crash mid-import
  keeps everything imported so far; re-import the rest.
- Migration from v1 is automatic and idempotent: old `books` records are
  split into meta + file (skipping ids already migrated), then the old
  store is deleted on a second upgrade step. Existing imported books
  survive; no file is lost. If migration is interrupted, the next launch
  re-runs it without clobbering edited metadata.

**Clean library UI (from the reference screenshots):**
- Dark-first top bar: `Library`, a search icon, a List/Grid toggle, and a
  Settings menu — no header crammed with Cloud/Find-fixes/checkbox buttons.
  Cloud/Settings, Find fixes, and Clear library live on a Settings screen.
- List view: cover left, title + author right, thin progress bar under
  the cover, with ALL / NEW / STARTED / FINISHED tabs (NEW = no progress,
  STARTED = progress set, FINISHED = finished flag, set when the EPUB
  reader reaches the last chapter or toggled on the detail page).
- Grid view: 3-column covers, with title + author under each cover in
  small, muted text so the covers stay the focus (revised from the
  original covers-only grid at the user's request).
- Series view: a separate screen with tag rows, series name, and book
  count on the right; tapping a series shows its books in order with
  gaps noted. Series is a view, not just a sort mode.
- Book cards show only cover + title + author (+ progress bar in list
  view). Cloud status, auto-fixed notes, series lines, and read-along
  lines moved to the detail page only.
- Sort options are now: Series, Author, Title, Publication date,
  Recently added. Publication date sorts newest first, with books that
  have no usable date last; `metadata.date` may be a year, a full date,
  or empty/malformed — the year is parsed robustly and never crashes.

**Not yet device-tested:** this build passes `npm run build` and the
migration/import/sort paths were logic-checked by reading the code back,
but no real device import of 300 EPUBs was run here. After pushing, the
APK rebuild must be smoke-tested on the phone (import a few EPUBs, close
and reopen the app, open one book) before trusting it with a full import.

## v0.7.0 — EPUB reader rebuilt from the ground up (no CSS columns)
- **Why:** the CSS-column reader measured a chapter as "Page 1 of 1" while its text ran past the bottom of the page, clipped and unreachable, and the top of chapters clipped under the sticky top bar. That approach is deleted, not patched.
- **Measured real pages:** a chapter is split into real page divs by measuring rendered height in a hidden container at the exact page width/font/theme (`src/lib/paginate.js`). Blocks are added one at a time; a block that would overflow closes the page. A single block taller than a page is split by words — never dropped, never clipped. The visible reader shows exactly ONE page div. If measurement ever fails or returns 0, the whole chapter renders scrollable — never overflow:hidden with no way to reach text.
- **One page per swipe:** a swipe, tap-zone turn, or button turn advances exactly one page; ONLY on the last page does it advance to the next chapter (and symmetrically, previous on the first page goes to the previous chapter's last page). This is the same rule in code (`nextPageIndex`) and in tests.
- **Full screen:** the global top bar is hidden while reading, main has no padding in reader mode, and the reader is exactly 100dvh — minimal header + flex page area + minimal footer, no black gap below, nothing under any bar. The page-turn swipe is the only horizontal gesture in the reader.
- **Full 3D flip:** during a drag or animated turn, the incoming page sits underneath (slightly scaled) and the outgoing page rotates 0 -> 180deg in perspective around the spine (left edge for next, right edge for previous), with a shadow peaking mid-flip; past 90deg it is backface-hidden, so it reads as flipping over to reveal the next page. Transform + opacity only. The flip follows the finger and snaps forward (past ~25% width or a fast flick) or back on release. Haptics unchanged: light on a completed page turn, medium on a chapter change, nothing on a snap-back.
- **Kept:** chapter prev/next, chapter dropdown, font-size slider, light/dark/sepia themes, in-book search (now jumps to the ACTUAL page containing the hit, not a character-fraction estimate), progress as chapter + page (old chapter-only records open at page 1; old chapter+page records clamp to the new page count).
- **Left-edge swipe exit, everywhere:** a swipe starting within ~24px of the left edge and moving right exits the current view — reader -> detail (progress saved first), detail/unsorted/fixes/cloud -> library, series-detail -> series, PDF/comic/audio/read-along -> detail. ALL in-app Back buttons were removed and replaced by this gesture. System back (Android back button/gesture, browser back) pushes the same destinations via a history entry per back-able view, so a user is never stuck if an edge swipe misses. Desktop fallback: Escape exits the current view to the same destination; browser back and top-bar tabs also still work. Note for mouse/web users: there is no mouse equivalent of an edge swipe and no on-screen Back button left — browser back or Escape is the desktop path.
- **Tap to read, long-press for detail:** tapping a book row/card (cover or title/author — the whole row is the target) opens the book directly in its reader/player, with no detail page in between. Holding ~500ms without moving (>12px move cancels) opens the existing detail page instead, with all its content kept; a long-press never also fires the tap, and a scroll never opens anything. CBR still falls back to detail, since it cannot open at all. Detail descriptions are cleaned for DISPLAY only (HTML tags and markdown asterisks stripped) — stored metadata and catalog values are untouched, and the Edit form still shows the raw value.
- **Version label:** Settings now shows "ShelfSort v0.7.0", so the installed build is always identifiable.
- **Catalog export fixed on Android (was silently broken):** the old export used an anchor `<a download>` blob URL, which Android's in-app WebView swallows — tapping Export said "Exported N books" while NO file ever appeared in Files/Downloads (confirmed 2026-11-04). That path is now web-only. On native, Export writes `shelfsort-catalog.json` to the app Cache directory first (chunked base64, same pattern as the audio store; Cache is what Capacitor's FileProvider shares by default, so no android/ or workflow change is needed) and opens the native share sheet (`@capacitor/share` 8.x, `Share.share` with the file URI) — the user picks a destination (Files, Drive, Muse, …) and that is where the file actually lands. If the share sheet is unavailable or fails, the file is written to the Documents directory instead and the status says exactly that filename/location. If nothing could be written, the status says plainly that NO file was created and why — never "Exported N books" for a file that does not exist. A dismissed share sheet is reported as such (Cache file exists, tap Export again to share it), not as a failure. Import (file input) is untouched.

## v0.6.1 — Series grouping fix (colon titles + case variants)
- **Series grouping fixed:** two bugs made the Series screen list single books as their own series. (1) Title parsing: "A Parade of Horribles: Dungeon Crawler Carl, Book 8" was grouped as series "A Parade of Horribles: Dungeon Crawler Carl" because the code took everything before ", Book N" as the series. Now, for title-parsed (not metadata) series containing ":", the segment after the last colon is used as the series ONLY if 2+ books share it — every DCC book shares "Dungeon Crawler Carl", so they group under it, ordered by index (1, 2, 8…). A lone "Series: BookTitle, Book N" keeps its full prefix, so it is no worse off. (2) Case variants: the group key is now normalized (lowercase, collapsed whitespace, punctuation stripped, leading "The " dropped), so "Red rising" and "Red Rising" — and "The Vampire Chronicles" vs "Vampire Chronicles" — merge into one group, displayed under the most frequent (title-cased on ties) form. Metadata series is still authoritative and is never second-guessed. Books whose metadata series itself is wrong still need a manual edit on the detail page or a catalog correction — the parser cannot guess those.

## v0.6.0 — ReadEra-style reader, cloud UI hidden (native player KEPT)
- **EPUB reader rebuilt (ReadEra-style page turning):** the page area now fills the viewport height minus a minimal header/footer (`calc(100dvh - 210px)`), not a 62dvh box. Swipes FOLLOW the finger: touchmove applies the drag offset live in pixels, and on release the page snaps to next/previous when the drag passes ~25% of the page width or is a fast flick, otherwise it snaps back. Pagination is pixel-based — the page width is measured from the column element and translateX is `pageIndex * pageWidth` px, with column-gap 0, so pages do not drift or clip text at boundaries. Tap left/right thirds still turn pages, tap the middle (or the **Aa** button) toggles the toolbar, and the click that follows a swipe is suppressed so a page never turns twice. Chapter dropdown, search, font size, and light/dark/sepia controls now live behind that single tap-to-show toolbar instead of permanently eating reading space. The footer stays minimal: Page X of Y · Chapter A of B · %. Preserved: font size, themes, chapter navigation, in-book search jumping to the hit's page, and progress saved as chapter + page (old chapterIndex-only records still open at chapter page 1). Read-along's EPUB pane is unchanged and still scrolls — pagination is EPUB-reader only.
- **3D page-turn effect (flip, not paper curl):** the reader page container has `perspective: 1200px`, and a `.reader-flip` wrapper tilts the turning page in 3D — during a drag it rotates up to ~35deg in the turn direction (negative for next, positive for previous) and dips to 0.97 scale, proportional to drag progress, with a darkening gradient shadow that grows with progress; during a tap/button snap turn a 0.25s keyframed animation peaks at ~35deg/0.97 scale mid-turn and settles back to 0. The incoming page reads as sitting slightly scaled underneath because of that scale dip. A literal curved paper curl is NOT implemented — it is not feasible with CSS-column pagination, and no curl is faked with a static image. Transform + opacity only, so no layout thrash on a phone WebView.
- **Page-turn haptics:** a light Capacitor Haptics impact fires when a page turn actually completes (swipe snap, tap-zone turn, or button turn), and a medium impact when turning into a new chapter. Nothing fires on a snap-back/cancelled drag, and nothing fires during the drag itself. If Haptics is unavailable (web, or the plugin missing), it falls back silently to `navigator.vibrate(10)` if available, otherwise no-ops — it never throws and never blocks the turn. `@capacitor/haptics` (^8.0.2, matching Capacitor 8) is in package.json/lock so `cap sync` on the runner picks it up.
- **Native audio player KEPT, play-time load step REMOVED:** the native Playlist/ExoPlayer + MediaSession path is kept, but the old play-time Cache copy is deleted from `src/lib/nativeAudio.js` entirely. Audio is now stored at import time (`src/lib/audioStore.js`): an M4B/MP3 is written once to Capacitor's persistent Data directory under `shelfsort-audio/audio-<bookId>.<ext>` and the resulting file URI is stored on the book record as `audioFileUri`; NO audio blob is stored in IndexedDB for such books, so there is no double storage. At play time the player passes that already-existing URI straight to ExoPlayer — no copy, no base64 conversion, no loading step. Hit play, it plays. Fallbacks, silently and without crashing: a web build (no native Filesystem) or a failed Data write falls back to the IndexedDB blob + HTML player, and a native player failure with a blob available falls back to HTML too. The only thing still written at play time is the small cover thumbnail for MediaSession artwork (a few KB, skipped on failure). **Deleting/uninstalling the app deletes the Data-directory audio files with it — a fresh install must re-import audiobooks; no migration was built because the user will reinstall fresh.** `capacitor-plugin-playlist` / `@capacitor/filesystem` stay in package.json, and background/lock-screen playback remains the native feature as before.
- **App fits the screen — no sideways dragging anywhere:** two bugs, both fixed. (1) Reader: the EPUB column strip carries classes `reader-column-flow chapter`, and `.reader .chapter` (specificity 0,2,0) was beating the strip's own `padding: 0` (0,1,0), leaving 16px padding on the strip while App.jsx measured pageWidth as `clientWidth` (which includes padding) — so every page turn drifted 32px and text clipped on the right, forcing sideways dragging. Fixed with a 0,3,0 rule `.reader .reader-column-flow.chapter { padding: 0 }`; the 16px visual inset already lives on the outer `.reader-pages` container, so nothing visually moves, only the geometry becomes exact: with padding 0 and gap 0, column width = clientWidth, page count = scrollWidth / clientWidth, translate step = pageWidth, drift = 0 (checked numerically: at 360px width / 10 pages the old geometry counted 9 pages and drifted 288px; the new geometry counts 10, drift 0). (2) Library list itself: the whole document could be dragged sideways because nothing stopped it. Now `html, body, #root, main` all get `overflow-x: clip` (clip, not hidden, so no scroll container is created and sticky/topbar behaviour is preserved) AND `touch-action: pan-y`, so a horizontal swipe can never pan the page — vertical scrolling only, everywhere except intentionally scrollable strips. Flex rows are hardened so nothing can force the document wider than the viewport: `min-width: 0` on `.row-text`, `.row-title`, `.row-author`, `.series-name`, `.topbar h1`, toolbar children and bottom-tab buttons, `max-width: 100%` on `.book-row`, `.series-row`, `.book-grid-wrap` (now `repeat(3, minmax(0, 1fr))`), and wrapping on `.topnav`. `.status-tabs` keeps its own intentional horizontal scroll but gets `overscroll-behavior-x: contain` (and the thumb strip too) so its scroll never propagates to the document. Chapter content is clamped as well: images, tables, pre, svg, video and figures inside chapter content get `max-width: 100%`, long words wrap, `pre` wraps instead of overflowing, tables use fixed layout. The reader's page-turn swipe remains the ONLY horizontal gesture in the reader — no inner horizontal scrolling/dragging of page content.
- **Cloud UI hidden, not deleted:** the Settings "Cloud shelf" card, the detail-page cloud buttons (Set up Cloud/R2, Upload/Re-upload, Clear local, Delete from R2), and the Cloud view route (including its topnav active state) are removed from the UI. `src/lib/r2.js` and the internal R2 helpers stay in the repo, dormant, and the `CloudView` component stays in App.jsx unreachable, so cloud can come back later without rebuilding it. The ONLY cloud UI path kept is a plain **Download & open** button on a book that is already cloud-only with no local file — and opening any such book still downloads it automatically, otherwise it would become unreadable. Library import, local storage, and Muse catalog export/import are untouched.
- **Workflow note for the parent (do NOT edit the workflow from here):** because the native player is kept, the APK workflow's playlist-plugin Kotlin patch step and the AGP 8.9.1 / compileSdk 36 bump are still needed — they are NOT droppable in v0.6.0.

## v0.5.1 — Muse catalog export / import (no backdoor)
- **Settings → Muse catalog — export / import** (`src/lib/catalog.js`): Export downloads `shelfsort-catalog.json` — metadata only (id, file name, format, title, author, publisher, date, ISBN, description, series, series number, hasCover, titleFromFilename). No book files, no covers, no progress, no cloud credentials, no R2 keys.
- Import reads a catalog file, matches books by id, then file name + format, then unique file name, and shows a preview: how many books would change, what each change is (first 20 shown), how many are unchanged, how many did not match and will be skipped. Nothing applies until **Apply these changes**.
- Import only writes title, author, publisher, date, ISBN, description, series, and series number. A changed title clears the filename-derived flag. This is the controlled way for Muse (or anyone) to sort the whole catalog — series, series order, authors, titles — with no port, no socket, and no persistent access.
- **Bottom format tabs:** fixed bottom bar on Library / Series / Unsorted — All, Books (EPUB + PDF), Comics (CBZ/CBR), Audiobooks (M4B/MP3), each with a count. Tapping a tab filters the list below; the choice is remembered. This replaces the old format dropdown.
- **App icon + splash:** `assets/icon.png.b64` / `assets/splash.png.b64` are base64 text of the 1024×1024 icon and 2732×2732 splash (Muse's GitHub push handles text files only, so PNGs are stored this way). The APK workflow decodes them to `assets/icon.png` / `assets/splash.png` before running `@capacitor/assets generate --android`.

**Native audio player (the big one):**
- Playback is now `capacitor-plugin-playlist` v8.0.0 on native platforms
  (Capacitor 8+, `@capacitor/core` ^8, `@capacitor/filesystem` ^8), with
  `src/lib/nativeAudio.js` as the wrapper. Android uses the plugin's
  media3 / ExoPlayer + MediaSessionService + foreground `mediaPlayback`
  service, so M4B/MP3 playback keeps going when the app is backgrounded
  or the screen locks, with lock-screen / notification play-pause
  controls from the plugin's MediaStyle notification. No second custom
  notification is built here.
- The plugin's AndroidManifest (merged automatically by `cap sync`)
  already includes `WAKE_LOCK`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and the MediaService — do not edit
  AndroidManifest by hand (android/ is generated on the GitHub runner).
- What stays custom in ShelfSort: the player UI, chapter list, bookmarks,
  sleep timer, speed, and progress saving. All are preserved: play/pause,
  seek slider, current/total time, ±15s/±30s, speed 0.5–2×, sleep timer
  15/30/60, bookmarks, Nero-chapter list (seek to chapter start), progress
  saved every 5+ seconds and on pause/back, saved-position resume.
- The plugin can only play a real file URI, so the audio book's bytes are
  copied to Capacitor's Cache directory (stable filename per book id,
  chunked base64 copy, reused when the cached size matches the library
  file). Clearing the app cache does NOT delete the library file in
  IndexedDB — the cache copy is rebuilt on the next open. Cover art is
  likewise written to cache when it is a data: URL, so MediaSession can
  show it.
- Web / Pages, and any native failure, fall back to the existing HTML
  `<audio>` path — never silence. The player screen shows which backend
  is active ("Native player" vs "In-app player (web fallback)").
- Leaving the standalone player screen does NOT pause native playback
  (that is the point); a new book replaces the playlist, and pausing
  from the app or the notification stops it. The sleep timer lives in
  the player screen only and is cleared if you leave it.
- Read-along uses the same native controller, driven by its status
  position events (throttled / suppressed while backgrounded — fine,
  read-along is a foreground activity). Unlike the standalone player,
  leaving read-along DOES pause, matching the old HTML behaviour there.
- Android 13+ POST_NOTIFICATIONS — known limitation, not faked: the
  plugin does not merge that permission and this codebase has no
  permissions plugin, so no runtime request is attempted. If the
  notification does not appear, allow notifications for ShelfSort in
  system settings (Settings > Apps > ShelfSort > Notifications).
  Playback itself is unaffected.
- NOT device-tested yet: background playback, lock-screen controls and
  notification controls must be tested on the phone (play an M4B,
  background the app / lock the screen, confirm it keeps playing and
  the notification controls work, reopen and confirm position saved).

**EPUB reader paginates (page-turn, not scroll):**
- Chapter content is laid out in CSS columns (one column = one
  screen-sized page) and translated horizontally by page index.
  Page count is measured from the rendered layout, so it follows font
  size and viewport instead of guessing from character counts.
- Tap the right side / swipe left = next page, tap the left side /
  swipe right = previous page (middle taps and links are untouched).
  The last page of a chapter advances to the next chapter; the first
  page of a chapter goes back to the previous chapter's last page.
- Page indicator: "Page X of Y · Chapter A of B". Font-size control and
  light/dark/sepia themes are unchanged; changing font size repaginates
  and keeps your proportional place. The chapter dropdown jumps to
  chapter page 1. In-book search jumps to the chapter and the estimated
  page containing the hit (character position within the chapter —
  an estimate, since columns fill in order).
- Progress is now chapter + page, so reopening returns to the same page.
  Old progress records with only `chapterIndex` still load at that
  chapter's first page. A book is only marked finished when its last
  chapter's last page is reached (or toggled on the detail page).
  Read-along's EPUB pane still scrolls — pagination is EPUB-reader only.

**Pull-to-refresh:**
- On Library (list/grid), Series and Unsorted views only: swipe down
  when already scrolled to the top to reload library metadata from
  IndexedDB, with a "Pull to refresh / Release to refresh /
  Refreshing…" indicator. It never triggers on reader, detail, audio
  or settings screens, and it does not intercept normal scrolling
  (it only arms when the page is at the top). No new dependencies;
  plain touchstart/touchmove/touchend handling.

**Import first, fix second — Unsorted shelf:**
- Import uploads everything as-is. Import never runs enrichment and
  never blocks on it (this was already true in v0.4; it is now the
  documented flow, with the scan made explicitly opt-in).
- Unsorted shelf (top navigation, with a count, like
  the Series view): no series AND (author missing OR cover missing OR
  the title was derived from the filename because the file had no
  title metadata). Parsers now record `titleFromFilename` for EPUB,
  PDF, CBZ, M4B and MP3 (CBZ titles are always filename-derived;
  pre-v0.5 records fall back to comparing the title with the cleaned
  filename stem). Standalone books with a real title, author and
  cover are NOT Unsorted just for having no series.
- Find Fixes is now scoped, in Settings and on the Unsorted screen:
  "Scan Unsorted shelf (N)" is the prominent default; "Find fixes
  (all books)" is kept as the second option. Scoped runs use the
  existing high-confidence auto-apply rule, with uncertain fixes going
  to Fix Review. The shelf is computed from metadata on every render,
  so a book leaves it automatically once a fix or manual edit supplies
  author + cover + series (or a real title + author + cover) — a
  supplied title clears `titleFromFilename`, a manual title change
  does the same.
