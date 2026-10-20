# Open fixes

Outstanding defects found while investigating the "save as PDF" reports, ordered by
severity. Each entry records the root cause rather than just the symptom, because in
every case the symptom and the cause are in different files.

Two causes were already fixed and are **not** listed here: the full-page capture being
answered by an iframe instead of the top frame, and the duplicate recording HUD. Both
came from the same gap — the content script runs with `all_frames: true` and had no
top-frame discipline.

---

## P0 — Dashboard "Export as PDF" embeds raw uncompressed bitmaps

**Symptom:** exporting a guide produces an enormous file, freezes the dashboard tab for
a long time, and on larger guides crashes it outright. No error is shown.

**Measured cost:** a stored screenshot is a ~80 KB JPEG at 1280x700. What reaches the
PDF is 2.56 MiB of RGB plus a 0.85 MiB alpha SMask — **~3.4 MB per step, uncompressed**.
A 15-step guide is ~51 MB; a 40-step guide is ~137 MB. `doc.save()` builds the whole
document as one JS string before blobbing it, so peak memory is 3-4x the file size.

**Root cause** — four links, each individually invisible:

1. `getAnnotatedDataUrl` returns PNG (`src/Dashboard.jsx:625`). Correct for the
   clipboard, which rejects JPEG in a `ClipboardItem` — but the PDF exporters reuse the
   same function.
2. `doc.addImage(image, 'JPEG', ...)` (`src/Dashboard.jsx:220`). **The `'JPEG'`
   argument does nothing.** jsPDF sniffs magic bytes and uses the argument only as a
   fallback (`jspdf.es.js:10336`), so it correctly detects PNG and ignores it. The code
   reads as though it writes JPEG. It does not. This is the trap that hid the bug.
3. `new jsPDF()` with no `compress: true` (`src/Dashboard.jsx:2085` and `:2761`), so
   `getFilters()` returns `[]`, `addImage` never sets a compression level
   (`jspdf.es.js:10300`), and `checkCompressValue(undefined)` falls through to `"NONE"`
   (`jspdf.es.js:9837`).
4. `canvas.toDataURL('image/png')` always emits colorType 6 (RGBA), which takes
   `processPNG`'s alpha-split branch (`jspdf.es.js:17044`). With compression `"NONE"`,
   `canCompress` is false and it writes raw bytes with no `FlateDecode`
   (`jspdf.es.js:17104`).

The alpha channel is pure waste on top of that: the canvas is painted from an opaque
JPEG, so every one of those 896,000 alpha bytes per step is `255`.

**Fix:**

- Split `getAnnotatedDataUrl` into a core that takes `mime`/`quality` and returns
  `{ dataUrl, width, height }`, plus a thin wrapper keeping today's string return.
  Only the two PDF call sites use the core — the other 9 callers stay untouched, which
  keeps the blast radius small.
- Pass `'image/jpeg'` from both PDF exporters (`src/Dashboard.jsx:2154` and `:2798`).
  Leave the clipboard call at `:1416` on PNG.
- Add `compress: true` to both `new jsPDF()` calls as a safety net, so a PNG that ever
  reaches `addImage` again gets `FlateDecode` instead of raw bytes. Verified safe for
  JPEG: `processJPEG` ignores the compression argument and passes data straight through
  with `DCTDecode` (`jspdf.es.js:16141-16152`), so there is no double encoding.
- Then make `addImage`'s declared format honest, and leave a comment that jsPDF sniffs
  the type regardless.

**Verify:** export a 15-step guide. Expect roughly 1.5 MB, not ~51 MB.

**Effort:** ~1 hour. **Expected improvement:** ~40x smaller files.

---

## P1 — Each screenshot is PNG-decoded three times per step

**Root cause:** `doc.getImageProperties()` runs the full `processPNG` pipeline
(`jspdf.es.js:10437`) and has **no alias cache** — only `addImage` caches. Per step:

- `pdfStepWantsFullPage` -> `getImageProperties` (`src/Dashboard.jsx:2163`)
- `fitPdfImage` -> `getImageProperties` (`src/Dashboard.jsx:218`)
- `addImage` -> `processPNG` (`src/Dashboard.jsx:220`)

Each decode unfilters every scanline in pure JS and allocates ~5 bytes/pixel of scratch
that is thrown away immediately.

**Fix:** the width and height are already known on the canvas. Take them from the P0
change's `{ dataUrl, width, height }`, thread them into `fitPdfImage` and
`pdfStepWantsFullPage` as plain numbers, and **delete both `getImageProperties` calls**
(`src/Dashboard.jsx:107` and `:168`). Keep the existing 16:9 fallback for the legacy
`step.screenshot` path, where dimensions are genuinely unknown.

Best done in the same pass as P0 — they touch the same functions.

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

## P2 — Cover logo is the one image that bypasses the aspect-ratio fix

**Root cause:** `doc.addImage(coverLogo, 'PNG', 142, 20, 50, 25)`
(`src/Dashboard.jsx:2093`) forces a hard 50x25 mm box. Commit b96be43 fixed exactly this
squashing for step screenshots via `fitPdfImage` but missed the logo, so any logo that
is not 2:1 is stretched.

**Fix:** route it through `fitPdfImage` with a 50x25 mm bounding box and drop the
`'PNG'` literal, which is a fallback jsPDF ignores anyway.

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
