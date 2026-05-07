# Steply — Chrome Extension

> Auto-generate step-by-step guides by recording your browser interactions. Captures clicks, text inputs, scrolls, and screenshots — then exports to PDF, Word, or Markdown.

---

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Project Setup](#project-setup)
3. [Build the Extension](#build-the-extension)
4. [Load the Extension in Chrome](#load-the-extension-in-chrome)
5. [How to Record a Guide](#how-to-record-a-guide)
6. [Using the Dashboard](#using-the-dashboard)
7. [Exporting a Guide](#exporting-a-guide)
8. [Resume Recording (Add Steps to Existing Guide)](#resume-recording)
9. [Features Reference](#features-reference)
10. [Project Structure](#project-structure)
11. [Troubleshooting](#troubleshooting)

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
   cd C:\Users\SaikumarBevara\Downloads\files
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
   C:\Users\SaikumarBevara\Downloads\files\dist
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
- **Scrolling** — when you scroll up, down, left, or right by more than 80px
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

Open a guide in the Dashboard, then use the export buttons in the top-right:

| Button | Output | Contains |
|---|---|---|
| **Export PDF** | `.pdf` file | All steps with annotated screenshots |
| **Export Word** | `.docx` file | All steps with embedded annotated images |
| **Export Markdown** | `.md` file | All steps with inline base64 screenshots |

> **Annotated screenshots:** All exports include the red highlight box drawn over the clicked element — identical to what you see in the dashboard.

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

## Features Reference

### 🎯 Recording Engine
| Feature | Details |
|---|---|
| **Click tracking** | Captures every button, link, checkbox, dropdown click with a human-readable description |
| **Text input tracking** | Records what the user typed in any field when they leave it (`blur`). Password fields are masked as `••••••••` |
| **Scroll tracking** | Debounced (800ms), captures direction + page position e.g. *"Scrolled down to view more content (now at 45% down the page)"* |
| **Shadow DOM support** | Uses `composedPath()` to track clicks inside complex frameworks (Mendix, Salesforce, etc.) |
| **iframe support** | `all_frames: true` in manifest — works inside embedded iframes |
| **Page navigation resilience** | On every new page load, content script asks the background for its recording state and resumes automatically |

### 📸 Screenshots
| Feature | Details |
|---|---|
| **Auto screenshot** | Captures a JPEG screenshot after every click, scroll, and input step |
| **Red box annotation** | Highlights the exact clicked element with a red rectangle and semi-transparent fill |
| **Accurate red box on export** | Annotation is re-drawn on an offscreen canvas before PDF/Word export so it appears in exported files too |
| **Scroll screenshots** | Shows the page view after the user stops scrolling (no red box, captioned *"Page view after scrolling"*) |

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
| **PDF** | All steps with text + annotated screenshots via `jsPDF` |
| **Word (.docx)** | All steps with embedded annotated images via `docx` library |
| **Markdown (.md)** | Steps with inline base64-embedded annotated screenshots |

### 🖥️ UI
| Feature | Details |
|---|---|
| **Popup** | Start/Stop recording toggle, live status indicator, recent guides list with step count |
| **Dashboard** | Full React app — sidebar guide list, step timeline, inline step text editing, export controls |
| **Smart captions** | *"Red box highlights the clicked element"* for clicks, *"Page view after scrolling"* for scroll steps |

---

## Project Structure

```
files/
├── src/                    # Source files (edit these)
│   ├── content.js          # Injected into every web page — tracks clicks, scrolls, inputs
│   ├── background.js       # Service worker — manages IndexedDB, screenshots, state
│   ├── popup.js            # Popup UI logic (Start/Stop recording, recent guides)
│   ├── popup.html          # Popup HTML
│   ├── dashboard.html      # Dashboard HTML entry point
│   ├── Dashboard.jsx       # React dashboard — view, edit, export guides
│   └── Dashboard.css       # Dashboard styles
├── dist/                   # Built output (load THIS folder in Chrome)
├── manifest.json           # Chrome Extension Manifest V3 config
├── webpack.config.js       # Build configuration with code splitting
├── package.json            # Dependencies and build scripts
└── README.md               # This file
```

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
