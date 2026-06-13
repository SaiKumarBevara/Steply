console.log("[Steply] Content script loaded successfully on:", window.location.href);

let isRecording = false;
let isPaused = false;
let activeGuideId = null;
let currentStepCount = 0;
let hudElement = null;
let isHudClosedSession = false;
let lastScrollY = window.scrollY;
let lastScrollX = window.scrollX;

// SCOPED HUD STYLES
const hudStyle = document.createElement('style');
hudStyle.textContent = `
  @keyframes steply-pulse {
    0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
    70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
    100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
  }
  .steply-hud {
    all: initial !important;
    position: fixed !important;
    z-index: 2147483647 !important;
    background: #ffffff !important;
    border: 1.5px solid #60a5fa !important;
    border-radius: 99px !important;
    padding: 8px 14px !important;
    display: flex !important;
    align-items: center !important;
    gap: 12px !important;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08) !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    font-size: 13px !important;
    color: #1f2937 !important;
    user-select: none !important;
    transition: opacity 0.2s ease !important;
    box-sizing: border-box !important;
    width: auto !important;
    height: auto !important;
    min-width: 0 !important;
    min-height: 0 !important;
    max-width: none !important;
    max-height: none !important;
    margin: 0 !important;
  }
  .steply-hud-drag-handle {
    all: initial !important;
    display: flex !important;
    align-items: center !important;
    cursor: grab !important;
    padding: 2px !important;
    box-sizing: border-box !important;
    width: auto !important;
    height: auto !important;
    margin: 0 !important;
  }
  .steply-hud-drag-handle svg {
    all: initial !important;
    width: 12px !important;
    height: 18px !important;
    display: block !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  .steply-hud-pulse {
    all: initial !important;
    display: block !important;
    width: 8px !important;
    height: 8px !important;
    background: #ef4444 !important;
    border-radius: 50% !important;
    animation: steply-pulse 1.5s infinite !important;
    flex-shrink: 0 !important;
    box-sizing: border-box !important;
    margin: 0 !important;
  }
  .steply-hud-text {
    all: initial !important;
    display: inline-block !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    font-size: 13px !important;
    color: #1f2937 !important;
    font-weight: 500 !important;
    white-space: nowrap !important;
    user-select: none !important;
    box-sizing: border-box !important;
    width: auto !important;
    height: auto !important;
    margin: 0 !important;
  }
  .steply-hud-divider {
    all: initial !important;
    display: block !important;
    width: 1px !important;
    height: 16px !important;
    background: #e5e7eb !important;
    box-sizing: border-box !important;
    margin: 0 !important;
  }
  .steply-hud-btn {
    all: initial !important;
    border: none !important;
    background: none !important;
    cursor: pointer !important;
    padding: 5px !important;
    border-radius: 50% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    transition: background 0.15s, color 0.15s !important;
    color: #6b7280 !important;
    width: 24px !important;
    height: 24px !important;
    box-sizing: border-box !important;
    margin: 0 !important;
  }
  .steply-hud-btn svg {
    all: initial !important;
    width: 12px !important;
    height: 12px !important;
    display: block !important;
    fill: currentColor !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  .steply-hud-btn.btn-cancel svg {
    width: 13px !important;
    height: 13px !important;
    fill: none !important;
    stroke: currentColor !important;
  }
  .steply-hud-btn:hover {
    background: #f3f4f6 !important;
    color: #111827 !important;
  }
  .steply-hud-btn.btn-stop:hover {
    background: #fef2f2 !important;
    color: #ef4444 !important;
  }
  .steply-hud-btn.btn-cancel:hover {
    background: #fef2f2 !important;
    color: #dc2626 !important;
  }
  .steply-toast {
    all: initial !important;
    position: fixed !important;
    z-index: 2147483647 !important;
    background: #10b981 !important;
    color: #ffffff !important;
    padding: 10px 16px !important;
    border-radius: 8px !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
    font-size: 12px !important;
    font-weight: 500 !important;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15) !important;
    transform: translateY(10px) !important;
    opacity: 0 !important;
    transition: all 0.2s ease-out !important;
    pointer-events: none !important;
    box-sizing: border-box !important;
    width: auto !important;
    height: auto !important;
    min-width: 0 !important;
    min-height: 0 !important;
    max-width: none !important;
    max-height: none !important;
    margin: 0 !important;
  }
  .steply-toast.show {
    transform: translateY(0) !important;
    opacity: 1 !important;
  }
`;
if (document.head) {
  document.head.appendChild(hudStyle);
} else {
  document.documentElement.appendChild(hudStyle);
}

function safeAppendToBody(el) {
  if (document.body) {
    document.body.appendChild(el);
  } else {
    const observer = new MutationObserver((mutations, obs) => {
      if (document.body) {
        document.body.appendChild(el);
        obs.disconnect();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}

function syncRecordingState() {
  chrome.runtime.sendMessage({ action: 'getRecordingStatus' }, (res) => {
    if (res) {
      isRecording = !!res.isRecording;
      isPaused = !!res.isPaused;
      activeGuideId = res.guideId;
      currentStepCount = res.stepCount || 0;
      updateHUD();
    }
  });
}

syncRecordingState();

// Listen for storage changes to handle Service Worker reloads/restarts
chrome.storage.onChanged.addListener((changes) => {
  if (changes.isRecording || changes.isPaused) {
    if (changes.isRecording) {
      isRecording = changes.isRecording.newValue;
      if (!isRecording) {
        isHudClosedSession = false;
      }
    }
    if (changes.isPaused) {
      isPaused = changes.isPaused.newValue;
    }
    syncRecordingState();
  }
});

// Listen for messages from the background service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startRecording') {
    isRecording = true;
    isPaused = false;
    isHudClosedSession = false;
    lastScrollY = window.scrollY;
    lastScrollX = window.scrollX;
    syncRecordingState();
    sendResponse({ status: 'started' });
  } else if (request.action === 'stopRecording') {
    isRecording = false;
    isPaused = false;
    isHudClosedSession = false;
    updateHUD();
    sendResponse({ status: 'stopped' });
  } else if (request.action === 'recordingPaused') {
    isPaused = true;
    updateHUD();
  } else if (request.action === 'recordingResumed') {
    isPaused = false;
    updateHUD();
  }
});

function updateHUD() {
  if (isRecording && !isHudClosedSession) {
    if (!hudElement) {
      createHUD();
    }
    const textNode = hudElement.querySelector('.steply-hud-text');
    if (textNode) {
      const statusText = isPaused ? 'Paused' : 'Recording';
      textNode.textContent = `${statusText}... (${currentStepCount} step${currentStepCount === 1 ? '' : 's'})`;
    }
    const pulseDot = hudElement.querySelector('.steply-hud-pulse');
    if (pulseDot) {
      if (isPaused) {
        pulseDot.style.background = '#9ca3af';
        pulseDot.style.animation = 'none';
      } else {
        pulseDot.style.background = '#ef4444';
        pulseDot.style.animation = 'steply-pulse 1.5s infinite';
      }
    }
    const pauseBtn = hudElement.querySelector('.btn-pause');
    if (pauseBtn) {
      if (isPaused) {
        pauseBtn.title = 'Resume Recording';
        pauseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
      } else {
        pauseBtn.title = 'Pause Recording';
        pauseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
      }
    }
  } else {
    if (hudElement) {
      hudElement.remove();
      hudElement = null;
    }
  }
}

function createHUD() {
  hudElement = document.createElement('div');
  hudElement.className = 'steply-hud';
  hudElement.innerHTML = `
    <div class="steply-hud-drag-handle" title="Drag to reposition">
      <svg width="12" height="18" viewBox="0 0 12 18" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round"><circle cx="2.5" cy="3" r="1"/><circle cx="2.5" cy="9" r="1"/><circle cx="2.5" cy="15" r="1"/><circle cx="9.5" cy="3" r="1"/><circle cx="9.5" cy="9" r="1"/><circle cx="9.5" cy="15" r="1"/></svg>
    </div>
    <div class="steply-hud-pulse"></div>
    <span class="steply-hud-text">Recording... (0 steps)</span>
    <div class="steply-hud-divider"></div>
    <button class="steply-hud-btn btn-pause" title="Pause Recording">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
    </button>
    <button class="steply-hud-btn btn-stop" title="Stop & Save Recording">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
    </button>
    <button class="steply-hud-btn btn-cancel" title="Cancel & Delete Recording">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
    </button>
    <button class="steply-hud-btn btn-close" title="Hide HUD (keeps recording)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;

  // Restore position if saved
  const savedLeft = sessionStorage.getItem('steply_hud_left');
  const savedTop = sessionStorage.getItem('steply_hud_top');
  if (savedLeft && savedTop) {
    hudElement.style.setProperty('bottom', 'auto', 'important');
    hudElement.style.setProperty('right', 'auto', 'important');
    hudElement.style.setProperty('left', savedLeft, 'important');
    hudElement.style.setProperty('top', savedTop, 'important');
  } else {
    hudElement.style.setProperty('bottom', '20px', 'important');
    hudElement.style.setProperty('right', '20px', 'important');
    hudElement.style.setProperty('left', 'auto', 'important');
    hudElement.style.setProperty('top', 'auto', 'important');
  }

  // Button actions
  hudElement.querySelector('.btn-pause').addEventListener('click', () => {
    if (isPaused) {
      chrome.runtime.sendMessage({ action: 'resumeRecordingCurrent' });
    } else {
      chrome.runtime.sendMessage({ action: 'pauseRecording' });
    }
  });

  hudElement.querySelector('.btn-stop').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopRecording' });
  });

  hudElement.querySelector('.btn-cancel').addEventListener('click', () => {
    if (confirm('Cancel and delete this recording?')) {
      chrome.runtime.sendMessage({ action: 'stopRecording' }, () => {
        if (activeGuideId) {
          chrome.runtime.sendMessage({ action: 'deleteGuide', guideId: activeGuideId });
        }
      });
    }
  });

  hudElement.querySelector('.btn-close').addEventListener('click', () => {
    isHudClosedSession = true;
    updateHUD();
  });

  // Drag and drop implementation
  let isDragging = false;
  let startX = 0, startY = 0;
  let initialLeft = 0, initialTop = 0;
  const dragHandle = hudElement.querySelector('.steply-hud-drag-handle');

  dragHandle.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragHandle.style.cursor = 'grabbing';
    startX = e.clientX;
    startY = e.clientY;
    const rect = hudElement.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    
    hudElement.style.setProperty('bottom', 'auto', 'important');
    hudElement.style.setProperty('right', 'auto', 'important');
    hudElement.style.setProperty('left', initialLeft + 'px', 'important');
    hudElement.style.setProperty('top', initialTop + 'px', 'important');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let left = initialLeft + dx;
    let top = initialTop + dy;
    
    const maxLeft = window.innerWidth - hudElement.offsetWidth - 10;
    const maxTop = window.innerHeight - hudElement.offsetHeight - 10;
    left = Math.max(10, Math.min(left, maxLeft));
    top = Math.max(10, Math.min(top, maxTop));
    
    hudElement.style.setProperty('left', left + 'px', 'important');
    hudElement.style.setProperty('top', top + 'px', 'important');
    
    sessionStorage.setItem('steply_hud_left', left + 'px');
    sessionStorage.setItem('steply_hud_top', top + 'px');
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      dragHandle.style.cursor = 'grab';
    }
  });

  safeAppendToBody(hudElement);
}

function showToast(messageText) {
  let toast = document.getElementById('steply-toast-element');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'steply-toast-element';
    toast.className = 'steply-toast';
    safeAppendToBody(toast);
  }
  
  toast.textContent = messageText;
  
  if (hudElement) {
    const hudRect = hudElement.getBoundingClientRect();
    toast.style.setProperty('bottom', 'auto', 'important');
    toast.style.setProperty('right', 'auto', 'important');
    toast.style.setProperty('left', Math.max(10, hudRect.right - 220) + 'px', 'important');
    toast.style.setProperty('top', Math.max(10, hudRect.top - 46) + 'px', 'important');
  } else {
    toast.style.setProperty('bottom', '20px', 'important');
    toast.style.setProperty('right', '20px', 'important');
    toast.style.setProperty('top', 'auto', 'important');
    toast.style.setProperty('left', 'auto', 'important');
  }
  
  // Reset opacity/display state classes
  toast.classList.remove('show');
  void toast.offsetWidth; // trigger reflow
  toast.classList.add('show');
  
  // Clear any existing timeout
  if (window.steplyToastTimeout) clearTimeout(window.steplyToastTimeout);
  window.steplyToastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 2200);
}


// Helper: generate unique CSS selector
function getCSSSelector(el) {
  if (!(el instanceof Element)) return '';
  
  // Prioritize robust attributes that are unlikely to change
  const robustAttrs = ['data-testid', 'data-qa', 'data-cy', 'aria-label', 'id'];
  for (const attr of robustAttrs) {
    const val = el.getAttribute(attr);
    if (val) {
      if (attr === 'id') return '#' + val;
      return `[${attr}="${val}"]`;
    }
  }

  const path = [];
  while (el) {
    let selector = el.nodeName.toLowerCase();
    if (el.id) {
      selector += '#' + el.id;
      path.unshift(selector);
      break;
    } else {
      if (el.parentNode) {
        const siblings = Array.from(el.parentNode.children || []).filter(
          s => s.nodeName === el.nodeName
        );
        const nth = siblings.indexOf(el) + 1;
        if (siblings.length > 1) selector += ':nth-of-type(' + nth + ')';
      }
    }
    path.unshift(selector);

    // Shadow DOM traversal
    let parent = el.parentNode;
    if (!parent && el.getRootNode) {
      const root = el.getRootNode();
      if (root instanceof ShadowRoot) parent = root.host;
    }
    
    if (!parent || parent.nodeType !== Node.ELEMENT_NODE) break;
    el = parent;
  }
  return path.join(' > ');
}

// BUG 9: added null / non-element parentNode guard to avoid crash on detached nodes

// Helper: generate action description
function generateActionDescription(el, typeOverride = null) {
  const tagName = el.tagName.toLowerCase();
  const type = el.type ? el.type.toLowerCase() : '';
  const actionType = typeOverride || 'click';
  
  // Try to get meaningful text using the same logic as getFieldLabel
  let labelText = getFieldLabel(el);
  if (labelText === 'a field') {
      // fallback for non-input elements
      if (el.innerText) {
        const text = el.innerText.trim().replace(/\n/g, ' ');
        labelText = text.length > 30 ? text.substring(0, 30) + '...' : text;
      }
  }
  
  const formattedLabel = labelText && labelText !== 'a field' ? `"${labelText}"` : 'the';
  const nameSuffix = (labelText && labelText !== 'a field') ? '' : ` ${tagName}`;

  if (actionType === 'scroll') {
    return `Scrolled ${formattedLabel}${nameSuffix}`;
  }

  // Format the description for clicks
  if (tagName === 'button' || (tagName === 'input' && (type === 'submit' || type === 'button'))) {
    return `Click on ${formattedLabel} button`;
  } else if (tagName === 'a') {
    return `Click on ${formattedLabel} link`;
  } else if (tagName === 'label') {
    return `Click on ${formattedLabel} label`;
  } else if (tagName === 'input' || tagName === 'textarea') {
    if (type === 'checkbox' || type === 'radio') {
      return `Check ${formattedLabel} ${type}`;
    }
    return `Click on ${formattedLabel} field`;
  } else if (tagName === 'select') {
    return `Select an option in ${formattedLabel} dropdown`;
  } else if (tagName === 'form') {
    return `Submit ${formattedLabel} form`;
  } else {
    return `Click on ${formattedLabel}${nameSuffix} element`;
  }
}

// Click listener on capture phase
document.addEventListener('click', (event) => {
  if (!isRecording || isPaused) return;
  console.log("[Steply] Click event detected on:", event.target);
  
  // Use composedPath for Shadow DOM support
  const path = event.composedPath && event.composedPath();
  const target = (path && path.length > 0) ? path[0] : event.target;
  
  if (!(target instanceof Element)) return;

  // Ignore events that occur on HUD itself or Toast elements. 
  // We use composedPath checking which is immune to DOM elements being detached during events.
  const isInsideHUD = path && path.some(el => el instanceof Element && (el.classList.contains('steply-hud') || el.classList.contains('steply-toast')));
  if (isInsideHUD) {
    console.log("[Steply] Ignored click inside HUD or toast");
    return;
  }

  // Refine target: if the user clicked an icon or SVG inside a button/link,
  // we should target the interactive parent for a better CSS selector.
  const interactiveTarget = (path ? path.find(el => 
    el instanceof Element && 
    (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || 
     el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.getAttribute('role') === 'button')
  ) : null) || target;

  const selector = getCSSSelector(interactiveTarget);
  const description = generateActionDescription(interactiveTarget);
  const rect = interactiveTarget.getBoundingClientRect();
  
  // By default, highlight the interactive element
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  let w = rect.width;
  let h = rect.height;

  // If the element is too massive (like clicking the background <body> or a huge layout container),
  // fallback to a fixed-size box centered exactly on the user's mouse click.
  // Also enforce a minimum size so it's always visible for tiny buttons.
  if (w > 400 || h > 400) {
    x = event.clientX;
    y = event.clientY;
    w = 60;
    h = 60;
  } else {
    w = Math.max(30, w);
    h = Math.max(30, h);
  }
  
  const elementData = {
    selector,
    tagName: interactiveTarget.tagName.toLowerCase(),
    x: x,
    y: y,
    width: w,
    height: h,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
    type: target.type || undefined,
    ariaLabel: target.getAttribute('aria-label') || undefined
  };

  // Premium Iframe Support: Adjust coordinates if inside a frame
  if (window !== window.top) {
    try {
      const frame = window.frameElement;
      if (frame) {
        const frameRect = frame.getBoundingClientRect();
        elementData.x += frameRect.left;
        elementData.y += frameRect.top;
      }
    } catch (e) {
      // Cross-origin: the coordinates will be subframe-relative.
    }
  }
  
  const step = {
    action: description,
    elementData,
    timestamp: new Date().toISOString(),
    url: window.location.href,
    stepType: 'click'
  };
  
  // Send step immediately to background worker
  // This prevents losing the step if the page navigates away instantly (e.g. clicking a link)
  try {
    console.log("[Steply] Sending click step details to background script:", selector);
    chrome.runtime.sendMessage({ action: 'processStep', step }, (res) => {
      if (chrome.runtime.lastError) {
        console.warn("[Steply] Failed to send step (likely due to immediate page navigation):", chrome.runtime.lastError.message);
      } else if (res && res.success) {
        console.log("[Steply] Step successfully saved in background!");
        if (res.stepCount !== undefined) {
          currentStepCount = res.stepCount;
          updateHUD();
        }
        showToast(`Step ${currentStepCount} captured: Clicked ${step.action}`);
      }
    });
  } catch (err) {
    console.error("STEPLY FATAL ERROR: Failed to send step", err, step);
  }
  
}, true); // use capture phase

// ─── Scroll Tracking ─────────────────────────────────────────────────────────
const elementBaselines = new Map(); // tracking for overflow elements
let scrollTimer = null;
const SCROLL_DEBOUNCE_MS = 500;  // more responsive
const SCROLL_MIN_PX = 50;        // catch smaller movements

window.addEventListener('scroll', (event) => {
  if (!isRecording || isPaused) return;

  // Identify the actual scroll target (window or specific element)
  const target = (event.target === document || event.target === window) ? window : event.target;
  
  const path = event.composedPath && event.composedPath();
  const isInsideHUD = path && path.some(el => el instanceof Element && (el.classList.contains('steply-hud') || el.classList.contains('steply-toast')));
  if (isInsideHUD) {
    return;
  }

  const isWindow = target === window;
  
  const currentY = isWindow ? window.scrollY : target.scrollTop;
  const currentX = isWindow ? window.scrollX : target.scrollLeft;

  // Capture position immediately to prevent drift during debounce
  const capturedY = currentY;
  const capturedX = currentX;

  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    let baseline = isWindow 
      ? { y: lastScrollY, x: lastScrollX } 
      : (elementBaselines.get(target) || { y: 0, x: 0 });

    const deltaY = capturedY - baseline.y;
    const deltaX = capturedX - baseline.x;

    // Only record if the scroll was meaningful
    if (Math.abs(deltaY) < SCROLL_MIN_PX && Math.abs(deltaX) < SCROLL_MIN_PX) return;

    let description = '';
    let elementData = null;

    if (isWindow) {
      const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrollPercent = scrollableHeight > 0
        ? Math.round((capturedY / scrollableHeight) * 100)
        : 0;
      const position = scrollPercent <= 10 ? 'top' 
                     : scrollPercent >= 90 ? 'bottom' 
                     : `${scrollPercent}% down the page`;

      if (Math.abs(deltaY) >= Math.abs(deltaX)) {
        description = deltaY > 0 
          ? `Scrolled down to view more content (now at ${position})`
          : `Scrolled back up (now at ${position})`;
      } else {
        description = deltaX > 0 
          ? 'Scrolled right to view more content'
          : 'Scrolled left to view more content';
      }
    } else {
      // Element-level scroll
      const elDesc = generateActionDescription(target, 'scroll');
      description = deltaY > 0 ? `${elDesc} down` : `${elDesc} up`;
      
      const rect = target.getBoundingClientRect();
      elementData = {
        selector: getCSSSelector(target),
        tagName: target.tagName.toLowerCase(),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight
      };
    }

    const step = {
      action: description,
      elementData,
      timestamp: new Date().toISOString(),
      url: window.location.href,
      stepType: 'scroll'
    };

    try {
      chrome.runtime.sendMessage({ action: 'processStep', step }, (res) => {
        if (!chrome.runtime.lastError) {
          if (res && res.success) {
            if (res.stepCount !== undefined) {
              currentStepCount = res.stepCount;
              updateHUD();
            }
            showToast(`Step ${currentStepCount} captured: Scrolled page`);
          }
          if (isWindow) {
            lastScrollY = capturedY;
            lastScrollX = capturedX;
          } else {
            elementBaselines.set(target, { y: capturedY, x: capturedX });
          }
        }
      });
    } catch (err) {
      console.error("STEPLY FATAL ERROR: Failed to send scroll step", err, step);
    }
  }, SCROLL_DEBOUNCE_MS);

}, true); // Use capture phase to catch scrolls on overflow elements

// ─── Text Input Tracking ──────────────────────────────────────────────────────
// Fires when the user leaves a field (blur), so we capture the final value

function getFieldLabel(el) {
  // 1. aria-label
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  // 2. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.innerText.trim();
  }
  // 3. Associated <label for="...">
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) return label.innerText.trim();
  }
  // 4. Placeholder text
  if (el.placeholder) return el.placeholder;
  // 5. name attribute
  if (el.name) return el.name;
  // 6. Nearest preceding label in the DOM
  let sibling = el.previousElementSibling;
  while (sibling) {
    if (sibling.tagName.toLowerCase() === 'label') return sibling.innerText.trim();
    sibling = sibling.previousElementSibling;
  }
  return 'a field';
}

document.addEventListener('blur', (event) => {
  if (!isRecording || isPaused) return;

  const path = event.composedPath && event.composedPath();
  const target = (path && path.length > 0) ? path[0] : event.target;
  if (!(target instanceof Element)) return;

  const isInsideHUD = path && path.some(el => el instanceof Element && (el.classList.contains('steply-hud') || el.classList.contains('steply-toast')));
  if (isInsideHUD) {
    return;
  }

  const tag = target.tagName.toLowerCase();
  const isContentEditable = target.isContentEditable;
  const isInputField = (tag === 'input' || tag === 'textarea');

  if (!isInputField && !isContentEditable) return;

  const type = (target.type || '').toLowerCase();

  // Skip non-text inputs (buttons, checkboxes, radios, file pickers, etc.)
  const skipTypes = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'];
  if (skipTypes.includes(type)) return;

  // Get the entered value
  let enteredValue = isContentEditable 
    ? target.innerText.trim() 
    : target.value.trim();

  // Skip if empty or just whitespace
  if (!enteredValue) return;

  const fieldLabel = getFieldLabel(target);

  // Mask passwords — never log sensitive data
  const isPassword = type === 'password';
  const displayValue = isPassword ? '••••••••' : enteredValue;

  const description = isPassword
    ? `Entered a password in the "${fieldLabel}" field`
    : `Entered "${displayValue}" in the "${fieldLabel}" field`;

  const rect = target.getBoundingClientRect();
  const elementData = {
    selector: getCSSSelector(target),
    tagName: tag,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight
  };

  const step = {
    action: description,
    elementData,
    timestamp: new Date().toISOString(),
    url: window.location.href,
    stepType: 'input'
  };

  chrome.runtime.sendMessage({ action: 'processStep', step }, (res) => {
    if (chrome.runtime.lastError) {
      // input step could not be sent
    } else if (res && res.success) {
      if (res.stepCount !== undefined) {
        currentStepCount = res.stepCount;
        updateHUD();
      }
      showToast(`Step ${currentStepCount} captured: Input text`);
    }
  });

}, true); // capture phase so it works inside Shadow DOM too

// BUG 10: the empty MutationObserver was removed — it observed DOM mutations
// but did nothing in the callback, wasting memory and CPU on every page.
