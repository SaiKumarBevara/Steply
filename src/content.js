console.log("[Steply] Content script loaded successfully on:", window.location.href);

let isRecording = false;

// BUG 10: ensure isRecording stays in sync with storage across reloads/restarts
function syncRecordingState() {
  chrome.storage.local.get(['isRecording'], (res) => {
    isRecording = !!res.isRecording;
    console.log("[Steply] Recording state synced from storage:", isRecording);
  });
}

syncRecordingState();

// Listen for storage changes to handle Service Worker reloads/restarts
chrome.storage.onChanged.addListener((changes) => {
  if (changes.isRecording) {
    isRecording = changes.isRecording.newValue;
    console.log("[Steply] Recording state changed in storage:", isRecording);
  }
});

// Listen for messages from the background service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startRecording') {
    isRecording = true;
    lastScrollY = window.scrollY;
    lastScrollX = window.scrollX;
    console.log("[Steply] Received startRecording event.");
    sendResponse({ status: 'started' });
  } else if (request.action === 'stopRecording') {
    isRecording = false;
    console.log("[Steply] Received stopRecording event.");
    sendResponse({ status: 'stopped' });
  }
});

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
  if (!isRecording) return;
  console.log("[Steply] Click event detected on:", event.target);
  
  // Use composedPath for Shadow DOM support
  const path = event.composedPath && event.composedPath();
  const target = (path && path.length > 0) ? path[0] : event.target;
  
  if (!(target instanceof Element)) return;

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
    chrome.runtime.sendMessage({ action: 'processStep', step }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[Steply] Failed to send step (likely due to immediate page navigation):", chrome.runtime.lastError.message);
      } else {
        console.log("[Steply] Step successfully saved in background!");
      }
    });
  } catch (err) {
    console.error("STEPLY FATAL ERROR: Failed to send step", err, step);
  }
  
}, true); // use capture phase

// ─── Scroll Tracking ─────────────────────────────────────────────────────────
let lastScrollY = window.scrollY;
let lastScrollX = window.scrollX;
const elementBaselines = new Map(); // tracking for overflow elements
let scrollTimer = null;
const SCROLL_DEBOUNCE_MS = 500;  // more responsive
const SCROLL_MIN_PX = 50;        // catch smaller movements

window.addEventListener('scroll', (event) => {
  if (!isRecording) return;

  // Identify the actual scroll target (window or specific element)
  const target = (event.target === document || event.target === window) ? window : event.target;
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
      chrome.runtime.sendMessage({ action: 'processStep', step }, () => {
        if (!chrome.runtime.lastError) {
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
  if (!isRecording) return;

  const path = event.composedPath && event.composedPath();
  const target = (path && path.length > 0) ? path[0] : event.target;
  if (!(target instanceof Element)) return;

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

  chrome.runtime.sendMessage({ action: 'processStep', step }, () => {
    if (chrome.runtime.lastError) {
      // input step could not be sent
    }
  });

}, true); // capture phase so it works inside Shadow DOM too

// BUG 10: the empty MutationObserver was removed — it observed DOM mutations
// but did nothing in the callback, wasting memory and CPU on every page.
