# Steply — Chrome Extension

> Auto-generate step-by-step guides by recording your browser interactions. Captures clicks, text inputs, scrolls, and screenshots — then exports to PDF, Word, Markdown, HTML, or JSON. Also saves any single page, in full, as a multi-page PDF.

---

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Project Setup](#project-setup)
3. [Build the Extension](#build-the-extension)
4. [Load the Extension in Chrome](#load-the-extension-in-chrome)
5. [How to Record a Guide](#how-to-record-a-guide)
6. [Using the Dashboard](#using-the-dashboard)
7. [Exporting a Guide](#exporting-a-guide)
8. [Save Current Page as PDF](#save-current-page-as-pdf)
9. [Screenshot Editor (Annotations & Redaction)](#screenshot-editor-annotations--redaction)
10. [Ultimate Single-Click Copy](#ultimate-single-click-copy)
11. [Bulk Export Manager](#bulk-export-manager)
12. [Resume Recording (Add Steps to Existing Guide)](#resume-recording)
13. [Keyboard Shortcut](#keyboard-shortcut)
14. [Features Reference](#features-reference)
15. [Project Structure](#project-structure)
16. [Troubleshooting](#troubleshooting)
17. [Development Workflow (Quick Reference)](#development-workflow-quick-reference)

---

## Prerequisites

Make sure you have the following installed:

- [Node.js](https://nodejs.org/) v16 or higher
- npm (comes with Node.js)
- Google Chrome browser

---

## Project Setup

1. Open a terminal and navigate to the project folder:
   ```
    cd path\to\Steply
   ```

2. Install all dependencies:
   ```
   npm install
   ```

---

## Build the Extension

Every time you make a code change, you must rebuild:

```
npm run build
```

This compiles all source files from `/src` into the `/dist` folder that Chrome loads.

> **Note:** Always rebuild after any code change — Chrome loads from `/dist`, not from `/src` directly.

---

## Load the Extension in Chrome

1. Open Chrome and go to: `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the `/dist` folder:
   ```
    path\to\Steply\dist
   ```
5. The **Steply** extension will appear in your extension list
6. Pin it to the toolbar by clicking the puzzle icon (🧩) → pin Steply

> **After every rebuild:** Go back to `chrome://extensions/` and click the **↻ (Reload)** button on the Steply card.

---

## How to Record a Guide

### Step 1 — Navigate to the website you want to document
- Go to any website (e.g. your internal app, Salesforce, Mendix, etc.)
- **Important:** The extension cannot record on Chrome internal pages like `chrome://extensions/` or `chrome://newtab/`

### Step 2 — Start Recording
1. Click the **Steply** icon in the toolbar
2. Click **"Start Recording"**
3. The status indicator turns green and shows **"Recording..."**

### Step 3 — Perform your actions
The extension automatically captures:
- **Clicks** — every button, link, checkbox, or dropdown you click
- **Text input** — what you type in any field (captured when you leave the field). Passwords are masked as `••••••••`
- **Scrolling** — when you scroll up, down, left, or right by more than 50px
- **Screenshots** — a screenshot is taken after every action, with a red box highlighting the clicked element

### Step 4 — Stop Recording
1. Click the **Steply** icon again
2. Click **"Stop Recording"**
3. Your guide is automatically saved to the browser's local storage (IndexedDB)

---

## Using the Dashboard

The Dashboard is where you view, edit, and manage all your guides.

### Open the Dashboard
- Click the **Steply** icon → click **"Open Dashboard"**
- Or click any guide name in the popup's **"Recent Guides"** list

### View a Guide
- The left sidebar lists all your saved guides with step count and date
- Click a guide to open it in the main panel

### Edit a Step Description
1. Click on any step's text in the timeline
2. The text becomes an editable field
3. Type your changes
4. Click **"Save"**

### Rename a Guide
1. Click the **✏️ Edit** button next to the guide title
2. Type the new name
3. Click **"Save"**

### Delete a Guide
1. Click the **🗑️ Delete** button in the top-right controls
2. Confirm the deletion prompt
3. The guide and all its screenshots are permanently removed

---

## Exporting a Guide

Open a guide in the Dashboard, then use the export dropdown in the top-right:

| Format | File | Contents |
|---|---|---|
| **PDF** | `.pdf` file | All steps with annotated screenshots, two per page |
| **Word** | `.docx` file | All steps with embedded annotated images |
| **Markdown** | `.md` file | All steps with inline base64 screenshots |
| **HTML** | `.html` file | Self-contained page with embedded screenshots |
| **JSON** | `.json` file | Structured bundle — step text, metadata, element data, annotations, and screenshots |

> **Annotated screenshots:** All exports include the red highlight box drawn over the clicked element, plus any annotations you added — identical to what you see in the dashboard.

---

## Save Current Page as PDF

Separate from recording: this takes the page you are looking at and saves **the whole page**
— not just the visible area — as a multi-page A4 PDF.

### How to use it
1. Go to the page you want.
2. Open the Steply popup and click **"Save current page as PDF"** (bottom of the popup).
3. Steply scrolls the page from top to bottom, capturing a screen at a time. Leave it alone while it works — you can close the popup, but don't switch tabs.
4. A new tab opens, builds the PDF, and downloads it automatically. The filename is the page title plus the date.

### What it does for you
- **Captures past the fold.** The page is scrolled and the screens are stitched together, so you get the full document, not a screenshot.
- **Strips pinned elements.** Sticky headers are dropped into normal flow and fixed elements (nav bars, cookie banners, chat widgets) are hidden after the first screen, so they don't repeat down every page of the PDF. The page is restored exactly as it was afterwards.
- **Splits tall captures automatically.** Chrome refuses to allocate a canvas taller than roughly 16,384px, so very long pages are stitched in several chunks. The chunk boundaries fall on screen boundaries and run end to end in the PDF, so nothing is lost or duplicated between them.
- **Footers every page** with the source URL and a `page / total` counter.

### Important notes
- **Nothing is saved as a guide.** This writes nothing to IndexedDB and does not appear in your guide list. The PDF file is the only output.
- **Safe during recording.** Using it mid-recording does not add a step or disturb the guide being recorded. The recording HUD is hidden so it isn't baked into the capture.
- **It takes time.** Chrome rate-limits screen capture to about two per second, so a long page genuinely takes 30–90 seconds.
- **Limits.** Capture stops at 150 screens or 120,000 output pixels, whichever comes first — comfortably past the longest real documents, but an infinite-scroll feed will stop there. When that happens the PDF says so in the footer of its last page rather than passing a partial capture off as complete.
- **Blocked pages.** Chrome does not allow capture on `chrome://` pages, the Web Store, or the built-in PDF viewer. You'll get a clear message instead of a hung button.

---

## Screenshot Editor (Annotations & Redaction)

One editor covers both marking up a screenshot and obscuring sensitive data in it (PII, passwords, internal keys).

### How to edit a screenshot:
1. Open a guide in the **Dashboard**.
2. Click the **✏️ Pencil** icon on any step card. The badge on the icon shows how many annotations that step already has.
3. Pick a tool from the toolbar and a colour:

| Tool | Gesture | What it does |
|---|---|---|
| **Arrow** | Drag | Points at something the recorder didn't click |
| **Box** | Drag | Outlines a region |
| **Text** | Click, type, press Enter | Places a label |
| **Numbered badge** | Click | Auto-numbers 1, 2, 3… in placement order |
| **Blur** | Drag | Obscures sensitive information |
| **Select** | Click a shape | Then press `Delete` to remove it |

4. `Ctrl + Z` undoes the last edit; the 🗑️ button clears them all. `Escape` closes the editor.
5. Click **"Apply & Save"**.

### Annotations vs. blur — an important difference

- **Annotations are non-destructive.** They are stored alongside the step, not painted into the screenshot, so you can reopen the editor at any time to change or remove them. They are re-drawn into every export and into the clipboard copy.
- **Blur is permanent.** It is flattened into the stored screenshot on save, because leaving the original pixels in the database would make the redaction cosmetic rather than real. A warning appears next to **Apply & Save** whenever a blur is pending. Before saving, blur can still be undone like any other edit.
- **Smart Blur:** a density-aware algorithm — small regions get more blur passes — so even small text like email addresses is irreversibly obscured.

> Blur is unavailable on guides recorded by very old versions of Steply, whose screenshots are stored in an earlier format. Annotations work on those steps as normal.

---

## Ultimate Single-Click Copy

For ultra-fast sharing, Steply supports an advanced "Copy Step" feature that captures everything in one go.

### How it works:
- Click the **📋 Copy** icon on any step card.
- Steply generates a high-quality annotated image and bundles it with the step text.
- **Pasting:**
    - **Slack/Gmail/Teams:** Pastes the Title, Description, and the Screenshot image together!
    - **Word/Docs:** Perfectly formatted rich-text with embedded image.
    - **Notepad:** Gracefully falls back to plain text instructions.

---

## Bulk Export Manager

Steply includes a powerful Bulk Export feature that allows you to merge multiple guides into a single professional document.

### How to use Bulk Export:
1. Open the **Dashboard**.
2. Click the **"Bulk Export"** button in the sidebar (or **"Exit"** to return to normal mode).
3. **Select Guides:** Click the checkboxes next to the guides you want to include.
4. **Customize Title:** Click the ✏️ icon next to the main title to set a custom name for your merged document.
5. **Reorder:** Drag and drop the selected guides in the sidebar to change their sequence in the final export.
6. **Export:** Use the export dropdown in the top-right to generate your combined PDF, Word, or Markdown file.

> **Standardized Schema:** Every export follows a strict JSON-compatible schema, ensuring consistent descriptions and metadata across all formats.


---

## Resume Recording

You can add more steps to an existing guide at any time:

1. Open the Dashboard
2. Click on the guide you want to extend
3. Click the **▶️ Resume** button in the top-right controls
4. A confirmation message appears
5. Go to any website and continue clicking/interacting
6. Click **"Stop Recording"** in the popup when done
7. Reload the guide in the Dashboard — your new steps will be appended

---

## Keyboard Shortcut

You can open the Steply popup at any time using your keyboard:

- **Shortcut:** `Alt + Shift + G` (Windows, Mac, and Linux)

> **Note:** If the shortcut doesn't work, you can customize it by going to `chrome://extensions/shortcuts` in your browser.

---

## Features Reference

### 🎯 Recording Engine
| Feature | Details |
|---|---|
| **Click tracking** | Captures every button, link, checkbox, dropdown click with a human-readable description |
| **Text input tracking** | Records what the user typed in any field when they leave it (`blur`). Password fields are masked as `••••••••` |
| **Scroll tracking** | Debounced (500ms), captures direction + page position e.g. *"Scrolled down to view more content (now at 45% down the page)"* |
| **Shadow DOM support** | Uses `composedPath()` to track clicks inside complex frameworks (Mendix, Salesforce, etc.) |
| **Interactive Target Detection** | Hardened selector engine climbs the DOM tree to target buttons/links rather than raw icons, ensuring stable CSS selectors. |
| **iframe support** | `all_frames: true` in manifest — works inside embedded iframes |
| **Page navigation resilience** | On every new page load, content script asks the background for its recording state and resumes automatically |
| **Capture Settle Delay** | 150ms delay before screenshot capture to allow hover animations and ripples to complete for cleaner visuals. |

### 📸 Screenshots
| Feature | Details |
|---|---|
| **Auto screenshot** | Captures a JPEG screenshot after every click, scroll, and input step |
| **Red box annotation** | Highlights the exact clicked element with a red rectangle and semi-transparent fill |
| **Accurate red box on export** | Annotation is re-drawn on an offscreen canvas before PDF/Word export so it appears in exported files too |
| **Scroll screenshots** | Shows the page view after the user stops scrolling (no red box) |

### 🗂️ Guide Management
| Feature | Details |
|---|---|
| **Auto guide creation** | A new guide is created automatically when recording starts |
| **Persistent storage** | All guides and steps stored in **IndexedDB** — survives browser restarts |
| **State persistence** | Recording state saved to `chrome.storage.local` — survives Chrome putting the service worker to sleep |
| **Rename guide** | ✏️ Edit button inline in the dashboard — click, type, save |
| **Delete guide** | 🗑️ Delete button with confirmation prompt — removes guide + all its steps |
| **Resume recording** | ▶️ Resume button on any existing guide — appends new steps to it |

### 📤 Exports
| Format | Details |
|---|---|
| **PDF** | All steps with text + annotated screenshots via `jsPDF`, two per page; a figure too tall for a half-page slot is given a page of its own |
| **Word (.docx)** | All steps with embedded annotated images via `docx` library |
| **Markdown (.md)** | Steps with inline base64-embedded annotated screenshots |
| **HTML (.html)** | Self-contained single file with embedded screenshots |
| **JSON (.json)** | Structured bundle including element data and annotations |
| **Bulk Export** | Merge multiple guides into a single document in any of the above formats |

### 📄 Full-Page PDF Capture
| Feature | Details |
|---|---|
| **Scroll and stitch** | The content script scrolls the page; the service worker calls `captureVisibleTab` per screen and stitches the results. Throttled to 600ms because Chrome caps capture at ~2 calls/second |
| **Chunked stitching** | Chrome refuses canvases taller than ~16384px, so the stitch is cut into chunks of 15,000px. Boundaries land on screen boundaries and chunks run end to end in the PDF, so nothing is lost at a seam |
| **Pinned element handling** | `sticky` → `static` (already in flow, so no reflow); `fixed` → hidden after the first screen (out of flow, so hiding cannot reflow). All original inline styles restored afterwards |
| **Memory discipline** | Screens are held as `Blob`s, not base64 strings, during capture — 150 base64 screenshots as JS strings would be hundreds of megabytes |
| **Lazy-load aware** | Page height is re-measured on every screen, so pages that grow as you scroll into them are followed |
| **Capture limits** | 150 screens / 120,000 output pixels. On hitting either, the PDF's last page carries a note saying the capture stopped early |
| **No storage impact** | Writes nothing to IndexedDB; uses no permission beyond the ones recording already needs |


### 🖥️ UI
| Feature | Details |
|---|---|
| **Popup** | Start/Stop recording toggle, live status indicator, recent guides list with step count |
| **Dashboard** | Full React app — sidebar guide list, step timeline, inline step text editing, export controls |
| **Smart captions** | Descriptions are generated from the target element for clicks, and from scroll direction + page position for scroll steps |

---

## Project Structure

```
files/
├── src/                    # Source files (edit these)
│   ├── content.js          # Injected into every web page — tracks clicks, scrolls, inputs,
│   │                       #   and drives scrolling for the full-page capture
│   ├── background.js       # Service worker — manages IndexedDB, screenshots, state,
│   │                       #   and the scroll-and-stitch page capture
│   ├── popup.js            # Popup UI logic (Start/Stop recording, recent guides, page PDF)
│   ├── popup.html          # Popup HTML
│   ├── dashboard.html      # Dashboard HTML entry point
│   ├── Dashboard.jsx       # React dashboard — view, edit, annotate, export guides
│   ├── Dashboard.css       # Dashboard styles
│   ├── capture.html        # "Save current page as PDF" builder page
│   ├── capture.js          # Turns a stitched capture into a multi-page A4 PDF
│   └── privacy.html        # Privacy policy page, opened from the popup
├── images/                 # Extension icons (16 / 48 / 128 px)
├── dist/                   # Built output (load THIS folder in Chrome)
├── manifest.json           # Chrome Extension Manifest V3 config
├── webpack.config.js       # Build configuration with code splitting
├── remove-cdn-loader.js    # Webpack loader — strips a CDN URL out of jsPDF
├── test-extension.js       # Puppeteer smoke test (node test-extension.js)
├── package.json            # Dependencies and build scripts
├── PRIVACY_POLICY.md       # Privacy policy (source of truth for src/privacy.html)
├── STORE_LISTING.md        # Chrome Web Store listing copy
└── README.md               # This file
```

> **Note:** `capture.js` shares the dashboard's `export-libs` chunk so jsPDF isn't bundled
> twice. If you add a new entry point that needs jsPDF, add it to the `splitChunks.chunks`
> predicate in `webpack.config.js` — `popup`, `content` and `background` are deliberately
> excluded because each must be a single self-contained file.

---

## Troubleshooting

### Guide is created but has 0 steps
- **Most likely cause:** You are testing on a Chrome internal page (`chrome://...`). Chrome blocks extensions on these pages.
- **Fix:** Go to a normal website (e.g. `https://google.com`) and test there.
- **Also check:** After reloading the extension, always press **F5** on your test tab to inject the latest content script.

### "db is undefined" or "Cannot read properties of undefined (reading 'transaction')" error
- This is a Chrome Manifest V3 service worker issue — Chrome killed the background worker while idle.
- **Fix:** The extension now handles this automatically using the `dbReady` promise. Simply rebuild and reload the extension.

### Red box not showing on export
- Make sure you have rebuilt (`npm run build`) after the latest fix.
- The annotation is now baked into screenshots via an offscreen canvas before export.

### Steps not capturing after reloading the extension
- After clicking **↻ Reload** in `chrome://extensions/`, always **refresh (F5)** the website tab you are testing on.
- The old content script in open tabs becomes disconnected when the extension reloads.

### Extension not loading (manifest error)
- Make sure you selected the `/dist` folder, not the root project folder.
- Run `npm run build` first — the `/dist` folder must exist.

### "Save current page as PDF" says Chrome doesn't allow capturing this page
- Chrome blocks `captureVisibleTab` on `chrome://` pages, the Chrome Web Store, and the built-in PDF viewer.
- **Fix:** Try it on a normal website. There is no workaround — this is enforced by the browser.

### The PDF's last page says the capture stopped early
- The page exceeded 150 screens or 120,000 output pixels. This is almost always an infinite-scroll feed rather than a document.
- **If you need more:** raise `MAX_CAPTURE_SLICES` / `MAX_TOTAL_PX` in `src/background.js`. Both cost time (600ms per screen) and memory, and produce a longer PDF — the current values are set past the longest real documents.

### A nav bar or cookie banner repeats on every page of the PDF
- Fixed and sticky elements are stripped after the first screen, but a page can pin something in a way that isn't detectable from `getComputedStyle` (for example a JS-repositioned element).
- **Workaround:** dismiss the banner before capturing.

### The page looks wrong after a capture
- The capture temporarily changes `scroll-behavior` and the position of pinned elements, then restores them. Restoration runs in a `finally` block so it happens even if the capture fails.
- **Fix:** refresh the page. Nothing is persisted, so a reload always returns it to normal.

### Capture is slow
- Expected. Chrome rate-limits screen capture to ~2 calls/second, so Steply waits 600ms between screens. A 50-screen page takes ~30 seconds. Lowering the throttle risks `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded` errors and torn captures.

---

## Development Workflow (Quick Reference)

```
1. Edit files in /src
2. Run: npm run build
3. Go to chrome://extensions/
4. Click ↻ Reload on Steply
5. Press F5 on your test website
6. Test your changes
```
