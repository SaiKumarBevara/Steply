import React, { useState, useEffect, useRef } from 'react'; // BUG O: removed unused useCallback
import { createRoot } from 'react-dom/client';
import { jsPDF } from 'jspdf';
import { Document, Packer, Paragraph, ImageRun } from 'docx';
import './Dashboard.css';

// ─── Direct IndexedDB access from Dashboard (same extension origin) ──────────
// Extension pages share IndexedDB with the service worker — no message passing
// needed, and no ArrayBuffer size limits to worry about.
let _db = null;
async function openDashboardDb() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('GuideCapture', 2);
    req.onsuccess     = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror       = (e) => reject(e.target.error);
    req.onupgradeneeded = () => {}; // schema already created by background
  });
}

async function getScreenshotBlob(screenshotId) {
  try {
    const db = await openDashboardDb();
    return new Promise((resolve) => {
      const tx  = db.transaction(['screenshots'], 'readonly');
      const req = tx.objectStore('screenshots').get(screenshotId);
      req.onsuccess = (e) => resolve(e.target.result?.blob || null);
      req.onerror   = ()  => resolve(null);
    });
  } catch (e) {
    console.error('[Dashboard] IndexedDB read failed:', e);
    return null;
  }
}

// ─── Screenshot URL resolver (backward-compatible) ────────────────────────────
// Old steps  → step.screenshot  (base64 string, rendered directly)
// New steps  → step.screenshotId (Blob in IndexedDB, read directly)
// BUG 12: callers that create a blob: URL are responsible for revoking it.
// resolveScreenshotUrl returns { url, revoke } so callers always have the handle.
async function resolveScreenshotUrl(step) {
  if (step.screenshot)   return { url: step.screenshot, revoke: () => {} }; // legacy base64 — nothing to revoke
  if (step.screenshotId) {
    const blob = await getScreenshotBlob(step.screenshotId);
    if (blob) {
      const url = URL.createObjectURL(blob);
      return { url, revoke: () => URL.revokeObjectURL(url) };
    }
  }
  return null;
}

// ─── Relative time formatter ──────────────────────────────────────────────────
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)   return 'just now';
  if (mins  < 60)  return `${mins} min ago`;
  if (hours < 24)  return `${hours} hr ago`;
  if (days  === 1) return 'yesterday';
  return `${days} days ago`;
}

// Renders a screenshot onto canvas with optional red-box annotation.
// Accepts the full step object to handle both old and new storage formats.
// Color config for each frequency mode
const HIGHLIGHT_COLORS = {
  red:   { stroke: '#FF0000', fill: 'rgba(255,0,0,0.12)' },
  green: { stroke: '#16A34A', fill: 'rgba(22,163,74,0.12)' },
  none:  null,
};

function ScreenshotCanvas({ step, highlightColor = 'red' }) {
  const canvasRef = useRef(null);
  // imgRef keeps the decoded image so we can redraw without re-fetching
  const imgRef = useRef(null);

  // Load image once per step
  useEffect(() => {
    if (!step) return;
    let revokeFn = null;
    let cancelled = false;

    (async () => {
      const result = await resolveScreenshotUrl(step);
      if (!result || cancelled) { if (result) result.revoke(); return; }
      revokeFn = result.revoke;

      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        imgRef.current = img;
        drawCanvas(img, highlightColor);
      };
      // BUG J: handle broken/missing blob URLs — clear canvas and show error text
      img.onerror = () => {
        if (cancelled) return;
        if (revokeFn) { revokeFn(); revokeFn = null; }
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          canvas.width = 320; canvas.height = 60;
          ctx.fillStyle = '#f8f8f8';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#999';
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('Screenshot unavailable', canvas.width / 2, canvas.height / 2 + 5);
        }
      };
      img.src = result.url;
    })();

    return () => { cancelled = true; if (revokeFn) revokeFn(); }; // BUG 12: always revoke
  }, [step?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw when color changes (no re-fetch needed)
  useEffect(() => {
    if (imgRef.current) drawCanvas(imgRef.current, highlightColor);
  }, [highlightColor]); // eslint-disable-line react-hooks/exhaustive-deps

  function drawCanvas(img, color) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width  = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    const palette = HIGHLIGHT_COLORS[color];
    const ed = step.elementData;
    if (palette && ed) {
      const sx = img.width  / ed.windowWidth;
      const sy = img.height / ed.windowHeight;
      const x  = ed.x * sx, y = ed.y * sy;
      const w  = (ed.width  || 120) * sx;
      const h  = (ed.height ||  60) * sy;
      ctx.strokeStyle = palette.stroke; ctx.lineWidth = 4;
      ctx.strokeRect(x - w/2, y - h/2, w, h);
      ctx.fillStyle = palette.fill;
      ctx.fillRect(x - w/2, y - h/2, w, h);
    }
  }

  return <canvas ref={canvasRef} style={{ maxWidth: '100%', display: 'block' }} />;
}

const StepCard = ({ step, index, updateStepText, updateStepDescription, deleteStep, updateStepColor, guideColor }) => {
  const [desc, setDesc] = useState(step.description || '');
  const [action, setAction] = useState(step.action || '');
  const [isEditingAction, setIsEditingAction] = useState(false);
  const activeColor = step.color || guideColor;

  // BUG 15: keep textarea in sync if parent updates step.description externally
  useEffect(() => {
    setDesc(step.description || '');
  }, [step.description]);

  const handleDescBlur = () => {
    if (desc !== (step.description || '')) {
      updateStepDescription(step, desc);
    }
  };

  const handleActionSave = () => {
    if (action !== step.action) {
      updateStepText(step, action);
    }
    setIsEditingAction(false);
  };

  return (
    <div className="step-card">
      <div className="step-header">
        <div className="step-num">{index + 1}</div>
        
        {isEditingAction ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
            <input 
              className="edit-input"
              value={action} 
              onChange={e => setAction(e.target.value)} 
              autoFocus 
            />
            <button className="btn-primary" style={{ padding: '5px 10px' }} onClick={handleActionSave}>Save</button>
            <button className="btn-secondary" style={{ padding: '5px 10px' }} onClick={() => { setAction(step.action); setIsEditingAction(false); }}>Cancel</button>
          </div>
        ) : (
          <p 
            className="step-title step-action-text" 
            title="Click to edit action text"
            onClick={() => setIsEditingAction(true)}
          >
            {step.action}
          </p>
        )}
        
        {!isEditingAction && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            {/* Step Level Color Override */}
            <div className="trinity-toggle" style={{ padding: '1px', gap: '1px' }} title="Step color override">
              <button
                className={`trinity-btn ${activeColor === 'red' ? 'active-red' : ''}`}
                style={{ padding: '3px 6px' }}
                onClick={() => updateStepColor(step, 'red')}
              ><span className="trinity-dot" style={{ background: '#EF4444' }} /></button>
              <button
                className={`trinity-btn ${activeColor === 'green' ? 'active-green' : ''}`}
                style={{ padding: '3px 6px' }}
                onClick={() => updateStepColor(step, 'green')}
              ><span className="trinity-dot" style={{ background: '#16A34A' }} /></button>
              <button
                className={`trinity-btn ${activeColor === 'none' ? 'active-none' : ''}`}
                style={{ padding: '3px 6px' }}
                onClick={() => updateStepColor(step, 'none')}
              ><i className="ti ti-eye-off" style={{ fontSize: '11px' }} /></button>
            </div>

            <span className="step-type">
              {/* BUG 14: input steps have elementData too — check stepType first */}
              {step.stepType === 'input' ? 'input' : step.elementData ? 'click' : 'scroll'}
            </span>
            <button className="btn-danger" style={{ padding: '4px', border: 'none' }} onClick={() => deleteStep(step)} title="Delete step">
              <i className="ti ti-trash" style={{ fontSize: '13px' }}></i>
            </button>
          </div>
        )}
      </div>

      <div className="notes-label-row">
        <i className="ti ti-notes"></i>
        <span>Notes</span>
      </div>

      <textarea
        className="notes-textarea"
        rows={2}
        placeholder="Click to add a description or notes for this step…"
        value={desc}
        onChange={e => {
          setDesc(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = e.target.scrollHeight + 'px';
        }}
        onBlur={handleDescBlur}
      />

      <div className={`screenshot-area ${(step.screenshot || step.screenshotId) ? '' : 'empty'}`}>
        {(step.screenshot || step.screenshotId) ? (
          <ScreenshotCanvas step={step} highlightColor={activeColor} />
        ) : (
          <>
            <div className="highlight-box">
              <i className="ti ti-crop"></i>
            </div>
            <p className="empty-text">Screenshot captured</p>
          </>
        )}
      </div>
    </div>
  );
};

export default function Dashboard() {
  const [guides, setGuides]               = useState([]);
  const [selectedGuide, setSelectedGuide]   = useState(null);
  const [editingTitle, setEditingTitle]     = useState(false);
  const [titleText, setTitleText]           = useState('');
  const [storageStats, setStorageStats]     = useState(null);
  const [exportOpen, setExportOpen]         = useState(false);
  const [searchQuery, setSearchQuery]       = useState('');
  const [isRecording, setIsRecording]       = useState(false);
  const [activeGuideId, setActiveGuideId]   = useState(null);
  const lastRequestedId = useRef(null);

  useEffect(() => {
    loadGuides();
    loadStorageStats();
    loadRecordingStatus();

    const urlParams = new URLSearchParams(window.location.search);
    const guideId = urlParams.get('guideId');
    if (guideId) loadGuideDetails(guideId);

    // Listen for real-time updates from the background
    const messageListener = (msg) => {
      if (msg.action === 'startRecording') {
        setIsRecording(true);
        loadRecordingStatus();
      } else if (msg.action === 'stopRecording') {
        setIsRecording(false);
        setActiveGuideId(null);
      } else if (msg.action === 'processStep') {
        // If the new step belongs to the currently viewed guide, update the UI
        if (selectedGuide && msg.step && msg.guideId === selectedGuide.id) {
          setSelectedGuide(prev => ({
            ...prev,
            steps: [...(prev.steps || []), msg.step],
            stepCount: (prev.stepCount || 0) + 1
          }));
          loadGuides(); // refresh sidebar count/order
        }
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);
    return () => chrome.runtime.onMessage.removeListener(messageListener);
  }, [selectedGuide?.id]); // re-bind listener when viewed guide changes

  const loadRecordingStatus = () => {
    chrome.runtime.sendMessage({ action: 'getRecordingStatus' }, (res) => {
      if (res) {
        setIsRecording(res.isRecording);
        setActiveGuideId(res.guideId);
      }
    });
  };

  const loadStorageStats = () => {
    chrome.runtime.sendMessage({ action: 'getStorageStats' }, (res) => {
      if (res?.stats) setStorageStats(res.stats);
    });
  };

  const loadGuides = () => {
    chrome.runtime.sendMessage({ action: 'getAllGuides' }, (res) => {
      if (res && res.guides) {
        setGuides(res.guides.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
      }
    });
  };

  const loadGuideDetails = (id) => {
    lastRequestedId.current = id;
    chrome.runtime.sendMessage({ action: 'getGuide', guideId: id }, (res) => {
      // Race condition guard: ignore response if user moved to another guide
      if (lastRequestedId.current !== id) return;
      
      if (res?.error) {
        alert(`Failed to load guide details: ${res.error}`);
        return;
      }
      if (res?.guide) {
        setSelectedGuide(res.guide);
        setTitleText(res.guide.title || 'Untitled');
        setEditingTitle(false);
      }
    });
  };

  const updateTitle = () => {
    // BUG L: do not allow empty string titles — fall back to 'Untitled'
    const safeTitle = titleText.trim() || 'Untitled';
    chrome.runtime.sendMessage({ action: 'updateGuideTitle', guideId: selectedGuide.id, title: safeTitle }, (res) => {
      if (res?.error) {
        alert(`Failed to update title: ${res.error}`);
        return;
      }
      setSelectedGuide({ ...selectedGuide, title: safeTitle });
      setTitleText(safeTitle);
      setEditingTitle(false);
      loadGuides();
    });
  };

  const handleDeleteGuide = () => {
    if (window.confirm('Are you sure you want to delete this guide?')) {
      chrome.runtime.sendMessage({ action: 'deleteGuide', guideId: selectedGuide.id }, (res) => {
        // BUG M: check for error before treating operation as successful
        if (res?.error) {
          alert(`Failed to delete guide: ${res.error}`);
          return;
        }
        setSelectedGuide(null);
        loadGuides();
        loadStorageStats();
      });
    }
  };

  const handleResumeRecording = () => {
    chrome.runtime.sendMessage({ action: 'resumeRecording', guideId: selectedGuide.id }, (res) => {
      // BUG M: surface errors instead of silently doing nothing
      if (res?.error) {
        alert(`Failed to resume recording: ${res.error}`);
        return;
      }
      if (res?.success) {
        alert("Recording resumed! Go to any website and continue clicking to add more steps. Click Stop in the popup when done.");
      }
    });
  };

  const updateStepText = (step, actionText) => {
    chrome.runtime.sendMessage({ action: 'updateStep', guideId: selectedGuide.id, stepId: step.id, actionText }, (res) => {
      if (res?.error) {
        alert(`Failed to update step: ${res.error}`);
        return;
      }
      const newSteps = selectedGuide.steps.map(s => s.id === step.id ? { ...s, action: actionText } : s);
      setSelectedGuide({ ...selectedGuide, steps: newSteps });
    });
  };

  const updateStepDescription = (step, description) => {
    chrome.runtime.sendMessage({ action: 'updateStepDescription', stepId: step.id, description }, (res) => {
      if (res?.error) {
        alert(`Failed to update description: ${res.error}`);
        return;
      }
      const newSteps = selectedGuide.steps.map(s => s.id === step.id ? { ...s, description } : s);
      setSelectedGuide({ ...selectedGuide, steps: newSteps });
    });
  };

  const updateStepColor = (step, color) => {
    chrome.runtime.sendMessage({ action: 'updateStepColor', stepId: step.id, color }, (res) => {
      if (res?.error) {
        alert(`Failed to update color: ${res.error}`);
        return;
      }
      const newSteps = selectedGuide.steps.map(s => s.id === step.id ? { ...s, color } : s);
      setSelectedGuide({ ...selectedGuide, steps: newSteps });
    });
  };

  const deleteStep = (step) => {
    if (window.confirm('Are you sure you want to delete this step?')) {
      chrome.runtime.sendMessage({ action: 'deleteStep', stepId: step.id }, (res) => {
        if (res?.error) {
          alert(`Failed to delete step: ${res.error}`);
          return;
        }
        const newSteps = selectedGuide.steps.filter(s => s.id !== step.id);
        setSelectedGuide({ ...selectedGuide, steps: newSteps });
        loadGuides(); // refresh sidebar count
      });
    }
  };

  const downloadFile = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a); // BUG 17: must be in DOM before click()
    a.click();
    document.body.removeChild(a); // BUG 17: clean up immediately after
    URL.revokeObjectURL(url);
  };

  const getAnnotatedDataUrl = async (step, colorKey) => {
    // BUG K: renamed outer variable from 'result' to 'screenshotResult' to
    // prevent name collision with the inner 'result = canvas.toDataURL(...)'
    const screenshotResult = await resolveScreenshotUrl(step);
    if (!screenshotResult) return null;
    const { url: srcUrl, revoke } = screenshotResult;
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx    = canvas.getContext('2d');
      const img    = new Image();
      img.onload = () => {
        canvas.width = img.width; canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        
        const palette = HIGHLIGHT_COLORS[colorKey];
        const ed = step.elementData;
        if (palette && ed) {
          const sx = img.width / ed.windowWidth, sy = img.height / ed.windowHeight;
          const x  = ed.x * sx, y = ed.y * sy;
          const w  = (ed.width || 120) * sx, h = (ed.height || 60) * sy;
          ctx.strokeStyle = palette.stroke; ctx.lineWidth = 4;
          ctx.strokeRect(x - w/2, y - h/2, w, h);
          ctx.fillStyle = palette.fill;
          ctx.fillRect(x - w/2, y - h/2, w, h);
        }
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        revoke();
        resolve(dataUrl);
      };
      img.onerror = () => { revoke(); resolve(null); };
      img.src = srcUrl;
    });
  };

  // BUG N: sanitize title before using as filename — remove chars illegal on Windows/macOS
  const sanitizeFilename = (title) =>
    (title || 'Untitled').replace(/[/\\:*?"<>|]/g, '-').replace(/^[-\s]+|[-\s]+$/g, '') || 'Untitled';

  const exportPDF = async () => {
    if (!selectedGuide?.steps?.length) return;
    const doc = new jsPDF();
    doc.setFontSize(20);
    doc.text(selectedGuide.title, 10, 20);
    let y = 40;
    for (let i = 0; i < selectedGuide.steps.length; i++) {
      const step = selectedGuide.steps[i];
      if (y > 250) { doc.addPage(); y = 20; }
      doc.setFontSize(14);
      doc.text(`Step ${i + 1}: ${step.action}`, 10, y); y += 8;
      if (step.description) {
        doc.setFontSize(11); doc.setTextColor(100);
        const lines = doc.splitTextToSize(step.description, 180);
        doc.text(lines, 10, y); y += lines.length * 6 + 4;
        doc.setTextColor(0);
      }
      y += 4;
      if (step.screenshot || step.screenshotId) {
        const stepColor = step.color || selectedGuide.defaultColor || 'red';
        const annotated = await getAnnotatedDataUrl(step, stepColor);
        if (annotated) {
          doc.addImage(annotated, 'JPEG', 10, y, 180, 100);
          y += 110;
          if (y > 250) { doc.addPage(); y = 20; }
        }
      }
    }
    doc.save(`${sanitizeFilename(selectedGuide.title)}.pdf`); // BUG N
  };

  const exportMarkdown = async () => {
    if (!selectedGuide?.steps?.length) return;
    let md = `# ${selectedGuide.title}\n\n`;
    for (let i = 0; i < selectedGuide.steps.length; i++) {
      const step = selectedGuide.steps[i];
      md += `## Step ${i + 1}: ${step.action}\n`;
      if (step.description) md += `\n> ${step.description}\n`;
      if (step.screenshot || step.screenshotId) {
        const stepColor = step.color || selectedGuide.defaultColor || 'red';
        const annotated = await getAnnotatedDataUrl(step, stepColor);
        if (annotated) md += `\n![Screenshot](${annotated})\n`;
      }
      md += `\n`;
    }
    downloadFile(new Blob([md], { type: 'text/markdown' }), `${sanitizeFilename(selectedGuide.title)}.md`); // BUG N
  };

  const exportWord = async () => {
    if (!selectedGuide?.steps?.length) return;
    const children = [new Paragraph({ text: selectedGuide.title, heading: 'Heading1' })];
    for (let i = 0; i < selectedGuide.steps.length; i++) {
      const step = selectedGuide.steps[i];
      children.push(new Paragraph({ text: `Step ${i + 1}: ${step.action}`, heading: 'Heading2' }));
      if (step.description) {
        children.push(new Paragraph({ text: step.description }));
      }
      if (step.screenshot || step.screenshotId) {
        try {
          const stepColor = step.color || selectedGuide.defaultColor || 'red';
          const annotated = await getAnnotatedDataUrl(step, stepColor);
          if (annotated) {
            const b64  = annotated.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
            const bin  = window.atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
            children.push(new Paragraph({ children: [new ImageRun({ data: bytes, transformation: { width: 500, height: 300 } })] }));
          }
        } catch (e) { console.error('Word image error:', e); }
      }
    }
    const blob = await Packer.toBlob(new Document({ sections: [{ children }] }));
    downloadFile(blob, `${sanitizeFilename(selectedGuide.title)}.docx`); // BUG N
  };

  const exportJSON = async () => {
    if (!selectedGuide?.steps?.length) return;
    
    // Create a deep copy of the guide to avoid mutating state
    const exportData = JSON.parse(JSON.stringify(selectedGuide));
    
    // Process steps to include base64 screenshots
    for (let i = 0; i < exportData.steps.length; i++) {
      const step = exportData.steps[i];
      if (step.screenshot || step.screenshotId) {
        const stepColor = step.color || selectedGuide.defaultColor || 'red';
        const annotated = await getAnnotatedDataUrl(selectedGuide.steps[i], stepColor);
        if (annotated) {
          step.screenshotDataUrl = annotated;
        }
      }
    }

    const jsonString = JSON.stringify(exportData, null, 2);
    downloadFile(
      new Blob([jsonString], { type: 'application/json' }), 
      `${sanitizeFilename(selectedGuide.title)}.json`
    );
  };

  const filteredGuides = guides.filter(g => 
    (g.title || 'Untitled').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const updateGuideColor = (color) => {
    chrome.runtime.sendMessage({ action: 'updateGuideColor', guideId: selectedGuide.id, color }, (res) => {
      if (res?.error) {
        alert(`Failed to update guide color: ${res.error}`);
        return;
      }
      setSelectedGuide({ ...selectedGuide, defaultColor: color });
      loadGuides();
    });
  };

  const guideColor = selectedGuide?.defaultColor || 'red';

  return (
    <div className="dash-root">
      
      {/* ─── SIDEBAR ───────────────────────────────────────────────────────── */}
      <div className="sidebar">
        {/* Header */}
        <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--color-border-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <img src="images/icon48.png" style={{ width: '28px', height: '28px', borderRadius: '7px' }} alt="Steply Logo" />
          <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-text-primary)' }}>Steply</span>
        </div>

        {/* Search */}
        <div style={{ padding: '12px 12px 8px' }}>
          <div style={{ position: 'relative' }}>
            <i className="ti ti-search" style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)', fontSize: '13px', color: 'var(--color-text-tertiary)' }}></i>
            <input 
              type="text" 
              placeholder="Search guides…" 
              className="search-input"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Guides Count Header */}
        <div style={{ padding: '4px 16px 6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '10px', color: 'var(--color-text-tertiary)', letterSpacing: '0.5px', textTransform: 'uppercase' }}>Your guides</span>
          <span style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>{guides.length} total</span>
        </div>

        {/* Guides List */}
        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '8px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {filteredGuides.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', fontSize: '12px', color: 'var(--color-text-tertiary)' }}>
              No guides found
            </div>
          ) : (
            filteredGuides.map(g => {
              const isActive = selectedGuide?.id === g.id;
              return (
                <div 
                  key={g.id} 
                  className={`guide-item ${isActive ? 'active' : ''}`} 
                  onClick={() => loadGuideDetails(g.id)}
                >
                  <div className="gi-icon" style={{ background: isActive ? '#E6F1FB' : 'var(--color-background-secondary)', position: 'relative' }}>
                    <i className="ti ti-file-description" style={{ fontSize: '14px', color: isActive ? '#185FA5' : 'var(--color-text-secondary)' }}></i>
                    {isRecording && activeGuideId === g.id && (
                      <span className="recording-pulse-mini" title="Recording in progress"></span>
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <p className="gi-title" title={g.title}>{g.title || 'Untitled'}</p>
                    <p className="gi-meta">{g.stepCount} steps · {timeAgo(g.updatedAt)}</p>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Storage Stats */}
        {storageStats && (
          <div style={{ padding: '10px 16px 12px', borderTop: '1px solid var(--color-border-secondary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '5px' }}>
              <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>Storage</span>
              <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>{storageStats.usedMB} / {storageStats.quotaMB} MB</span>
            </div>
            <div style={{ height: '4px', background: 'var(--color-background-secondary)', borderRadius: '99px', overflow: 'hidden' }}>
              <div style={{ width: `${storageStats.usedPercent}%`, height: '100%', background: storageStats.critical ? 'var(--color-text-danger)' : '#185FA5', borderRadius: '99px' }}></div>
            </div>
          </div>
        )}
      </div>

      {/* ─── MAIN CONTENT ──────────────────────────────────────────────────── */}
      <div className="main">
        {selectedGuide ? (
          <>
            {/* Main Header */}
            <div style={{ padding: '14px 20px 13px', background: 'var(--color-background-primary)', borderBottom: '1px solid var(--color-border-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 10 }}>
              <div>
                {editingTitle ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input 
                      className="edit-input" 
                      style={{ fontSize: '14px', fontWeight: 500, minWidth: '240px' }}
                      value={titleText} 
                      onChange={e => setTitleText(e.target.value)} 
                      autoFocus 
                    />
                    <button className="btn-primary" style={{ padding: '6px 10px' }} onClick={updateTitle}>Save</button>
                    <button className="btn-secondary" style={{ padding: '6px 10px' }} onClick={() => { setEditingTitle(false); setTitleText(selectedGuide.title); }}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <p style={{ margin: 0, fontSize: '14px', fontWeight: 500, color: 'var(--color-text-primary)' }}>{selectedGuide.title || 'Untitled'}</p>
                      {isRecording && activeGuideId === selectedGuide.id && (
                        <span className="recording-badge-header">
                          <span className="recording-pulse"></span>
                          Recording
                        </span>
                      )}
                    </div>
                    <p style={{ margin: 0, fontSize: '11px', color: 'var(--color-text-tertiary)' }}>{selectedGuide.steps?.length || 0} steps · created {new Date(selectedGuide.createdAt).toLocaleDateString()}</p>
                  </>
                )}
              </div>
              
              {!editingTitle && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button className="btn-secondary" onClick={() => setEditingTitle(true)}>
                    <i className="ti ti-edit" style={{ fontSize: '13px' }}></i>
                    Rename
                  </button>
                  
                  {/* Export Dropdown */}
                  <div 
                    className="export-dropdown-wrap"
                    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setExportOpen(false); }}
                    tabIndex={-1}
                  >
                    <button className="btn-secondary" onClick={() => setExportOpen(!exportOpen)}>
                      <i className="ti ti-download" style={{ fontSize: '13px' }}></i>
                      Export
                      <i className={`ti ti-chevron-${exportOpen ? 'up' : 'down'}`} style={{ fontSize: '12px', marginLeft: '2px' }}></i>
                    </button>
                    {exportOpen && (
                      <div className="export-dropdown-menu">
                        <button className="export-dropdown-item" onClick={() => { exportPDF(); setExportOpen(false); }}>
                          <i className="ti ti-file-type-pdf" style={{ fontSize: '15px' }}></i> Export PDF
                        </button>
                        <button className="export-dropdown-item" onClick={() => { exportMarkdown(); setExportOpen(false); }}>
                          <i className="ti ti-markdown" style={{ fontSize: '15px' }}></i> Export Markdown
                        </button>
                        <button className="export-dropdown-item" onClick={() => { exportWord(); setExportOpen(false); }}>
                          <i className="ti ti-file-type-doc" style={{ fontSize: '15px' }}></i> Export Word
                        </button>
                        <button className="export-dropdown-item" onClick={() => { exportJSON(); setExportOpen(false); }}>
                          <i className="ti ti-code" style={{ fontSize: '15px' }}></i> Export JSON
                        </button>
                      </div>
                    )}
                  </div>

                  {/* ── Trinity Toggle (Guide Level) ── */}
                  <div className="trinity-toggle" title="Guide default highlight">
                    <button
                      className={`trinity-btn ${guideColor === 'red' ? 'active-red' : ''}`}
                      onClick={() => updateGuideColor('red')}
                      title="Standard Flare (Red)"
                    >
                      <span className="trinity-dot" style={{ background: '#EF4444' }} />
                      Flare
                    </button>
                    <button
                      className={`trinity-btn ${guideColor === 'green' ? 'active-green' : ''}`}
                      onClick={() => updateGuideColor('green')}
                      title="Steady Orbit (Green)"
                    >
                      <span className="trinity-dot" style={{ background: '#16A34A' }} />
                      Orbit
                    </button>
                    <button
                      className={`trinity-btn ${guideColor === 'none' ? 'active-none' : ''}`}
                      onClick={() => updateGuideColor('none')}
                      title="Invisible Mass (None)"
                    >
                      <i className="ti ti-eye-off" style={{ fontSize: '12px' }} />
                      None
                    </button>
                  </div>

                  <button 
                    className={isRecording && activeGuideId === selectedGuide.id ? "btn-recording-active" : "btn-primary"} 
                    onClick={handleResumeRecording}
                    disabled={isRecording && activeGuideId === selectedGuide.id}
                  >
                    <i className={isRecording && activeGuideId === selectedGuide.id ? "ti ti-circle-filled" : "ti ti-player-play"} style={{ fontSize: '13px' }}></i>
                    {isRecording && activeGuideId === selectedGuide.id ? "Recording..." : "Resume"}
                  </button>
                  <button className="btn-danger" onClick={handleDeleteGuide}>
                    <i className="ti ti-trash" style={{ fontSize: '13px' }}></i>
                  </button>
                </div>
              )}
            </div>

            {/* Timeline Area */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px 40px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {selectedGuide.steps?.map((step, index) => (
                <StepCard 
                  key={step.id} 
                  step={step} 
                  index={index} 
                  updateStepText={updateStepText} 
                  updateStepDescription={updateStepDescription} 
                  deleteStep={deleteStep}
                  updateStepColor={updateStepColor}
                  guideColor={guideColor}
                />
              ))}

              {/* Add Step Button */}
              <div 
                className={`step-card-resume ${isRecording && activeGuideId === selectedGuide.id ? 'recording' : ''}`}
                onClick={handleResumeRecording}
              >
                {isRecording && activeGuideId === selectedGuide.id ? (
                  <>
                    <span className="recording-pulse" style={{ width: '10px', height: '10px' }}></span>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>Recording in progress... Click around on your site to add steps.</span>
                  </>
                ) : (
                  <>
                    <i className="ti ti-plus" style={{ fontSize: '16px', color: 'inherit', marginRight: '6px' }}></i>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>Add a step (Resume Recording)</span>
                  </>
                )}
              </div>

            </div>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-tertiary)' }}>
            <img src="images/icon48.png" style={{ width: '48px', height: '48px', marginBottom: '16px', opacity: 0.2, borderRadius: '12px' }} alt="Steply Logo" />
            <p style={{ fontSize: '15px' }}>Select a guide from the sidebar to view details</p>
          </div>
        )}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<Dashboard />);
