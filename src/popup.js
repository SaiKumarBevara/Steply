document.addEventListener('DOMContentLoaded', () => {
  const recordBtn   = document.getElementById('recordBtn');
  const recordIcon  = document.getElementById('recordIcon');
  const recordLabel = document.getElementById('recordLabel');
  const statusWrapper = document.getElementById('statusWrapper');
  const statusDot   = document.getElementById('statusDot');
  const statusText  = document.getElementById('statusText');
  const guidesList  = document.getElementById('guidesList');

  // ── Guides tab → opens dashboard (CSP-safe: no inline handlers) ────────────
  document.getElementById('tabGuides').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });

  // ── Privacy Policy ─────────────────────────────────────────────────────────
  document.getElementById('privacyBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('privacy.html') });
  });

  let isRecording = false;

  // ── Default Filter Selection ───────────────────────────────────────────────
  const btnRed = document.getElementById('color-red');
  const btnGreen = document.getElementById('color-green');
  const btnNone = document.getElementById('color-none');

  function updateFilterUI(color) {
    // Reset all
    [btnRed, btnGreen, btnNone].forEach(btn => {
      btn.style.background = 'transparent';
      btn.style.color = 'var(--color-text-secondary)';
      btn.style.boxShadow = 'none';
    });
    // Set active
    if (color === 'red') {
      btnRed.style.background = '#FEF2F2';
      btnRed.style.color = '#B91C1C';
      btnRed.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
    } else if (color === 'green') {
      btnGreen.style.background = '#F0FDF4';
      btnGreen.style.color = '#15803D';
      btnGreen.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
    } else if (color === 'none') {
      btnNone.style.background = 'var(--color-background-primary)';
      btnNone.style.color = 'var(--color-text-primary)';
      btnNone.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
    }
  }

  chrome.storage.local.get(['highlightColor'], (res) => {
    updateFilterUI(res.highlightColor || 'red');
  });

  const setFilter = (color) => {
    chrome.storage.local.set({ highlightColor: color });
    updateFilterUI(color);
  };

  btnRed.addEventListener('click', () => setFilter('red'));
  btnGreen.addEventListener('click', () => setFilter('green'));
  btnNone.addEventListener('click', () => setFilter('none'));

  // ── Relative time ──────────────────────────────────────────────────────────
  function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);
    if (mins  < 1)   return 'just now';
    if (mins  < 60)  return `${mins}m ago`;
    if (hours < 24)  return `${hours}h ago`;
    if (days  === 1) return 'yesterday';
    return `${days} days ago`;
  }

  // ── UI state ───────────────────────────────────────────────────────────────
  function updateUI() {
    if (isRecording) {
      recordBtn.style.background = '#ef4444';
      recordIcon.className = 'ti ti-player-stop';
      recordLabel.textContent = 'Stop recording';
      
      statusWrapper.style.color = '#B91C1C';
      statusWrapper.style.background = '#FEE2E2';
      statusDot.style.background = '#DC2626';
      statusDot.classList.add('recording-pulse');
      statusText.textContent = 'Recording';
    } else {
      recordBtn.style.background = '#185FA5';
      recordIcon.className = 'ti ti-player-record';
      recordLabel.textContent = 'Start recording';
      
      statusWrapper.style.color = '#0F6E56';
      statusWrapper.style.background = '#E1F5EE';
      statusDot.style.background = '#1D9E75';
      statusDot.classList.remove('recording-pulse');
      statusText.textContent = 'Ready';
    }
  }


  // ── Load recording state ───────────────────────────────────────────────────
  function loadInitialState() {
    chrome.runtime.sendMessage({ action: 'getRecordingStatus' }, (res) => {
      if (res) { 
        isRecording = res.isRecording; 
        updateUI(); 
      }
    });
  }

  loadInitialState();

  // ── Record button ──────────────────────────────────────────────────────────
  recordBtn.addEventListener('click', () => {
    if (isRecording) {
      chrome.runtime.sendMessage({ action: 'stopRecording' }, (res) => {
        if (res && res.status === 'stopped') {
          isRecording = false;
          updateUI();
          loadGuides();
        }
      });
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const url = tabs?.[0]?.url || '';
        chrome.runtime.sendMessage({ action: 'startRecording', url }, (res) => {
          if (res && res.status === 'started') {
            isRecording = true;
            updateUI();
            loadGuides();
          }
        });
      });
    }
  });

  // ── Dashboard button ───────────────────────────────────────────────────────
  document.getElementById('dashboardBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });



  let isLoadingGuides = false;
  function loadGuides() {
    if (isLoadingGuides) return;
    isLoadingGuides = true;
    // BUG P: we need the active guide ID to know which row is live-recording,
    // so we can fetch its real-time stepCount from the background.
    chrome.storage.local.get(['activeGuideId'], (stored) => {
      const activeGuideId = stored.activeGuideId || null;

      chrome.runtime.sendMessage({ action: 'getAllGuides' }, (res) => {
        if (!res || !res.guides) return;

        const guides = res.guides
          .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
          .slice(0, 3);

        // Clear existing content safely
        while (guidesList.firstChild) guidesList.removeChild(guidesList.firstChild);

        if (guides.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'text-align: center; font-size: 12px; color: var(--color-text-tertiary); padding: 18px 0;';
          empty.textContent = 'No guides recorded yet';
          guidesList.appendChild(empty);
          return;
        }

        guides.forEach(guide => {
          const isActiveRecording = activeGuideId && guide.id === activeGuideId;

          const div = document.createElement('div');
          div.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 10px 10px; border-radius: 8px; cursor: pointer; transition: background 0.15s;';
          div.onmouseover = () => div.style.background = 'var(--color-background-secondary)';
          div.onmouseout  = () => div.style.background = 'transparent';

          const left = document.createElement('div');
          left.style.cssText = 'display: flex; align-items: center; gap: 10px; min-width: 0;';

          const iconWrap = document.createElement('div');
          iconWrap.style.cssText = 'width: 30px; height: 30px; border-radius: 7px; background: var(--color-background-info); display: flex; align-items: center; justify-content: center; flex-shrink: 0;';
          const icon = document.createElement('i');
          icon.className = 'ti ti-file-description';
          icon.style.cssText = 'font-size: 15px; color: var(--color-text-info);';
          icon.setAttribute('aria-hidden', 'true');
          iconWrap.appendChild(icon);

          const textWrap = document.createElement('div');
          textWrap.style.cssText = 'min-width: 0;';

          const titleP = document.createElement('p');
          titleP.style.cssText = 'margin: 0; font-size: 13px; font-weight: 500; color: var(--color-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px;';
          titleP.title = guide.title || 'Untitled';
          titleP.textContent = guide.title || 'Untitled';

          const timeP = document.createElement('p');
          timeP.style.cssText = 'margin: 0; font-size: 11px; color: var(--color-text-tertiary);';
          timeP.textContent = timeAgo(guide.updatedAt);

          textWrap.appendChild(titleP);
          textWrap.appendChild(timeP);
          left.appendChild(iconWrap);
          left.appendChild(textWrap);

          const badge = document.createElement('span');
          badge.style.cssText = 'font-size: 11px; font-weight: 500; color: #185FA5; background: #E6F1FB; padding: 3px 8px; border-radius: 20px; flex-shrink: 0;';

          if (isActiveRecording) {
            // BUG P: fetch live stepCount from background for the recording guide
            badge.textContent = '… steps'; // placeholder while fetching
            chrome.runtime.sendMessage({ action: 'getRecordingStatus' }, (statusRes) => {
              // getRecordingStatus doesn't return stepCount directly — fetch the guide
              chrome.runtime.sendMessage({ action: 'getGuide', guideId: guide.id }, (guideRes) => {
                if (guideRes?.guide) {
                  badge.textContent = `${guideRes.guide.steps?.length ?? guide.stepCount} steps`;
                }
              });
            });
          } else {
            badge.textContent = `${guide.stepCount} steps`;
          }

          div.appendChild(left);

          const right = document.createElement('div');
          right.style.cssText = 'display: flex; align-items: center; gap: 8px;';

          // Resume Icon Button
          if (!isActiveRecording) {
            const resumeIcon = document.createElement('button');
            resumeIcon.style.cssText = 'background: none; border: none; cursor: pointer; color: #185FA5; padding: 4px; display: flex; align-items: center; justify-content: center; transition: transform 0.1s;';
            resumeIcon.innerHTML = '<i class="ti ti-player-play-filled" style="font-size: 14px;"></i>';
            resumeIcon.title = 'Resume recording';
            resumeIcon.onmouseover = () => resumeIcon.style.transform = 'scale(1.2)';
            resumeIcon.onmouseout  = () => resumeIcon.style.transform = 'scale(1)';
            resumeIcon.onclick = (e) => {
              e.stopPropagation();
              chrome.runtime.sendMessage({ action: 'resumeRecording', guideId: guide.id }, (res) => {
                if (res?.success) {
                  isRecording = true;
                  updateUI();
                  loadGuides();
                }
              });
            };
            right.appendChild(resumeIcon);
          }

          right.appendChild(badge);
          div.appendChild(right);

          div.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html?guideId=${guide.id}`) });
          });
          guidesList.appendChild(div);
        });
      });
    });
    // Release lock after all messages sent
    isLoadingGuides = false;
  }

  loadGuides();
  // BUG 18: store interval ID and clear it when the popup unloads,
  // preventing stale intervals accumulating if the popup context is reused.
  const intervalId = setInterval(loadGuides, 3000);
  window.addEventListener('unload', () => clearInterval(intervalId));
});
