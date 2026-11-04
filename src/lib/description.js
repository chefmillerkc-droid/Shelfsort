// Display-only description cleanup (see App.jsx detail page).
// Some EPUB descriptions contain raw HTML/markdown from the file
// (literal "</em>", "<p>", "*SUSPENSE MAGAZINE*"). Strip tags and
// asterisks ONLY when rendering — stored metadata and catalog
// values are never altered, and the Edit form shows the raw value.

export function cleanDescription(raw) {
  if (!raw) return ''
  let s = String(raw)
  try {
    const el = document.createElement('textarea')
    el.innerHTML = s
    s = el.value
  } catch { /* entity decode is best-effort */ }
  s = s.replace(/<[^>]*>/g, ' ').replace(/\*+/g, '')
  return s.replace(/\s+/g, ' ').trim()
}
