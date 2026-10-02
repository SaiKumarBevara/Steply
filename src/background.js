// ─── Configuration ────────────────────────────────────────────────────────────
const DB_NAME        = 'GuideCapture';
const DB_VERSION     = 2;       // v2 adds separate 'screenshots' object store
const MAX_IMG_WIDTH  = 1280;    // resize screenshots wider than this
const JPEG_QUALITY   = 0.72;    // JPEG compression (0.6–0.8 sweet spot)
const WARN_RATIO     = 0.70;    // warn user at 70 % storage used
const CRITICAL_RATIO = 0.85;    // stop saving at 85 % storage used

let db;
let currentGuide = null;
let isRecording   = false;
let isPaused      = false;
let stepQueue     = [];
let isProcessing  = false;
let isInitializingGuide = false;
let sessionStartStepCount = 0;
let sessionStartTime = null;
// IDs of steps recorded during the current session. Cancel uses this to delete
// exactly what this session added, instead of inferring the set from timestamps
// — dashboard reorder/duplicate/insert rewrite step timestamps to synthetic
// values (createdAt + idx * 10s), so a timestamp cutoff can match steps from
// earlier sessions and destroy them. Empty => fall back to the old cutoff path.
let sessionStepIds = [];
let lastStepInfo  = { action: '', selector: '', timestamp: 0 };
const DEDUPE_MS   = 800;  // Balanced for speed and noise reduction

// ─── IndexedDB Setup ─────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror       = (e) => reject('IndexedDB: ' + e.target.error);
    req.onsuccess     = (e) => { db = e.target.result; resolve(db); };
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('guides'))
        d.createObjectStore('guides', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('steps')) {
        const stepsStore = d.createObjectStore('steps',  { keyPath: 'id' });
        stepsStore.createIndex('guideId', 'guideId', { unique: false });
      }
      // v2 — dedicated Blob store (no base64, no inline data in steps)
      if (!d.objectStoreNames.contains('screenshots')) {
        const ss = d.createObjectStore('screenshots', { keyPath: 'id' });
        ss.createIndex('guideId', 'guideId', { unique: false });
      }
    };
  });
}

// All handlers await this promise before touching db (fixes MV3 race condition).
// IMPORTANT: dbReady must resolve ONLY after currentGuide is fully restored from
// storage + IndexedDB. Previously it resolved right after openDB(), leaving
// currentGuide=null when the service worker restarted after idle termination,
// which caused processStep to create a brand-new guide instead of resuming.
let dbReady = openDB().then(() => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['isRecording', 'activeGuideId', 'isPaused', 'sessionStartStepCount', 'sessionStartTime', 'sessionStepIds'], (res) => {
      if (res.isRecording) isRecording = true;
      if (res.isPaused) isPaused = true;
      if (res.sessionStartStepCount !== undefined) sessionStartStepCount = res.sessionStartStepCount;
      if (res.sessionStartTime !== undefined) sessionStartTime = res.sessionStartTime;
      if (Array.isArray(res.sessionStepIds)) sessionStepIds = res.sessionStepIds;
      if (res.activeGuideId) {
        const tx  = db.transaction(['guides'], 'readonly');
        const req = tx.objectStore('guides').get(res.activeGuideId);
        req.onsuccess = (e) => {
          if (e.target.result) currentGuide = e.target.result;
          resolve(); // resolve only AFTER guide is restored
        };
        req.onerror = () => resolve();
      } else {
        resolve();
      }
    });
  });
}).catch(() => {});

function persistState() {
  chrome.storage.local.set({
    isRecording,
    activeGuideId: currentGuide ? currentGuide.id : null,
    isPaused,
    sessionStartStepCount,
    sessionStartTime,
    sessionStepIds
  });
}

// ─── Storage Quota ───────────────────────────────────────────────────────────
async function checkQuota() {
  if (!navigator.storage?.estimate) return { safe: true, warning: false, critical: false };
  const { usage, quota } = await navigator.storage.estimate();
  const ratio = usage / quota;
  return {
    safe:        ratio < WARN_RATIO,
    warning:     ratio >= WARN_RATIO     && ratio < CRITICAL_RATIO,
    critical:    ratio >= CRITICAL_RATIO,
    usedMB:      (usage / 1048576).toFixed(1),
    quotaMB:     (quota / 1048576).toFixed(1),
    usedPercent: Math.round(ratio * 100)
  };
}

// ─── Image Compression (OffscreenCanvas — no UI thread blocking) ─────────────
// Decoded by hand rather than with fetch(), which MV3's CSP blocks for data URLs.
function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mime  = parts[0].match(/:(.*?);/)[1];
  const bstr  = atob(parts[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

async function compressScreenshot(dataUrl, stepType = 'click') {
  try {
    const inputBlob = dataUrlToBlob(dataUrl);

    const bitmap    = await createImageBitmap(inputBlob);
    let { width, height } = bitmap;
    if (width > MAX_IMG_WIDTH) {
      height = Math.round(height * MAX_IMG_WIDTH / width);
      width  = MAX_IMG_WIDTH;
    }
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    
    // Compression tiers: scrolls need less detail than clicks/inputs
    const quality = stepType === 'scroll' ? JPEG_QUALITY * 0.8 : JPEG_QUALITY;
    
    return await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } catch (e) {
    console.error("STEPLY compressScreenshot ERROR:", e);
    return null;
  }
}

// ─── Full-page capture (scroll and stitch) ───────────────────────────────────
// captureVisibleTab only ever returns the visible area, so a full-page shot means
// scrolling the page a viewport at a time and stitching the slices together. The
// content script does the scrolling; only this side can call captureVisibleTab.
const CAPTURE_THROTTLE_MS = 600;   // captureVisibleTab is quota'd at ~2 calls/second
const MAX_CAPTURE_SLICES  = 150;   // ~90s of throttled capture
const MAX_STITCH_PX       = 15000; // per chunk — Chrome refuses canvases taller than ~16384px
// Across all chunks. Not a technical ceiling — chunking removed that — just the point at
// which an infinite-scroll feed has to be called finished. Set past the longest real
// documents (the longest Wikipedia articles land around 60,000px at this output width),
// and it lines up with the slice cap at a typical viewport, so neither bound surprises
// the other.
const MAX_TOTAL_PX        = 120000;
const CAPTURE_QUALITY     = 0.9;   // higher than JPEG_QUALITY: this image becomes the PDF

// A service worker has no FileReader and OffscreenCanvas has no toDataURL, so the
// stitched image has to be base64'd by hand. Chunked because fromCharCode.apply
// overflows the stack on a multi-megabyte buffer.
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

// Resolves to null instead of rejecting when there's no content script on the tab,
// so a page we can't drive degrades to a viewport capture rather than an error.
function sendToTab(tabId, message, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    setTimeout(() => finish(null), timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, (res) => {
        if (chrome.runtime.lastError) finish(null); else finish(res);
      });
    } catch (e) { finish(null); }
  });
}

function captureVisible(windowId) {
  return Promise.race([
    new Promise(res => {
      chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 90 }, (url) => {
        if (chrome.runtime.lastError) res(null); else res(url);
      });
    }),
    new Promise(res => setTimeout(() => res(null), 4000))
  ]);
}

// Only re-encodes when the capture is wider than the extension's standard width, so a
// 1280-wide viewport shot reaches the PDF as the exact JPEG Chrome handed us.
async function shrinkBlob(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    if (bmp.width <= MAX_IMG_WIDTH) {
      return { dataUrl: await blobToDataUrl(blob), width: bmp.width, height: bmp.height };
    }
    const width  = MAX_IMG_WIDTH;
    const height = Math.max(1, Math.round(bmp.height * width / bmp.width));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bmp, 0, 0, width, height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: CAPTURE_QUALITY });
    return { dataUrl: await blobToDataUrl(out), width, height };
  } finally {
    bmp.close();
  }
}

async function singleViewportShot(tab, fullPage) {
  const url = await captureVisible(tab.windowId);
  if (!url) return null;
  let chunk;
  try {
    chunk = await shrinkBlob(dataUrlToBlob(url));
  } catch (e) {
    // Resizing is an optimisation, not the point — hand back what Chrome captured and
    // let the builder measure it.
    chunk = { dataUrl: url, width: 0, height: 0 };
  }
  return { chunks: [chunk], slices: 1, fullPage, truncated: false };
}

async function captureFullPage(tab) {
  const metrics = await sendToTab(tab.id, { action: 'fullPagePrepare' });

  // No content script, or preparation failed: capture the visible area, which is what
  // the recording path does anyway. A viewport shot beats no shot.
  if (!metrics || !metrics.ok) return singleViewportShot(tab, false);

  try {
    const dpr       = metrics.dpr || 1;
    const viewportH = metrics.viewportH;
    const viewportW = metrics.viewportW || MAX_IMG_WIDTH;
    let pageHeight  = metrics.pageHeight;

    // Page already fits on one screen — nothing to stitch, and it *is* the full page.
    if (!viewportH || pageHeight <= viewportH + 4) return singleViewportShot(tab, true);

    // The stitch is written straight at output scale instead of at device pixels and
    // downscaled afterwards. The device-pixel canvas is what hits Chrome's ~16384px
    // ceiling first — on a 2x display it ran out of room at about seven screens, which
    // is why long pages were coming back truncated — and it costs four times the memory
    // for pixels about to be thrown away. `pxPerCss` is how tall one CSS pixel of page
    // is in the stitched image, which is what bounds how far down we can usefully go.
    const outScale = Math.min(1, MAX_IMG_WIDTH / Math.max(1, Math.round(viewportW * dpr)));
    const pxPerCss = Math.max(0.01, dpr * outScale);
    // Bounded by the whole capture now, not by one canvas — the stitch below is cut into
    // as many canvases as it needs, so Chrome's per-canvas ceiling no longer decides how
    // far down the page we get.
    const maxScrollY = Math.floor(MAX_TOTAL_PX / pxPerCss) - viewportH;

    const slices = [];
    let reachedBottom = false;
    let lastY = -1;
    let y = 0;

    for (let i = 0; i < MAX_CAPTURE_SLICES; i++) {
      // Throttled between captures, not before the first, so a short page stays quick.
      if (i > 0) await new Promise(r => setTimeout(r, CAPTURE_THROTTLE_MS));

      const pos = await sendToTab(tab.id, { action: 'fullPageScroll', y });
      const actualY = pos && typeof pos.y === 'number' ? pos.y : y;
      // Re-measured each slice: lazy-loading pages grow as you scroll into them.
      if (pos && pos.pageHeight) pageHeight = Math.max(pageHeight, pos.pageHeight);

      // The page didn't move, so there is nothing new below. Checked before capturing so
      // a page that clamps or hijacks scrolling costs neither a duplicate slice nor
      // another throttle wait. Only counts as the bottom if we're actually at it —
      // otherwise this is a page we couldn't scroll, and the result is partial.
      if (i > 0 && actualY <= lastY) {
        reachedBottom = actualY + viewportH >= pageHeight - 1;
        break;
      }

      const url = await captureVisible(tab.windowId);
      if (!url) break;
      // Held as a blob, not as the data URL Chrome handed back. A long page is dozens of
      // screens, and a JS string costs two bytes a character — keeping a hundred-odd
      // base64 screenshots as strings is hundreds of megabytes of worker memory, where the
      // same screens as blobs are the size of the JPEGs themselves.
      slices.push({ blob: dataUrlToBlob(url), y: actualY });
      lastY = actualY;

      if (actualY + viewportH >= pageHeight - 1) { reachedBottom = true; break; }
      y = actualY + viewportH;
      // The page is longer than one pass will take, and the PDF says so on its last page.
      if (y > maxScrollY) break;
    }

    if (slices.length === 0) return null;
    if (slices.length === 1) {
      let only;
      try {
        only = await shrinkBlob(slices[0].blob);
      } catch (e) {
        // Resizing is an optimisation; handing back the raw capture beats reporting this
        // as a page Chrome wouldn't let us capture.
        only = { dataUrl: await blobToDataUrl(slices[0].blob), width: 0, height: 0 };
      }
      return { chunks: [only], slices: 1, fullPage: true, truncated: !reachedBottom };
    }

    const probe = await createImageBitmap(slices[0].blob);
    const outW  = Math.max(1, Math.round(probe.width * outScale));
    probe.close();

    const lastTop  = slices[slices.length - 1].y;
    const contentH = Math.min(pageHeight, lastTop + viewportH);

    // Consecutive screens are grouped into chunks no taller than one canvas will go.
    // Chrome refuses anything past ~16384px, and that — not the page — is what stopped
    // a long capture at 27 screens. Each chunk ends exactly where the next begins, on a
    // screen boundary, so the PDF can run them end to end with nothing lost between
    // them. The document was always going to be cut into pages anyway.
    //
    // The screens are spread evenly over the chunks they need rather than packed to the
    // ceiling, because packing leaves the remainder in the last chunk — a chunk holding
    // one screen becomes a PDF page holding one screen.
    const sliceH         = Math.max(1, viewportH * pxPerCss);
    const perChunkCap    = Math.max(1, Math.floor(MAX_STITCH_PX / sliceH));
    const chunkCount     = Math.max(1, Math.ceil(slices.length / perChunkCap));
    const slicesPerChunk = Math.ceil(slices.length / chunkCount);

    const groups = [];
    for (let i = 0; i < slices.length; i += slicesPerChunk) {
      const to = Math.min(i + slicesPerChunk - 1, slices.length - 1);
      groups.push({
        from: i,
        to,
        top: slices[i].y,
        bottom: (to + 1 < slices.length) ? slices[to + 1].y : contentH
      });
    }

    const chunks = [];
    for (const g of groups) {
      const height = Math.max(1, Math.min(Math.round((g.bottom - g.top) * pxPerCss), MAX_STITCH_PX));
      const canvas = new OffscreenCanvas(outW, height);
      const ctx = canvas.getContext('2d');
      for (let i = g.from; i <= g.to; i++) {
        const bmp = await createImageBitmap(slices[i].blob);
        // Drawn in scroll order at each screen's offset within this chunk, so where the
        // last screen of the page overlaps the one above it (a page rarely divides evenly
        // into screens) it simply repaints that band with the same pixels. The extra pixel
        // of height absorbs the rounding between screens, so no hairline of background
        // shows at a seam — the next screen down paints over it.
        ctx.drawImage(
          bmp, 0, Math.round((slices[i].y - g.top) * pxPerCss),
          outW, Math.ceil(bmp.height * outScale) + 1
        );
        bmp.close();
      }
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: CAPTURE_QUALITY });
      chunks.push({ dataUrl: await blobToDataUrl(blob), width: outW, height });
    }

    return { chunks, slices: slices.length, fullPage: true, truncated: !reachedBottom };
  } catch (e) {
    console.error('STEPLY captureFullPage error:', e);
    return null;
  } finally {
    // Always put the page back — scroll position, sticky/fixed elements, scroll-behavior
    // — even if the capture threw halfway through.
    await sendToTab(tab.id, { action: 'fullPageRestore' });
  }
}

// ─── Storage Helpers ─────────────────────────────────────────────────────────
const txPut = (stores, record) => new Promise((resolve, reject) => {
  const tx  = db.transaction(stores, 'readwrite');
  const req = tx.objectStore(Array.isArray(stores) ? stores[0] : stores).put(record);
  req.onsuccess = () => resolve();
  req.onerror   = (e) => reject(e.target.error);
});

const saveGuide      = (g)  => txPut('guides',      g);
const saveStep       = (s)  => txPut('steps',        s);
const saveScreenshot = (ss) => txPut('screenshots',  ss);

// Titles used to be just 'Guide created <timestamp>', which made every row in the
// popup and the sidebar look identical and pushed the only distinguishing part —
// the time — out of the truncated width. Leading with the host makes the list
// scannable; the timestamp stays on the end so two recordings of the same site are
// still tellable apart, and sorting by name still groups by site. Falls back to the
// old format when there's no usable URL (chrome:// pages, unknown sender), so the
// title is never empty. Existing guides keep whatever title they were saved with —
// nothing is renamed or migrated.
function guideTitleFor(url) {
  const stamp = new Date().toLocaleString();
  try {
    const u = new URL(url);
    // Only real web pages give a meaningful host. chrome:// would title a guide
    // "extensions", and recording can be started on such a tab even though Chrome
    // blocks capture there, so those fall back to the old format.
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const host = u.hostname.replace(/^www\./, '');
      if (host) return `${host} · ${stamp}`;
    }
  } catch (e) { /* not a parseable URL — fall through */ }
  return 'Guide created ' + stamp;
}

function getScreenshot(id) {
  return new Promise((resolve) => {
    const tx  = db.transaction(['screenshots'], 'readonly');
    const req = tx.objectStore('screenshots').get(id);
    req.onsuccess = (e) => resolve(e.target.result || null);
    req.onerror   = ()  => resolve(null);
  });
}

function getGuide(guideId) {
  return new Promise((resolve, reject) => {
    let guide = null, steps = [];
    const tx = db.transaction(['guides', 'steps'], 'readonly');
    tx.objectStore('guides').get(guideId).onsuccess = (e) => { guide = e.target.result; };
    // Walk only this guide's steps via the guideId index instead of scanning the
    // whole store. Same records, same order after the sort below — deleteGuide()
    // already reads the steps through this index.
    tx.objectStore('steps').index('guideId').openCursor(IDBKeyRange.only(guideId)).onsuccess = (e) => {
      const c = e.target.result;
      if (c) { steps.push(c.value); c.continue(); }
    };
    tx.oncomplete = () => {
      if (guide) {
        guide.steps = steps.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        resolve(guide);
      } else reject('Guide not found');
    };
    tx.onerror = (e) => reject(e.target.error);
  });
}

function getAllGuides() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(['guides'], 'readonly').objectStore('guides').getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function deleteGuide(guideId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['guides', 'steps', 'screenshots'], 'readwrite');
    tx.objectStore('guides').delete(guideId);

    // Delete all steps for this guide using the guideId index
    const stepsIdx = tx.objectStore('steps').index('guideId');
    stepsIdx.openCursor(IDBKeyRange.only(guideId)).onsuccess = (e) => {
      const c = e.target.result;
      if (c) { c.delete(); c.continue(); }
    };

    // Delete all screenshots for this guide using the guideId index
    const ssIdx = tx.objectStore('screenshots').index('guideId');
    ssIdx.openCursor(IDBKeyRange.only(guideId)).onsuccess = (e) => {
      const c = e.target.result;
      if (c) { c.delete(); c.continue(); }
    };

    tx.oncomplete = () => {
      // If we just deleted the guide that is currently in the active recording slot,
      // clear the background state to prevent orphaned step processing.
      if (currentGuide && currentGuide.id === guideId) {
        currentGuide = null;
        isRecording = false;
        persistState();
        broadcast('stopRecording');
      }
      resolve();
    };
    tx.onerror    = (e) => reject(e.target.error);
  });
}

// ─── LRU Cleanup: remove oldest guide when storage is critical ───────────────
// BUG F: removed the early guides.length <= 1 guard — it prevented cleanup when
// 2 guides exist and one is the current guide. Rely solely on candidates.length.
async function cleanupOldestGuide() {
  const guides = await getAllGuides();
  const candidates = currentGuide
    ? guides.filter(g => g.id !== currentGuide.id)
    : guides;
  if (candidates.length === 0) return false; // nothing safe to delete
  const oldest = candidates.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt))[0];
  await deleteGuide(oldest.id);
  return true;
}

// ─── Broadcast to all tabs ───────────────────────────────────────────────────
function broadcast(action) {
  const payload = typeof action === 'string' ? { action } : action;
  // Send to all open tabs without strict URL check to bypass missing "tabs" permission
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !tabs) return;
    tabs.forEach(t => {
      if (t.id) {
        chrome.tabs.sendMessage(t.id, payload, () => {
          // Suppress errors for tabs without content scripts
          const err = chrome.runtime.lastError;
        });
      }
    });
  });
  // Also send to extension pages (Dashboard/Popup)
  chrome.runtime.sendMessage(payload, () => chrome.runtime.lastError);
}

// ─── Message Router ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  dbReady
    .then(() => handleMessage(message, sender, sendResponse))
    .catch(e => { sendResponse({ error: 'db_not_ready' }); });
  return true;
});

async function handleMessage(message, sender, sendResponse) {

  // ── processStep ────────────────────────────────────────────────────────────
  if (message.action === 'processStep') {
    if (isPaused) {
      sendResponse({ status: 'ignored_paused' });
      return;
    }
    const step = message.step;
    
    // Deduplication logic: ignore rapid identical interactions
    const currentSelector = step.elementData?.selector || '';
    const now = Date.now();
    if (
      step.action === lastStepInfo.action &&
      currentSelector === lastStepInfo.selector &&
      (now - lastStepInfo.timestamp) < DEDUPE_MS
    ) {
      sendResponse({ status: 'ignored_duplicate' });
      return;
    }
    lastStepInfo = { action: step.action, selector: currentSelector, timestamp: now };

    // Add to queue and process
    stepQueue.push({ step, sender, sendResponse });
    processNextStep();
    return;
  }

  // ── getScreenshot (Dashboard requests blob as ArrayBuffer) ─────────────────
  if (message.action === 'getScreenshot') {
    const record = await getScreenshot(message.screenshotId);
    if (!record?.blob) { sendResponse({ error: 'not_found' }); return; }
    const arrayBuffer = await record.blob.arrayBuffer();
    sendResponse({ arrayBuffer, mimeType: 'image/jpeg' });
    return;
  }

  // ── getStorageStats ────────────────────────────────────────────────────────
  if (message.action === 'getStorageStats') {
    const stats = await checkQuota();
    sendResponse({ stats });
    return;
  }

  // ── startRecording ─────────────────────────────────────────────────────────
  if (message.action === 'startRecording') {
    isInitializingGuide = true;
    try {
      const res = await new Promise(r => chrome.storage.local.get(['highlightColor'], r));
      isRecording  = true;
      isPaused     = false;
      chrome.storage.local.set({ isPaused: false });
      currentGuide = {
        id:        'guide_' + Date.now(),
        title:     guideTitleFor(message.url),
        url:       message.url || 'Multiple URLs',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stepCount: 0,
        defaultColor: res.highlightColor || 'red',
        showTimestamp: true,
        timestampPosition: 'bottom_right',
        timestampStyle: 'minimal_black'
      };
      await saveGuide(currentGuide);
      sessionStartStepCount = 0;
      sessionStartTime = Date.now();
      sessionStepIds = [];
      persistState();
      broadcast('startRecording');
      sendResponse({ status: 'started' });
    } catch (e) {
      console.error("STEPLY startRecording ERROR:", e);
      sendResponse({ error: e.toString() });
    } finally {
      isInitializingGuide = false;
      processNextStep(); // flush any queued steps
    }
    return;
  }

  // ── stopRecording ──────────────────────────────────────────────────────────
  if (message.action === 'stopRecording') {
    isRecording  = false;
    isPaused     = false;
    chrome.storage.local.set({ isPaused: false });
    currentGuide = null;
    sessionStepIds = [];
    persistState();
    broadcast('stopRecording');
    sendResponse({ status: 'stopped' });
    return;
  }

  // ── resumeRecording ────────────────────────────────────────────────────────
  if (message.action === 'resumeRecording') {
    isInitializingGuide = true;
    try {
      const guide = await new Promise((resolve, reject) => {
        const tx = db.transaction(['guides'], 'readonly');
        const req = tx.objectStore('guides').get(message.guideId);
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error || new Error('IDB read failed'));
      });

      if (!guide) {
        sendResponse({ error: 'Guide not found' });
        return;
      }

      isRecording  = true;
      currentGuide = guide;
      sessionStartStepCount = guide.stepCount;
      sessionStartTime = Date.now();
      sessionStepIds = [];
      persistState();
      broadcast('startRecording');
      sendResponse({ success: true });
    } catch (e) {
      console.error("STEPLY resumeRecording ERROR:", e);
      sendResponse({ error: e.toString() });
    } finally {
      isInitializingGuide = false;
      processNextStep(); // flush any queued steps
    }
    return;
  }

  // ── getRecordingStatus ─────────────────────────────────────────────────────
  if (message.action === 'getRecordingStatus') {
    sendResponse({ isRecording, isPaused, guideId: currentGuide?.id || null, stepCount: currentGuide?.stepCount || 0 });
    return;
  }

  // ── pauseRecording ─────────────────────────────────────────────────────────
  if (message.action === 'pauseRecording') {
    isPaused = true;
    chrome.storage.local.set({ isPaused: true });
    broadcast('recordingPaused');
    sendResponse({ status: 'paused' });
    return;
  }

  // ── resumeRecordingCurrent ──────────────────────────────────────────────────
  if (message.action === 'resumeRecordingCurrent') {
    isPaused = false;
    chrome.storage.local.set({ isPaused: false });
    broadcast('recordingResumed');
    sendResponse({ status: 'resumed' });
    return;
  }

  // ── getAllGuides ───────────────────────────────────────────────────────────
  if (message.action === 'getAllGuides') {
    getAllGuides()
      .then(guides => sendResponse({ guides }))
      .catch(e    => sendResponse({ error: e.toString() }));
    return;
  }

  // ── getGuide ───────────────────────────────────────────────────────────────
  if (message.action === 'getGuide') {
    getGuide(message.guideId)
      .then(guide => sendResponse({ guide }))
      .catch(e    => sendResponse({ error: e.toString() }));
    return;
  }

  // ── updateStep ─────────────────────────────────────────────────────────────
  if (message.action === 'updateStep') {
    let hasResponded = false;
    const tx  = db.transaction(['steps'], 'readwrite');
    const req = tx.objectStore('steps').get(message.stepId);
    req.onsuccess = (e) => {
      const step = e.target.result;
      if (step) {
        step.action    = message.actionText;
        step.updatedAt = new Date().toISOString();
        tx.objectStore('steps').put(step);
      } else {
        hasResponded = true;
        sendResponse({ error: 'Step not found' });
      }
    };
    tx.oncomplete = () => { if (!hasResponded) sendResponse({ success: true }); };
    tx.onerror = (e) => { if (!hasResponded) sendResponse({ error: e.target.error?.toString() || 'Transaction failed' }); };
    return;
  }

  // ── updateStepDescription ──────────────────────────────────────────────────
  if (message.action === 'updateStepDescription') {
    let hasResponded = false;
    const tx  = db.transaction(['steps'], 'readwrite');
    const req = tx.objectStore('steps').get(message.stepId);
    req.onsuccess = (e) => {
      const step = e.target.result;
      if (step) {
        step.description = message.description;
        step.updatedAt   = new Date().toISOString();
        tx.objectStore('steps').put(step);
      } else {
        hasResponded = true;
        sendResponse({ error: 'Step not found' });
      }
    };
    tx.oncomplete = () => { if (!hasResponded) sendResponse({ success: true }); };
    tx.onerror = (e) => { if (!hasResponded) sendResponse({ error: e.target.error?.toString() || 'Transaction failed' }); };
    return;
  }

  // ── updateGuideTitle ───────────────────────────────────────────────────────
  if (message.action === 'updateGuideTitle') {
    let hasResponded = false;
    const tx  = db.transaction(['guides'], 'readwrite');
    const req = tx.objectStore('guides').get(message.guideId);
    req.onsuccess = (e) => {
      const guide = e.target.result;
      if (guide) {
        guide.title     = message.title;
        guide.updatedAt = new Date().toISOString();
        tx.objectStore('guides').put(guide);
      } else {
        hasResponded = true;
        sendResponse({ error: 'Guide not found' });
      }
    };
    tx.oncomplete = () => { if (!hasResponded) sendResponse({ success: true }); };
    tx.onerror = (e) => { if (!hasResponded) sendResponse({ error: e.target.error?.toString() || 'Transaction failed' }); };
    return;
  }

  // ── cancelRecording ────────────────────────────────────────────────────────
  if (message.action === 'cancelRecording') {
    isRecording = false;
    isPaused = false;
    chrome.storage.local.set({ isPaused: false });

    if (!currentGuide) {
      currentGuide = null;
      sessionStepIds = [];
      persistState();
      broadcast('stopRecording');
      sendResponse({ success: true });
      return;
    }

    const guideIdToDelete = currentGuide.id;

    if (sessionStartStepCount === 0) {
      // Brand new guide, delete entirely
      deleteGuide(guideIdToDelete)
        .then(() => {
          currentGuide = null;
          sessionStepIds = [];
          persistState();
          broadcast('stopRecording');
          sendResponse({ success: true });
        })
        .catch(e => {
          currentGuide = null;
          sessionStepIds = [];
          persistState();
          broadcast('stopRecording');
          sendResponse({ error: e.toString() });
        });
    } else {
      // Existing resumed guide, revert to sessionStartStepCount
      const startTimeCutoff = sessionStartTime;
      // The steps this session actually recorded, when known. If the list is
      // empty — e.g. the extension updated mid-recording, or the session predates
      // this tracking — fall back to the original timestamp cutoff so behaviour
      // is identical to before.
      const sessionIds = (Array.isArray(sessionStepIds) && sessionStepIds.length)
        ? new Set(sessionStepIds)
        : null;

      const tx = db.transaction(['steps', 'screenshots', 'guides'], 'readwrite');
      const stepsStore = tx.objectStore('steps');
      const ssStore = tx.objectStore('screenshots');
      const guidesStore = tx.objectStore('guides');

      // 1. Revert guide step count and update guide in IDB
      currentGuide.stepCount = sessionStartStepCount;
      currentGuide.updatedAt = new Date().toISOString();
      guidesStore.put(currentGuide);

      // 2. Open cursor on steps and delete steps + screenshots after cutoff
      const stepsIdx = stepsStore.index('guideId');
      stepsIdx.openCursor(IDBKeyRange.only(guideIdToDelete)).onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const step = cursor.value;
          let fromThisSession;
          if (sessionIds) {
            fromThisSession = sessionIds.has(step.id);
          } else {
            const stepTime = step.timestamp ? new Date(step.timestamp).getTime() : 0;
            fromThisSession = stepTime >= startTimeCutoff;
          }
          if (fromThisSession) {
            ssStore.delete(step.screenshotId || 'ss_' + step.id);
            cursor.delete();
          }
          cursor.continue();
        }
      };

      tx.oncomplete = () => {
        currentGuide = null;
        sessionStepIds = [];
        persistState();
        broadcast('stopRecording');
        sendResponse({ success: true, revertedTo: sessionStartStepCount });
      };

      tx.onerror = (err) => {
        console.error("Cancel recording transaction error:", err);
        currentGuide = null;
        sessionStepIds = [];
        persistState();
        broadcast('stopRecording');
        sendResponse({ error: 'Failed to revert session steps' });
      };
    }
    return;
  }

  // ── deleteGuide ────────────────────────────────────────────────────────────
  if (message.action === 'deleteGuide') {
    deleteGuide(message.guideId)
      .then(() => sendResponse({ success: true }))
      .catch(e  => sendResponse({ error: e.toString() }));
    return;
  }

  // ── deleteStep ─────────────────────────────────────────────────────────────
  if (message.action === 'deleteStep') {
    let hasResponded = false;
    const tx = db.transaction(['steps', 'screenshots', 'guides'], 'readwrite');
    const stepsStore = tx.objectStore('steps');
    const ssStore    = tx.objectStore('screenshots');
    const guideStore = tx.objectStore('guides');

    stepsStore.get(message.stepId).onsuccess = (e) => {
      const step = e.target.result;
      if (!step) {
        hasResponded = true;
        sendResponse({ error: 'Step not found' });
        return;
      }

      const guideId = step.guideId;
      const ssId    = step.screenshotId;

      // 1. Delete the step
      stepsStore.delete(message.stepId);

      // Recount the guide's remaining steps instead of decrementing the stored
      // counter. Issued after the delete above, so it reflects the post-delete
      // state. A counter that has already drifted (interrupted session, older
      // build) can never recover from `stepCount - 1`, which is what makes the
      // sidebar's "N steps" disagree with the step list even after a refresh.
      const remainingReq = stepsStore.index('guideId').count(IDBKeyRange.only(guideId));

      // 2. Handle screenshot deletion and guide updates
      if (ssId) {
        ssStore.get(ssId).onsuccess = (e2) => {
          const ss = e2.target.result;
          const ssSize = ss?.blob?.size || 0;
          ssStore.delete(ssId);

          guideStore.get(guideId).onsuccess = (e3) => {
            const guide = e3.target.result;
            if (guide) {
              guide.stepCount = typeof remainingReq.result === 'number'
                ? remainingReq.result
                : Math.max(0, guide.stepCount - 1);
              guide.storageBytes = Math.max(0, (guide.storageBytes || 0) - ssSize);
              guide.updatedAt = new Date().toISOString();
              guideStore.put(guide);
            }
          };
        };
      } else {
        guideStore.get(guideId).onsuccess = (e3) => {
          const guide = e3.target.result;
          if (guide) {
            guide.stepCount = typeof remainingReq.result === 'number'
              ? remainingReq.result
              : Math.max(0, guide.stepCount - 1);
            guide.updatedAt = new Date().toISOString();
            guideStore.put(guide);
          }
        };
      }
    };

    tx.oncomplete = () => { if (!hasResponded) sendResponse({ success: true }); };
    tx.onerror    = (e) => { if (!hasResponded) sendResponse({ error: e.target.error?.toString() || 'Transaction failed' }); };
    return;
  }

  // ── updateGuideColor ───────────────────────────────────────────────────────
  if (message.action === 'updateGuideColor') {
    let hasResponded = false;
    const tx  = db.transaction(['guides'], 'readwrite');
    const req = tx.objectStore('guides').get(message.guideId);
    req.onsuccess = (e) => {
      const guide = e.target.result;
      if (guide) {
        guide.defaultColor = message.color;
        tx.objectStore('guides').put(guide);
      } else {
        hasResponded = true;
        sendResponse({ error: 'Guide not found' });
      }
    };
    tx.oncomplete = () => { if (!hasResponded) sendResponse({ success: true }); };
    tx.onerror = (e) => { if (!hasResponded) sendResponse({ error: e.target.error?.toString() || 'Transaction failed' }); };
    return;
  }

  // ── updateGuideTimestampOptions ───────────────────────────────────────────
  if (message.action === 'updateGuideTimestampOptions') {
    let hasResponded = false;
    const tx  = db.transaction(['guides'], 'readwrite');
    const req = tx.objectStore('guides').get(message.guideId);
    req.onsuccess = (e) => {
      const guide = e.target.result;
      if (guide) {
        if (message.showTimestamp !== undefined) guide.showTimestamp = message.showTimestamp;
        if (message.timestampPosition !== undefined) guide.timestampPosition = message.timestampPosition;
        if (message.timestampStyle !== undefined) guide.timestampStyle = message.timestampStyle;
        tx.objectStore('guides').put(guide);
      } else {
        hasResponded = true;
        sendResponse({ error: 'Guide not found' });
      }
    };
    tx.oncomplete = () => { if (!hasResponded) sendResponse({ success: true }); };
    tx.onerror = (e) => { if (!hasResponded) sendResponse({ error: e.target.error?.toString() || 'Transaction failed' }); };
    return;
  }

  // ── updateStepColor ────────────────────────────────────────────────────────
  if (message.action === 'updateStepColor') {
    let hasResponded = false;
    const tx  = db.transaction(['steps'], 'readwrite');
    const req = tx.objectStore('steps').get(message.stepId);
    req.onsuccess = (e) => {
      const step = e.target.result;
      if (step) {
        step.color = message.color;
        tx.objectStore('steps').put(step);
      } else {
        hasResponded = true;
        sendResponse({ error: 'Step not found' });
      }
    };
    tx.oncomplete = () => { if (!hasResponded) sendResponse({ success: true }); };
    tx.onerror = (e) => { if (!hasResponded) sendResponse({ error: e.target.error?.toString() || 'Transaction failed' }); };
    return;
  }

  // ── updateStepAnnotations ──────────────────────────────────────────────────
  // Manual markup (arrows/boxes/text/badges) stored as a plain array on the step.
  // Optional field: steps saved before this existed simply have none, so no
  // schema change or migration is involved.
  if (message.action === 'updateStepAnnotations') {
    let hasResponded = false;
    const tx  = db.transaction(['steps'], 'readwrite');
    const req = tx.objectStore('steps').get(message.stepId);
    req.onsuccess = (e) => {
      const step = e.target.result;
      if (step) {
        step.annotations = Array.isArray(message.annotations) ? message.annotations : [];
        tx.objectStore('steps').put(step);
      } else {
        hasResponded = true;
        sendResponse({ error: 'Step not found' });
      }
    };
    tx.oncomplete = () => { if (!hasResponded) sendResponse({ success: true }); };
    tx.onerror = (e) => { if (!hasResponded) sendResponse({ error: e.target.error?.toString() || 'Transaction failed' }); };
    return;
  }

  // ── Capture the current page and hand it to the PDF builder ─────────────────
  // Deliberately standalone: it never reads or writes `currentGuide`, `isRecording`,
  // `sessionStepIds` or the step queue, so using it during a recording cannot disturb
  // that recording. It writes nothing to IndexedDB either — the capture leaves the
  // browser as a PDF file and is not kept as a guide — so recorded guides, stored
  // screenshots and the storage quota are all untouched by it. It also uses no
  // permission the extension doesn't already have; captureVisibleTab is the same call
  // the recording path makes, and activeTab is granted by the user opening the popup.
  if (message.action === 'capturePage') {
    try {
      const tab = await new Promise(r =>
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => r(tabs && tabs[0]))
      );
      if (!tab || !tab.id) { sendResponse({ error: 'no_tab' }); return; }

      // Drop any earlier hand-off before starting, so an abandoned capture can't sit in
      // storage.local alongside this one.
      await chrome.storage.local.remove('steplyPendingCapture');

      // Hide the recording HUD if one is up so it isn't baked into the capture.
      // Best-effort — there may be no content script on this tab at all.
      await new Promise((res) => {
        chrome.tabs.sendMessage(tab.id, { action: 'hideHUD' }, () => {
          if (chrome.runtime.lastError) {}
          res();
        });
      });
      await new Promise(r => setTimeout(r, 150));

      // Full page where possible; falls back to the visible area when the page can't be
      // driven (no content script, a single-screen page, or anything going wrong).
      const shot = await captureFullPage(tab);

      chrome.tabs.sendMessage(tab.id, { action: 'showHUD' }, () => {
        if (chrome.runtime.lastError) {}
      });

      // Nothing is handed on until the capture has succeeded, so a page Chrome refuses
      // to capture (chrome://, the Web Store, the PDF viewer) can't open a builder tab
      // with nothing in it.
      if (!shot || !shot.chunks || !shot.chunks.length) { sendResponse({ error: 'capture_blocked' }); return; }

      // Handed over through storage.local rather than inside a message: the stitched
      // JPEG is megabytes of base64, and the builder page wants it the moment it loads
      // rather than having to ask for it. That page removes the key once it has read it.
      try {
        await chrome.storage.local.set({
          steplyPendingCapture: {
            // One entry per canvas the stitch needed; the builder runs them end to end.
            chunks:     shot.chunks,
            pageUrl:    tab.url || '',
            pageTitle:  tab.title || '',
            capturedAt: new Date().toISOString(),
            screens:    shot.slices,
            // Carried through to the PDF's last page, so a page longer than one pass
            // can hold is never passed off as the whole thing.
            truncated:  !!shot.truncated
          }
        });
      } catch (e) {
        console.error('STEPLY capturePage handoff failed:', e);
        sendResponse({ error: 'storage_full' });
        return;
      }

      // Opened from here rather than from the popup because the popup closes the moment
      // the user clicks the page, and on a long capture that happens well before the
      // screenshots are finished. The service worker is still around either way.
      chrome.tabs.create({ url: chrome.runtime.getURL('capture.html') });
      sendResponse({ success: true, screens: shot.slices, truncated: !!shot.truncated });
    } catch (e) {
      console.error('STEPLY capturePage error:', e);
      sendResponse({ error: e.toString() });
    }
    return;
  }
}



async function processNextStep() {
  if (isProcessing || stepQueue.length === 0 || isInitializingGuide) return;
  isProcessing = true;

  const { step, sender, sendResponse } = stepQueue.shift();

  try {
    // 1. Quota check
    const quota = await checkQuota();
    if (quota.critical) {
      const cleaned = await cleanupOldestGuide();
      if (!cleaned) { sendResponse({ error: 'storage_full', quota }); return; }
      const after = await checkQuota();
      if (after.critical) { sendResponse({ error: 'storage_full', quota: after }); return; }
    }

    // 2. Ensure active guide exists
    if (!currentGuide) {
      const res = await new Promise(r => chrome.storage.local.get(['highlightColor'], r));
      currentGuide = {
        id:        'guide_' + Date.now(),
        title:     guideTitleFor(sender.tab?.url),
        url:       sender.tab?.url || 'Unknown URL',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stepCount: 0,
        defaultColor: res.highlightColor || 'red',
        showTimestamp: true,
        timestampPosition: 'bottom_right',
        timestampStyle: 'minimal_black'
      };
      await saveGuide(currentGuide);
      persistState();
    }

    step.id          = Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    step.guideId     = currentGuide.id;
    currentGuide.stepCount += 1;
    currentGuide.updatedAt  = new Date().toISOString();

    // 4. Capture → compress → store
    const windowId = sender.tab ? sender.tab.windowId : null;
    
    if (sender.tab && sender.tab.id) {
      try {
        await new Promise((res) => {
          chrome.tabs.sendMessage(sender.tab.id, { action: 'hideHUD' }, () => {
            if (chrome.runtime.lastError) {}
            res();
          });
        });
      } catch (err) {}
    }

    // MICRO-FIX: Wait 150ms for UI transitions (like button ripples or hover effects) 
    // to settle before capturing. This produces cleaner screenshots.
    await new Promise(r => setTimeout(r, 150));

    const dataUrl = await Promise.race([
      new Promise(res => {
        chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 90 }, (url) => {
          if (chrome.runtime.lastError) res(null); else res(url);
        });
      }),
      new Promise(res => setTimeout(() => res(null), 3000))
    ]);

    if (sender.tab && sender.tab.id) {
      try {
        chrome.tabs.sendMessage(sender.tab.id, { action: 'showHUD' }, () => {
          if (chrome.runtime.lastError) {}
        });
      } catch (err) {}
    }

    if (dataUrl) {
      const blob = await compressScreenshot(dataUrl, step.stepType);
      if (blob) {
        const ssId = 'ss_' + step.id;
        await saveScreenshot({ id: ssId, guideId: currentGuide.id, blob });
        step.screenshotId = ssId;
        currentGuide.storageBytes = (currentGuide.storageBytes || 0) + blob.size;
      }
    }

    await Promise.all([saveStep(step), saveGuide(currentGuide)]);

    // Record the step for cancelRecording. Deleting by the IDs this session
    // actually created is exact; the timestamp cutoff it falls back to can match
    // steps from earlier sessions, because a dashboard reorder/duplicate/insert
    // rewrites step timestamps to synthetic values.
    sessionStepIds.push(step.id);
    persistState();

    broadcast({ action: 'processStep', step, guideId: currentGuide.id });
    
    try {
      sendResponse({ success: true, stepId: step.id, stepCount: currentGuide.stepCount });
    } catch (_) {}

  } catch (e) {
    console.error("STEPLY FATAL ERROR:", e, e.stack);
    try {
      sendResponse({ error: e.toString() });
    } catch (_) {}
  } finally {
    isProcessing = false;
    processNextStep();
  }
}
