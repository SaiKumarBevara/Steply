// ─── Configuration ────────────────────────────────────────────────────────────
const DB_NAME        = 'GuideCapture';
const DB_VERSION     = 2;       // v2 adds separate 'screenshots' object store
const MAX_STEPS      = 100;     // max steps per guide before recording is paused
const MAX_IMG_WIDTH  = 1280;    // resize screenshots wider than this
const JPEG_QUALITY   = 0.72;    // JPEG compression (0.6–0.8 sweet spot)
const WARN_RATIO     = 0.70;    // warn user at 70 % storage used
const CRITICAL_RATIO = 0.85;    // stop saving at 85 % storage used

let db;
let currentGuide = null;
let isRecording   = false;
let stepQueue     = [];
let isProcessing  = false;
let isInitializingGuide = false;
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
    chrome.storage.local.get(['isRecording', 'activeGuideId'], (res) => {
      if (res.isRecording) isRecording = true;
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
    activeGuideId: currentGuide ? currentGuide.id : null
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
async function compressScreenshot(dataUrl, stepType = 'click') {
  try {
    // Decode base64 data URL synchronously to prevent MV3 fetch CSP errors
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    const inputBlob = new Blob([u8arr], { type: mime });

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
    tx.objectStore('steps').openCursor().onsuccess  = (e) => {
      const c = e.target.result;
      if (c) { if (c.value.guideId === guideId) steps.push(c.value); c.continue(); }
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
      currentGuide = {
        id:        'guide_' + Date.now(),
        title:     'Guide created ' + new Date().toLocaleString(),
        url:       message.url || 'Multiple URLs',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stepCount: 0,
        defaultColor: res.highlightColor || 'red',
        showTimestamp: false
      };
      await saveGuide(currentGuide);
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
    currentGuide = null;
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
    sendResponse({ isRecording, guideId: currentGuide?.id || null });
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

      // 2. Handle screenshot deletion and guide updates
      if (ssId) {
        ssStore.get(ssId).onsuccess = (e2) => {
          const ss = e2.target.result;
          const ssSize = ss?.blob?.size || 0;
          ssStore.delete(ssId);

          guideStore.get(guideId).onsuccess = (e3) => {
            const guide = e3.target.result;
            if (guide) {
              guide.stepCount = Math.max(0, guide.stepCount - 1);
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
            guide.stepCount = Math.max(0, guide.stepCount - 1);
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

  // ── updateGuideTimestamp ───────────────────────────────────────────────────
  if (message.action === 'updateGuideTimestamp') {
    let hasResponded = false;
    const tx  = db.transaction(['guides'], 'readwrite');
    const req = tx.objectStore('guides').get(message.guideId);
    req.onsuccess = (e) => {
      const guide = e.target.result;
      if (guide) {
        guide.showTimestamp = message.showTimestamp;
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
        title:     'Guide created ' + new Date().toLocaleString(),
        url:       sender.tab?.url || 'Unknown URL',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stepCount: 0,
        defaultColor: res.highlightColor || 'red',
        showTimestamp: false
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
    broadcast({ action: 'processStep', step, guideId: currentGuide.id });
    
    try {
      sendResponse({ success: true, stepId: step.id });
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
