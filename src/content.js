let isRecording = false;

// BUG 10: ensure isRecording stays in sync with storage across reloads/restarts
function syncRecordingState() {
  chrome.storage.local.get(['isRecording'], (res) => {
    isRecording = !!res.isRecording;
  });
}

syncRecordingState();

// Listen for storage changes to handle Service Worker reloads/restarts
chrome.storage.onChanged.addListener((changes) => {
  if (changes.isRecording) isRecording = changes.isRecording.newValue;
});

// Listen for messages from the background service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startRecording') {
    isRecording = true;
    lastScrollY = window.scrollY;
    lastScrollX = window.scrollX;
    sendResponse({ status: 'started' });
  } else if (request.action === 'stopRecording') {
    isRecording = false;
    sendResponse({ status: 'stopped' });
  }
});

// Helper: generate unique CSS selector
function getCSSSelector(el) {
  if (!(el instanceof Element)) return '';
  const path = [];
  while (el.nodeType === Node.ELEMENT_NODE) {
    let selector = el.nodeName.toLowerCase();
    if (el.id) {
      selector += '#' + el.id;
      path.unshift(selector);
      break;
    } else {
      // BUG G: use index-based counting across all children with the same tag
      // to get the correct nth-of-type value (old sibling-walk was off-by-one
      // and only counted preceding siblings, not all same-type children).
      if (el.parentNode) {
        const siblings = Array.from(el.parentNode.children).filter(
          s => s.nodeName === el.nodeName
        );
        const nth = siblings.indexOf(el) + 1;
        if (siblings.length > 1) selector += ':nth-of-type(' + nth + ')';
      }
    }
    path.unshift(selector);
    // Stop traversal if parentNode is null or not a real element (detached / Shadow DOM)
    if (!el.parentNode || el.parentNode.nodeType !== Node.ELEMENT_NODE) break;
    el = el.parentNode;
  }
  return path.join(' > ');
}

// BUG 9: added null / non-element parentNode guard to avoid crash on detached nodes

// Helper: generate action description
function generateActionDescription(el) {
  const tagName = el.tagName.toLowerCase();
  const type = el.type ? el.type.toLowerCase() : '';
  
  // Try to get meaningful text
  let labelText = el.getAttribute('aria-label') || '';
  if (!labelText && el.getAttribute('aria-labelledby')) {
    const labelEl = document.getElementById(el.getAttribute('aria-labelledby'));
    if (labelEl) labelText = labelEl.innerText;
  }
  if (!labelText && el.innerText) {
    // Clean up text and truncate if too long
    const text = el.innerText.trim().replace(/\n/g, ' ');
    labelText = text.length > 30 ? text.substring(0, 30) + '...' : text;
  }
  if (!labelText && el.placeholder) {
    labelText = el.placeholder;
  }
  if (!labelText && el.value && type !== 'password') {
    labelText = el.value;
  }
  
  const formattedLabel = labelText ? `"${labelText}"` : 'the';
  
  // Format the description
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
    return `Enter text in ${formattedLabel} field`;
  } else if (tagName === 'select') {
    return `Select an option in ${formattedLabel} dropdown`;
  } else if (tagName === 'form') {
    return `Submit ${formattedLabel} form`;
  } else {
    return `Click on ${formattedLabel} element`;
  }
}

// Click listener on capture phase
document.addEventListener('click', (event) => {
  if (!isRecording) return;
  
  // Use composedPath for Shadow DOM support
  const path = event.composedPath && event.composedPath();
  const target = (path && path.length > 0) ? path[0] : event.target;
  
  // Skip if not an element
  if (!(target instanceof Element)) return;
  
  // Skip script and style tags
  const tagName = target.tagName.toLowerCase();
  if (tagName === 'script' || tagName === 'style') return;

  // BUG I: skip click recording for text-input elements — they are already
  // captured by the blur handler (which records the entered value). Recording
  // the click here would produce a redundant "Enter text in ... field" duplicate.
  const inputTextTypes = ['text', 'email', 'password', 'number', 'search', 'url', 'tel'];
  if (
    tagName === 'textarea' ||
    (tagName === 'input' && inputTextTypes.includes((target.type || '').toLowerCase()))
  ) return;

  const selector = getCSSSelector(target);
  const description = generateActionDescription(target);
  const rect = target.getBoundingClientRect();
  
  const elementData = {
    selector,
    tagName,
    x: rect.left + rect.width / 2, // center X
    y: rect.top + rect.height / 2, // center Y
    width: rect.width,
    height: rect.height,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
    type: target.type || undefined,
    ariaLabel: target.getAttribute('aria-label') || undefined
  };
  
  const step = {
    action: description,
    elementData,
    timestamp: new Date().toISOString(),
    url: window.location.href
  };
  
  // Send step immediately to background worker
  // This prevents losing the step if the page navigates away instantly (e.g. clicking a link)
  chrome.runtime.sendMessage({ action: 'processStep', step }, () => {
    if (chrome.runtime.lastError) {
      // step could not be sent (page might be navigating)
    }
  });
  
}, true); // use capture phase

// ─── Scroll Tracking ─────────────────────────────────────────────────────────
let lastScrollY = window.scrollY;
let lastScrollX = window.scrollX;
let scrollTimer = null;
const SCROLL_DEBOUNCE_MS = 800;  // wait until user stops scrolling
const SCROLL_MIN_PX = 80;         // ignore tiny scroll jitters

window.addEventListener('scroll', () => {
  if (!isRecording) return;

  // BUG H: capture position at scroll event time so accumulated drift inside
  // the debounce callback doesn't grow unboundedly on slow-send paths.
  const capturedScrollY = window.scrollY;
  const capturedScrollX = window.scrollX;

  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const deltaY = capturedScrollY - lastScrollY;
    const deltaX = capturedScrollX - lastScrollX;

    // Only record if the scroll was meaningful
    if (Math.abs(deltaY) < SCROLL_MIN_PX && Math.abs(deltaX) < SCROLL_MIN_PX) return;

    // BUG 8: guard against division by zero on short/non-scrollable pages
    const scrollableHeight = document.body.scrollHeight - window.innerHeight;
    const scrollPercent = scrollableHeight > 0
      ? Math.round((window.scrollY / scrollableHeight) * 100)
      : 0;
    const position = scrollPercent <= 10 ? 'top' 
                   : scrollPercent >= 90 ? 'bottom' 
                   : `${scrollPercent}% down the page`;

    let description = '';
    if (Math.abs(deltaY) >= Math.abs(deltaX)) {
      if (deltaY > 0) {
        description = `Scrolled down to view more content (now at ${position})`;
      } else {
        description = `Scrolled back up (now at ${position})`;
      }
    } else {
      description = deltaX > 0 
        ? 'Scrolled right to view more content'
        : 'Scrolled left to view more content';
    }

    const step = {
      action: description,
      elementData: null,
      timestamp: new Date().toISOString(),
      url: window.location.href,
      stepType: 'scroll'
    };

    // BUG 11: only update baseline after the message send succeeds,
    // so a failed send doesn't permanently swallow the scroll delta.
    chrome.runtime.sendMessage({ action: 'processStep', step }, () => {
      if (!chrome.runtime.lastError) {
        lastScrollY = capturedScrollY;
        lastScrollX = capturedScrollX;
      }
    });
  }, SCROLL_DEBOUNCE_MS);

}, { passive: true }); // passive: true = no perf impact on scroll

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
