# Open fixes

Outstanding defects found while investigating the "save as PDF" reports, ordered by
severity. Each entry records the root cause rather than just the symptom, because in
every case the symptom and the cause are in different files.

Already fixed, and so **not** listed here:

- The full-page capture being answered by an iframe instead of the top frame, and the
  duplicate recording HUD. Both came from the same gap: the content script runs with
  `all_frames: true` and had no top-frame discipline. Both were confirmed fixed in a
  browser on vertiv.com.
- Dashboard "Export as PDF" embedding every screenshot as a raw uncompressed RGBA bitmap,
  the triple image decode per step, and the stretched cover logo. Measured with the
  project's jsPDF on a 15-step guide: 51.28 MB before, 3.45 MB after (14.9x). Lossless
  PNG with Flate was tried as the alternative and rejected: on pixels decoded from the
  stored JPEGs it came out 1.75x larger and took 6 s of main-thread compression against
  30 ms. Don't reopen that without re-measuring.

---

## P2 — Lazy-loaded images capture blank

**Root cause:** `fullPageScroll` settles for two `requestAnimationFrame`s plus 90 ms
before replying (`src/content.js:489`). IntersectionObserver lazy loading needs a
network round trip, typically 300 ms to 2 s, so images below the first fold come out as
placeholders.

**Fix:** raise the settle to ~250 ms, and before replying poll in-viewport `<img>`
elements for `complete && naturalWidth > 0` against a ~1.2 s budget. In
`fullPagePrepare`, flip in-viewport `loading="lazy"` images to `eager` and restore them
in `fullPageRestore`.

**Out of scope, needs its own decision:** virtualised lists (Twitter, Gmail,
react-window) unmount content as you scroll and cannot be captured by scroll-and-stitch
at all. Detect a shrinking `scrollHeight` across slices and warn in the PDF footer
rather than shipping a quietly garbled document.

---

## P3 — Fixed/sticky scan misses shadow DOM and `<html>`-level elements

**Root cause:** `document.body.querySelectorAll('*')` (`src/content.js:431`) does not
descend into `shadowRoot`, and skips anything parented directly to `documentElement`.
Cookie banners and sticky navs built as web components are stamped into **every slice**
of the capture.

**Fix:** reuse the recursive walker already written for `findPageScroller` in the same
file — it descends into open shadow roots and starts from `documentElement`. Closed
shadow roots are unreachable; worth a comment saying so.

---

## P3 — Builder tab holds far more memory than it needs

**Root causes, all in `src/capture.js`:**

- `el('preview').src = meta.chunks[0].dataUrl` (`:212`) points an `<img>` at the full
  first chunk. A 1280x15000 data URL decodes to a **~77 MB retained bitmap**; CSS
  sizing does not reduce decode cost.
- Nothing releases `meta.chunks[i].dataUrl` as chunks are consumed, so every stitched
  JPEG stays live beside the band canvases and jsPDF's own copies.
- `doc` is deliberately retained for the "Download again" button (`:230`), holding the
  entire PDF for the tab's lifetime.

**Fix:** build the preview from a downscaled canvas capped at ~400 px tall, and null out
each chunk's `dataUrl` once its bands are drawn. The retained `doc` is a deliberate
trade-off for the re-download button — leave it, but note it.

---

## P3 — Footer page numbers can reference a page that is never reached

**Root cause:** `if (h <= 0) break;` (`src/capture.js:167`) can make the actual page
count lower than the planned `total`. Footers then read "n / total" with a `total` that
is never reached, and the truncation note keyed on `page === total`
(`src/capture.js:90`, `stampFooter`) never prints at all.

**Fix:** stamp footers in a second pass over `doc.getNumberOfPages()` after layout.
`stampPdfFurniture` in `src/Dashboard.jsx:244` already does exactly this and can be
copied.

---

## Housekeeping

- `dist/` is gitignored and built by `npm run build`. It was found stale against `src/`
  during this investigation — if a fix appears not to work, check the build before
  checking the code, and remember that an already-open tab keeps its old content script
  until the page is reloaded.
