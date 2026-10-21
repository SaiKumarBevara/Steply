# Open fixes

Outstanding defects found while investigating the "save as PDF" reports. Each entry
records the root cause rather than just the symptom, because in every case the symptom
and the cause are in different files.

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
- Lazy-loaded images capturing blank, pinned bars inside web components repeating on
  every slice, and the builder tab's retained preview and chunk strings. Footers are now
  stamped in a second pass too, though that one was hardening rather than a live bug: a
  brute force over every chunk shape up to 1280x15000 found no case where the planned
  page count overshoots, so the `h <= 0` branch it guarded against is unreachable.

`tools/capture-test-server.js` serves a page for each of these capture cases, with the
expected result printed at the top. Run it before touching the capture path.

---

## P2 — Virtualised lists capture garbled

**Root cause:** feeds and long lists built on windowing (Twitter/X, Gmail, anything on
react-window or react-virtualized) unmount rows as they scroll out of view and mount new
ones in their place. Scroll-and-stitch assumes the page is static while it scrolls, so
on these pages the capture repeats, skips or overlaps rows. No change to the slicing
can fix that; the content is not there to capture.

**Fix:** detect it and say so rather than ship a quietly wrong document. A strong
signal is `scrollHeight` shrinking, or the same list items reappearing, between slices.
Carry a `virtualised` flag to the builder and print it in the last page's footer, the
same way `truncated` is handled.

**Needs a decision first:** whether a detected virtualised page should still produce a
PDF with a warning, or refuse and explain.

---

## P3 — Each slice now takes ~100 ms longer, even on a page with no images

**Cause:** `waitForVisibleImages` (`src/content.js`) holds every slice for at least
`LAZY_SETTLE_MIN_MS` plus a frame, so a script loader has time to swap its real `src`
in. On a page with nothing to load that is pure overhead: measured at ~240 ms per slice
against ~145 ms before. Each slice already spends 600 ms in the capture throttle, so a
long page captures roughly 10% slower.

**Possible fix:** skip the minimum on slices with no images in view at all, and drop
the final frame when nothing was waited for. Not done yet because the saving is small
and the minimum is what catches script loaders; measure on a real page before changing
it.

---

## Housekeeping

- `dist/` is gitignored and built by `npm run build`. It was found stale against `src/`
  during this investigation — if a fix appears not to work, check the build before
  checking the code, and remember that an already-open tab keeps its old content script
  until the page is reloaded.
- `doc` is deliberately kept alive in `src/capture.js` for the "Download again" button,
  holding the whole PDF for the life of the builder tab. That is a trade-off, not an
  oversight.
