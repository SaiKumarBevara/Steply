import React, { useState, useEffect, useRef } from 'react'; // BUG O: removed unused useCallback
import { createRoot } from 'react-dom/client';
import { jsPDF } from 'jspdf';
import { Document, Packer, Paragraph, ImageRun } from 'docx';
import './Dashboard.css';

// Escapes text interpolated into an HTML string. Same rules as the exporter's
// escapeHtml() below; declared at module scope so StepCard can use it too.
function escapeHtmlText(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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

function drawTimestampOnCanvas(canvas, ctx, timestamp, position = 'bottom_right', style = 'minimal_black') {
  if (!timestamp) return;
  const dateText = new Date(timestamp).toLocaleString();
  
  // Style configurations - default to normal timestamp with black color without background and border
  let font = '20px "DM Sans", sans-serif';
  let textColor = '#000000';
  
  if (style === 'minimal_white') {
    textColor = '#FFFFFF';
  } else {
    // any other style (including minimal_black or legacy styles) maps to normal black
    textColor = '#000000';
  }
  
  ctx.font = font;
  const textWidth = ctx.measureText(dateText).width;
  const paddingX = 15;
  const paddingY = 8;
  const boxWidth = textWidth + paddingX * 2;
  const boxHeight = 24 + paddingY * 2; // ~40px total height
  
  // Determine coordinates based on position
  let x = 0;
  let y = 0;
  const margin = 20;
  
  switch (position) {
    case 'top_left':
      x = margin;
      y = margin;
      break;
    case 'top_right':
      x = canvas.width - boxWidth - margin;
      y = margin;
      break;
    case 'bottom_left':
      x = margin;
      y = canvas.height - boxHeight - margin;
      break;
    case 'bottom_right':
    default:
      x = canvas.width - boxWidth - margin;
      y = canvas.height - boxHeight - margin;
      break;
  }
  
  ctx.save();
  ctx.fillStyle = textColor;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(dateText, x + paddingX, y + paddingY);
  ctx.restore();
}

// Draws the automatic highlight box around the recorded element. Was duplicated
// verbatim in getAnnotatedDataUrl() and ScreenshotCanvas.drawCanvas(); the manual
// annotation editor is a third site that needs it, so it lives in one place now.
// Behaviour is unchanged from both former copies.
function drawHighlightBox(ctx, img, step, colorKey) {
  const palette = HIGHLIGHT_COLORS[colorKey];
  const ed = step.elementData;
  if (!palette || !ed) return;
  const sx = img.width / ed.windowWidth, sy = img.height / ed.windowHeight;
  const x  = ed.x * sx, y = ed.y * sy;
  const w  = (ed.width || 120) * sx, h = (ed.height || 60) * sy;
  ctx.strokeStyle = palette.stroke; ctx.lineWidth = 4;
  ctx.strokeRect(x - w/2, y - h/2, w, h);
  ctx.fillStyle = palette.fill;
  ctx.fillRect(x - w/2, y - h/2, w, h);
}

// ─── Manual annotations (arrows, boxes, text, numbered badges) ────────────────
// Stored on the step record as step.annotations and drawn at render time — the
// screenshot blob is never rewritten, so annotations stay editable and a step
// without the field simply draws nothing (no migration, no DB version bump).
// Coordinates are normalised 0..1 against the image so markup lands correctly
// whatever the capture's pixel size.
const ANNOT_COLORS = ['#FF3B30', '#FF9500', '#34C759', '#007AFF', '#1C1C1E', '#FFFFFF'];
const ANNOT_DEFAULT_TEXT_SIZE = 0.022; // fraction of image height

// Pen weights scale with the capture so markup reads the same on a 1280px and a
// 2560px screenshot. Shared by the renderer and the hit-test geometry below so the
// two can't drift out of sync.
function annotationMetrics(W) {
  return {
    stroke:  Math.max(2,  W * 0.0022),
    headLen: Math.max(10, W * 0.011),
    radius:  Math.max(10, W * 0.009),
  };
}
const ANNOT_TOOLS = [
  { id: 'arrow',  icon: 'ti-arrow-up-right',  title: 'Arrow — drag to draw' },
  { id: 'rect',   icon: 'ti-square',          title: 'Box — drag to draw' },
  { id: 'text',   icon: 'ti-typography',      title: 'Text label — click to place' },
  { id: 'badge',  icon: 'ti-circle-number-1', title: 'Numbered badge — click to place' },
  { id: 'blur',   icon: 'ti-shield-lock',     title: 'Blur sensitive info — drag over it' },
  { id: 'select', icon: 'ti-pointer',         title: 'Select — click a shape, then press Delete' },
];

// Irreversibly blurs regions of a canvas. Lifted unchanged from the old standalone
// RedactionWorkspace so redaction behaviour is identical: density-aware radius and
// pass count, self-compositing to build opacity on small areas (small text needs
// more passes or it stays readable), plus the thin 'locked' border.
// Must run before annotations are drawn, or the self-composite smears them too.
function applyBlurRects(ctx, canvas, rects) {
  if (!Array.isArray(rects) || !rects.length) return;
  for (const r of rects) {
    const x = r.x * canvas.width,  y = r.y * canvas.height;
    const w = r.w * canvas.width,  h = r.h * canvas.height;
    if (w < 1 || h < 1) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    const isSmall = w < 40 || h < 40;
    const radius  = isSmall ? 8 : 16;
    const passes  = isSmall ? 8 : 4;
    ctx.filter = `blur(${radius}px)`;
    for (let i = 0; i < passes; i++) ctx.drawImage(canvas, x, y, w, h, x, y, w, h);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}

// Axis-aligned box around an annotation, in canvas pixels. Used for click
// hit-testing and for the selection outline — deliberately approximate for text
// (no ctx.measureText) since it only has to be close enough to click.
function annotationBounds(a, W, H) {
  if (a.type === 'arrow') {
    const x1 = a.x1 * W, y1 = a.y1 * H, x2 = a.x2 * W, y2 = a.y2 * H;
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
  if (a.type === 'rect' || a.type === 'blur') return { x: a.x * W, y: a.y * H, w: a.w * W, h: a.h * H };
  if (a.type === 'text') {
    const size = Math.max(12, (a.size || ANNOT_DEFAULT_TEXT_SIZE) * H);
    return { x: a.x * W, y: a.y * H, w: Math.max(size, (a.text || '').length * size * 0.6), h: size * 1.2 };
  }
  const r = annotationMetrics(W).radius; // badge
  return { x: a.x * W - r, y: a.y * H - r, w: r * 2, h: r * 2 };
}

function newAnnotationId() {
  return 'an_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function drawAnnotations(ctx, canvas, annotations) {
  if (!Array.isArray(annotations) || !annotations.length) return;
  const W = canvas.width, H = canvas.height;
  const { stroke, headLen, radius } = annotationMetrics(W);
  let badgeNum = 0;

  for (const a of annotations) {
    if (!a || !a.type) continue;
    const color = a.color || ANNOT_COLORS[0];
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.lineWidth   = stroke;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';

    if (a.type === 'arrow') {
      const x1 = a.x1 * W, y1 = a.y1 * H, x2 = a.x2 * W, y2 = a.y2 * H;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      // Stop the shaft short of the tip so the head reads as solid.
      const bx = x2 - Math.cos(angle) * headLen * 0.8;
      const by = y2 - Math.sin(angle) * headLen * 0.8;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - Math.cos(angle - 0.4) * headLen, y2 - Math.sin(angle - 0.4) * headLen);
      ctx.lineTo(x2 - Math.cos(angle + 0.4) * headLen, y2 - Math.sin(angle + 0.4) * headLen);
      ctx.closePath();
      ctx.fill();
    } else if (a.type === 'rect') {
      ctx.strokeRect(a.x * W, a.y * H, a.w * W, a.h * H);
    } else if (a.type === 'text') {
      const size = Math.max(12, (a.size || ANNOT_DEFAULT_TEXT_SIZE) * H);
      ctx.font = `600 ${size}px "DM Sans", sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      // Outline the glyphs so light text stays legible on light screenshots.
      ctx.lineWidth = Math.max(2, size * 0.14);
      ctx.strokeStyle = color === '#FFFFFF' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
      ctx.strokeText(a.text || '', a.x * W, a.y * H);
      ctx.fillText(a.text || '', a.x * W, a.y * H);
    } else if (a.type === 'badge') {
      badgeNum += 1;
      const cx = a.x * W, cy = a.y * H;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = Math.max(2, radius * 0.12);
      ctx.stroke();
      ctx.fillStyle = color === '#FFFFFF' ? '#1C1C1E' : '#FFFFFF';
      ctx.font = `700 ${radius * 1.25}px "DM Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(badgeNum), cx, cy + radius * 0.05);
    }
    ctx.restore();
  }
}

async function getAnnotatedDataUrl(step, colorKey, showTimestamp, timestampPosition, timestampStyle) {
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
      drawHighlightBox(ctx, img, step, colorKey);
      // Manual markup sits above the automatic highlight box and below the
      // timestamp. Every export and the clipboard copy go through this function,
      // so this one call is what carries annotations into PDF/Word/HTML/MD/JSON.
      drawAnnotations(ctx, canvas, step.annotations);

      if (showTimestamp) {
        drawTimestampOnCanvas(canvas, ctx, step.timestamp, timestampPosition, timestampStyle);
      }

      // Use PNG for clipboard support (JPEG is often rejected by browsers for ClipboardItem)
      const dataUrl = canvas.toDataURL('image/png');
      revoke();
      resolve(dataUrl);
    };
    img.onerror = () => { revoke(); resolve(null); };
    img.src = srcUrl;
  });
}

function ScreenshotCanvas({ step, highlightColor = 'red', showTimestamp = true, timestampPosition = 'bottom_right', timestampStyle = 'minimal_black' }) {
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
        drawCanvas(img, highlightColor, showTimestamp, timestampPosition, timestampStyle);
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

  // Redraw when color or timestamp visibility changes (no re-fetch needed)
  useEffect(() => {
    if (imgRef.current) drawCanvas(imgRef.current, highlightColor, showTimestamp, timestampPosition, timestampStyle);
  }, [highlightColor, showTimestamp, timestampPosition, timestampStyle]); // eslint-disable-line react-hooks/exhaustive-deps

  function drawCanvas(img, color, showTime, position, style) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width  = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    drawHighlightBox(ctx, img, step, color);
    // Same order as getAnnotatedDataUrl() so the preview matches the export.
    drawAnnotations(ctx, canvas, step.annotations);

    if (showTime) {
      drawTimestampOnCanvas(canvas, ctx, step.timestamp, position, style);
    }
  }

  return <canvas ref={canvasRef} style={{ maxWidth: '100%', display: 'block' }} />;
}

// ─── Step Editor: annotations + redaction in one workspace ───────────────────
// Holds both kinds of edit in a single `edits` list so undo/delete/clear work
// across them, but they are saved very differently:
//   • arrows / boxes / text / badges → step.annotations, drawn at display time.
//     Non-destructive, so they stay editable and the bitmap is never rewritten.
//   • blur → flattened into the stored screenshot on save. Redaction MUST be
//     destructive; keeping it as a display-time overlay would leave the
//     unobscured pixels sitting in IndexedDB and the privacy claim would be false.
// Inside the editor blur is still undoable, because nothing is committed until
// Apply & Save.
function StepEditorWorkspace({
  step,
  highlightColor = 'red',
  showTimestamp = true,
  timestampPosition = 'bottom_right',
  timestampStyle = 'minimal_black',
  onSave,
  onCancel,
}) {
  const canvasRef = useRef(null);
  const [img, setImg]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const [tool, setTool]   = useState('arrow');
  const [color, setColor] = useState(ANNOT_COLORS[0]);
  // One ordered list of every edit. Derived views below keep draw order and badge
  // numbering stable, and let a single undo stack cover both kinds.
  const [edits, setEdits] = useState(
    () => (Array.isArray(step.annotations) ? step.annotations : [])
  );
  const [draft, setDraft]           = useState(null);     // shape mid-drag
  const [selectedId, setSelectedId] = useState(null);
  const [textDraft, setTextDraft]   = useState(null);     // { x, y, color, value }
  const [saving, setSaving]         = useState(false);
  const isDrawing = useRef(false);
  const startRef  = useRef(null);
  const textInputRef = useRef(null);
  const textOpen = !!textDraft;

  const annotations = edits.filter(e => e.type !== 'blur');
  const blurRects   = edits.filter(e => e.type === 'blur');

  // Blur has to be written back into the screenshot record, which legacy steps
  // (base64 in step.screenshot, no screenshotId) don't have. Annotations still
  // work on those, so disable just this one tool rather than the whole editor.
  const canBlur = !!step.screenshotId;

  // Load the screenshot once. isMounted stops
  // a late onload from touching an unmounted component, revokeFn frees the blob URL.
  useEffect(() => {
    let revokeFn = null;
    let isMounted = true;
    (async () => {
      const result = await resolveScreenshotUrl(step);
      if (!result || !isMounted) {
        if (isMounted) { setError('Screenshot not found for this step.'); setLoading(false); }
        if (result) result.revoke();
        return;
      }
      revokeFn = result.revoke;
      const image = new Image();
      image.onload = () => {
        if (!isMounted) return;
        setImg(image);
        setLoading(false);
      };
      image.onerror = () => {
        if (!isMounted) return;
        setError('Failed to load image.');
        setLoading(false);
      };
      image.src = result.url;
    })();
    return () => { isMounted = false; if (revokeFn) revokeFn(); };
  }, [step.id]);

  // Repaint the whole scene from the pristine image on every change. The old
  // redaction editor baked each blur into the bitmap as it was drawn, which is
  // why it could never be undone; rebuilding from scratch makes every edit
  // reversible right up until Apply & Save. Blur is re-derived from the clean
  // image each pass, so repainting never compounds its intensity.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    canvas.width  = img.width  || 1280;
    canvas.height = img.height || 720;
    ctx.drawImage(img, 0, 0);
    // Blur first: it self-composites the canvas, so anything drawn earlier would
    // get smeared into it.
    applyBlurRects(ctx, canvas, blurRects);
    drawHighlightBox(ctx, img, step, highlightColor);
    drawAnnotations(ctx, canvas, annotations);
    if (draft) {
      if (draft.type === 'blur') {
        // Preview the blur region as an outline rather than blurring live — much
        // cheaper than re-running the filter on every mousemove.
        ctx.save();
        ctx.strokeStyle = '#185FA5';
        ctx.fillStyle   = 'rgba(24,95,165,0.12)';
        ctx.lineWidth   = Math.max(2, canvas.width * 0.002);
        const bx = draft.x * canvas.width,  by = draft.y * canvas.height;
        const bw = draft.w * canvas.width,  bh = draft.h * canvas.height;
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeRect(bx, by, bw, bh);
        ctx.restore();
      } else {
        drawAnnotations(ctx, canvas, [draft]);
      }
    }
    if (showTimestamp) {
      drawTimestampOnCanvas(canvas, ctx, step.timestamp, timestampPosition, timestampStyle);
    }

    // Dashed outline so the user can see what Delete will remove.
    const sel = edits.find(a => a.id === selectedId);
    if (sel) {
      const b = annotationBounds(sel, canvas.width, canvas.height);
      const pad = Math.max(6, canvas.width * 0.006);
      ctx.save();
      ctx.strokeStyle = '#007AFF';
      ctx.lineWidth = Math.max(2, canvas.width * 0.002);
      ctx.setLineDash([pad, pad * 0.7]);
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      ctx.restore();
    }
  }, [img, edits, draft, selectedId, highlightColor, showTimestamp, timestampPosition, timestampStyle]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the label input when it opens. Keyed on open/closed rather than on the
  // draft object, so it doesn't re-focus (and reset the caret) on every keystroke.
  // Replaces autoFocus, which fired before the browser's default mousedown action
  // and so lost the focus it had just taken.
  useEffect(() => {
    if (textOpen && textInputRef.current) textInputRef.current.focus();
  }, [textOpen]);

  useEffect(() => {
    const onKey = (e) => {
      if (!e.key) return; // guards the toLowerCase() below on odd key events
      if (e.key === 'Escape') {
        // Escape dismisses an open text input first; only then does it close the editor.
        if (textDraft) { setTextDraft(null); return; }
        onCancel();
        return;
      }
      if (textDraft) return; // don't steal keys while a label is being typed
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        setEdits(prev => prev.filter(a => a.id !== selectedId));
        setSelectedId(null);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        setEdits(prev => prev.slice(0, -1));
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, textDraft, selectedId]);

  // Client coords → canvas pixels, clamped.
  const getCanvasPos = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top)  * scaleY;
    return {
      x: Math.max(0, Math.min(x, canvas.width)),
      y: Math.max(0, Math.min(y, canvas.height)),
    };
  };

  // Shapes are stored normalised so they land correctly at any capture size.
  const toNorm = (pos) => {
    const canvas = canvasRef.current;
    return { x: pos.x / (canvas?.width || 1), y: pos.y / (canvas?.height || 1) };
  };

  const handleMouseDown = (e) => {
    // Without this the browser's default mousedown action moves focus off the
    // text input we are about to mount (a canvas isn't focusable, so focus falls
    // to body), which used to close the label box the instant it appeared. Also
    // stops stray text/image selection while dragging a shape.
    e.preventDefault();

    // A label already being typed is committed by this click rather than
    // swallowed by it, so consecutive labels need no extra click.
    if (textDraft) {
      const pending = textDraftToAnnotation();
      if (pending) setEdits(prev => [...prev, pending]);
      setTextDraft(null);
    }

    const pos = getCanvasPos(e);
    const n   = toNorm(pos);

    if (tool === 'select') {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Topmost first, so the shape drawn last wins an overlap.
      const hit = [...edits].reverse().find(a => {
        const b = annotationBounds(a, canvas.width, canvas.height);
        const pad = Math.max(8, canvas.width * 0.006);
        return pos.x >= b.x - pad && pos.x <= b.x + b.w + pad
            && pos.y >= b.y - pad && pos.y <= b.y + b.h + pad;
      });
      setSelectedId(hit ? hit.id : null);
      return;
    }

    setSelectedId(null);

    if (tool === 'blur' && !canBlur) return;

    if (tool === 'badge') {
      setEdits(prev => [...prev, { id: newAnnotationId(), type: 'badge', color, x: n.x, y: n.y }]);
      return;
    }
    if (tool === 'text') {
      setTextDraft({ x: n.x, y: n.y, color, value: '' });
      return;
    }
    isDrawing.current = true;
    startRef.current  = n;
  };

  const handleMouseMove = (e) => {
    if (!isDrawing.current || !startRef.current) return;
    const n = toNorm(getCanvasPos(e));
    const s = startRef.current;
    if (tool === 'arrow') {
      setDraft({ id: 'draft', type: 'arrow', color, x1: s.x, y1: s.y, x2: n.x, y2: n.y });
      return;
    }
    // Box and blur share the same drag-rectangle gesture.
    setDraft({
      id: 'draft', type: tool === 'blur' ? 'blur' : 'rect', color,
      x: Math.min(s.x, n.x), y: Math.min(s.y, n.y),
      w: Math.abs(s.x - n.x), h: Math.abs(s.y - n.y),
    });
  };

  const handleMouseUp = () => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    startRef.current  = null;
    const d = draft;
    setDraft(null);
    if (!d) return;
    // Discard accidental clicks that produced a degenerate shape.
    const span = d.type === 'arrow'
      ? Math.hypot(d.x2 - d.x1, d.y2 - d.y1)
      : Math.max(d.w, d.h);
    if (span < 0.015) return;
    setEdits(prev => [...prev, { ...d, id: newAnnotationId() }]);
  };

  const textDraftToAnnotation = () => {
    const value = (textDraft?.value || '').trim();
    if (!value) return null;
    return {
      id: newAnnotationId(), type: 'text', color: textDraft.color,
      x: textDraft.x, y: textDraft.y, text: value, size: ANNOT_DEFAULT_TEXT_SIZE,
    };
  };

  const commitTextDraft = () => {
    if (!textDraft) return;
    const a = textDraftToAnnotation();
    if (a) setEdits(prev => [...prev, a]);
    setTextDraft(null);
  };

  // Renders the blurred screenshot that will replace the stored bitmap. Only the
  // image and the blur regions go in — annotations are deliberately excluded,
  // because they are drawn again at display time and baking them here would
  // double them up. Same format and quality the old redaction editor wrote.
  const flattenBlur = () => new Promise((resolve) => {
    const c  = document.createElement('canvas');
    c.width  = img.width  || 1280;
    c.height = img.height || 720;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    applyBlurRects(cx, c, blurRects);
    c.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9);
  });

  // Apply must not drop a label the user is still typing. Clicking the button
  // blurs the input, but relying on that blur's state update to land before this
  // click handler reads `edits` would be a race, so fold it in explicitly. If the
  // blur did land first the draft is already null, so either order yields exactly
  // one copy.
  const handleApply = async () => {
    if (saving) return;
    const pending = textDraftToAnnotation();
    const finalAnnotations = pending ? [...annotations, pending] : annotations;
    setSaving(true);

    let blob = null;
    if (blurRects.length) {
      blob = await flattenBlur();
      if (!blob) {
        setSaving(false);
        alert('Could not render the blurred screenshot. Nothing was saved — please try again.');
        return;
      }
    }

    // On success the parent unmounts this editor, so only reset on failure.
    const ok = await onSave(step, finalAnnotations, blob);
    if (!ok) setSaving(false);
  };

  return (
    <div className="redact-overlay">
      <div className="redact-header">
        <div className="redact-info">
          <i className="ti ti-pencil"></i>
          <div className="redact-info-text">
            <h3>Edit Screenshot</h3>
            <p>Drag for arrows, boxes, blur · Click for text and badges</p>
          </div>
        </div>
        <div className="annot-toolbar">
          {ANNOT_TOOLS.map(t => (
            <button
              key={t.id}
              className={`annot-tool ${tool === t.id ? 'active' : ''} ${t.id === 'blur' ? 'annot-tool-blur' : ''}`}
              title={t.id === 'blur' && !canBlur
                ? 'Blur is unavailable on this older step — its screenshot is stored in an earlier format'
                : t.title}
              disabled={t.id === 'blur' && !canBlur}
              onClick={() => { setTool(t.id); setSelectedId(null); }}
            ><i className={`ti ${t.icon}`}></i></button>
          ))}
          <span className="annot-divider" />
          {ANNOT_COLORS.map(c => (
            <button
              key={c}
              className={`annot-swatch ${color === c ? 'active' : ''}`}
              style={{ background: c }}
              title={`Use ${c}`}
              onClick={() => setColor(c)}
            />
          ))}
          <span className="annot-divider" />
          <button
            className="annot-tool"
            title="Undo (Ctrl+Z)"
            disabled={!edits.length}
            onClick={() => { setEdits(prev => prev.slice(0, -1)); setSelectedId(null); }}
          ><i className="ti ti-arrow-back-up"></i></button>
          <button
            className="annot-tool"
            title="Remove all edits"
            disabled={!edits.length}
            onClick={() => { setEdits([]); setSelectedId(null); }}
          ><i className="ti ti-trash"></i></button>
        </div>
        <div className="redact-actions">
          {blurRects.length > 0 && (
            <span className="annot-blur-warning" title={`${blurRects.length} blur region${blurRects.length > 1 ? 's' : ''} will be flattened into the screenshot and cannot be undone after saving`}>
              <i className="ti ti-alert-triangle"></i>
              {blurRects.length} blur{blurRects.length > 1 ? 's' : ''} · permanent
            </span>
          )}
          <button className="btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={handleApply} disabled={saving}>
            {saving ? 'Saving…' : 'Apply & Save'}
          </button>
        </div>
      </div>
      <div className="redact-canvas-container">
        {loading && <div className="redact-status"><i className="ti ti-loader rotate"></i> Loading...</div>}
        {error && <div className="redact-status error"><i className="ti ti-alert-circle"></i> {error}</div>}

        <div className="redact-canvas-wrapper" style={{ position: 'relative', display: (loading || error) ? 'none' : 'inline-block' }}>
          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            className={`redact-canvas ${tool === 'select' ? 'annot-select' : 'drawing'}`}
          />
          {textDraft && (
            <input
              ref={textInputRef}
              className="annot-text-input"
              value={textDraft.value}
              placeholder="Type a label, then press Enter"
              style={{
                left: textDraft.x * 100 + '%',
                top:  textDraft.y * 100 + '%',
                color: textDraft.color,
              }}
              onChange={(e) => setTextDraft(d => ({ ...d, value: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitTextDraft(); } }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const StepCard = ({
  step,
  index,
  updateStepText, 
  updateStepDescription, 
  deleteStep, 
  updateStepColor, 
  guideColor, 
  showTimestamp, 
  timestampPosition, 
  timestampStyle, 
  onAnnotate,
  duplicateStep,
  draggingIndex, 
  setDraggingIndex, 
  handleReorderSteps 
}) => {
  const [desc, setDesc] = useState(step.description || '');
  const [action, setAction] = useState(step.action || '');
  const [isEditingAction, setIsEditingAction] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
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
    <div 
      className={`step-card ${isDragOver ? 'drag-over' : ''} ${draggingIndex === index ? 'dragging' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', index.toString());
        setDraggingIndex(index);
      }}
      onDragEnd={() => setDraggingIndex(null)}
      onDragOver={(e) => {
        e.preventDefault();
        if (draggingIndex !== index) {
          setIsDragOver(true);
        }
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={async (e) => {
        setIsDragOver(false);
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const toIdx = index;
        if (fromIdx === toIdx) return;
        await handleReorderSteps(fromIdx, toIdx);
      }}
    >
      <div className="step-header">
        <div className="drag-handle" title="Drag to reorder step">
          <i className="ti ti-grip-vertical"></i>
        </div>
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
            {step.stepType !== 'note' && (
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
            )}

            <span className="step-type">
              {step.stepType || (step.elementData ? 'click' : 'scroll')}
            </span>
            <button className="btn-danger" style={{ padding: '4px', border: 'none' }} onClick={() => deleteStep(step)} title="Delete step">
              <i className="ti ti-trash" style={{ fontSize: '13px' }}></i>
            </button>
            {step.stepType !== 'note' && (
              <button
                className="btn-secondary"
                style={{ padding: '4px', position: 'relative' }}
                onClick={() => onAnnotate(step)}
                title="Edit screenshot — arrows, boxes, text, numbers, blur"
              >
                <i className="ti ti-pencil" style={{ fontSize: '13px', color: '#D9480F' }}></i>
                {Array.isArray(step.annotations) && step.annotations.length > 0 && (
                  <span className="annot-count">{step.annotations.length}</span>
                )}
              </button>
            )}
            <button 
              className="btn-secondary" 
              style={{ padding: '4px' }} 
              onClick={() => duplicateStep(step, index)}
              title="Duplicate step"
            >
              <i className="ti ti-files" style={{ fontSize: '13px', color: '#185FA5' }}></i>
            </button>
            {step.stepType !== 'note' && (
              <button 
                className="btn-secondary" 
                style={{ padding: '4px' }} 
                onClick={async (e) => {
                  const btn = e.currentTarget;
                  const icon = btn.querySelector('i');
                  const originalClass = icon.className;
                  
                  try {
                    icon.className = 'ti ti-loader rotate';
                    const activeColor = step.color || guideColor || 'red';
                    const dataUrl = await getAnnotatedDataUrl(step, activeColor, showTimestamp, timestampPosition, timestampStyle);
                    
                    const plainText = `${step.action}${step.description ? '\n' + step.description : ''}`;
                    const clipboardData = {
                      'text/plain': new Blob([plainText], { type: 'text/plain' })
                    };

                    if (dataUrl) {
                      const response = await fetch(dataUrl);
                      const blob = await response.blob();
                      clipboardData['image/png'] = blob;
                      
                      // Add HTML part so rich text editors (Gmail, Slack) paste both text and image!
                      const htmlContent = `
                        <div style="font-family: sans-serif;">
                          <h3 style="margin:0 0 8px; color:#185FA5;">${escapeHtmlText(step.action)}</h3>
                          ${step.description ? `<p style="margin:0 0 12px; color:#4b5563;">${escapeHtmlText(step.description)}</p>` : ''}
                          <img src="${dataUrl}" style="max-width:100%; border-radius:8px; border:1px solid #e5e7eb;" />
                        </div>
                      `;
                      clipboardData['text/html'] = new Blob([htmlContent], { type: 'text/html' });
                    }

                    await navigator.clipboard.write([
                      new ClipboardItem(clipboardData)
                    ]);
                    
                    icon.className = 'ti ti-check';
                    setTimeout(() => { icon.className = originalClass; }, 2000);
                  } catch (err) {
                    console.error('Clipboard error:', err);
                    // Fallback: copy text only
                    navigator.clipboard.writeText(step.action);
                    icon.className = 'ti ti-alert-circle';
                    setTimeout(() => { icon.className = originalClass; }, 2000);
                  }
                }}
                title="Copy step (Text & Image)"
              >
                <i className="ti ti-copy" style={{ fontSize: '13px' }}></i>
              </button>
            )}
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

      {step.stepType !== 'note' && (
        <div className={`screenshot-area ${(step.screenshot || step.screenshotId) ? '' : 'empty'}`}>
          {(step.screenshot || step.screenshotId) ? (
            <ScreenshotCanvas 
              step={step} 
              highlightColor={activeColor} 
              showTimestamp={showTimestamp} 
              timestampPosition={timestampPosition} 
              timestampStyle={timestampStyle} 
            />
          ) : (
            <>
              <div className="highlight-box">
                <i className="ti ti-crop"></i>
              </div>
              <p className="empty-text">Screenshot captured</p>
            </>
          )}
        </div>
      )}
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
  // One editor now covers annotations and redaction, so one piece of state.
  const [editingStep, setEditingStep]       = useState(null);

  // Premium Enhancements States
  const [draggingIndex, setDraggingIndex] = useState(null);
  const [exportProgress, setExportProgress] = useState(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [includeCoverPage, setIncludeCoverPage] = useState(false);
  const [coverTitle, setCoverTitle] = useState('');
  const [coverSubtitle, setCoverSubtitle] = useState('Step-by-step Guide');
  const [coverAuthor, setCoverAuthor] = useState('');
  const [coverOrg, setCoverOrg] = useState('');
  const [coverLogo, setCoverLogo] = useState(null);
  const [showTimestampPopover, setShowTimestampPopover] = useState(false);
  
  // ── Bulk Export State ──────────────────────────────────────────────────
  const [bulkMode, setBulkMode]             = useState(false);
  const [selectedIds, setSelectedIds]       = useState([]); // order is preserved here
  const [isExportingBulk, setIsExportingBulk] = useState(false);
  const [bulkTitle, setBulkTitle]           = useState('Bulk Export');
  const [editingBulkTitle, setEditingBulkTitle] = useState(false);
  const [bulkTitleInput, setBulkTitleInput] = useState('Bulk Export');

  const lastRequestedId = useRef(null);

  const showTimestamp = selectedGuide?.showTimestamp !== false;
  const timestampPosition = selectedGuide?.timestampPosition || 'bottom_right';
  const timestampStyle = selectedGuide?.timestampStyle || 'minimal_black';

  useEffect(() => {
    if (selectedGuide) {
      setCoverTitle(selectedGuide.title || '');
    }
  }, [selectedGuide]);

  useEffect(() => {
    loadGuides();
    loadStorageStats();
    loadRecordingStatus();

    const urlParams = new URLSearchParams(window.location.search);
    const guideId = urlParams.get('guideId');
    if (guideId) loadGuideDetails(guideId);
  }, []); // Run ONLY once on mount

  useEffect(() => {
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
        
        try {
          const newUrl = `${window.location.origin}${window.location.pathname}?guideId=${id}`;
          window.history.pushState({ path: newUrl }, '', newUrl);
        } catch (e) {
          console.warn('[Steply] Failed to update URL query parameter:', e);
        }
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

        try {
          const newUrl = `${window.location.origin}${window.location.pathname}`;
          window.history.pushState({ path: newUrl }, '', newUrl);
        } catch (e) {
          console.warn('[Steply] Failed to update URL query parameter:', e);
        }
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
      // Functional form: a stale snapshot here would re-add steps deleted in the
      // meantime. Same reason as deleteStep below.
      setSelectedGuide(prev => prev
        ? { ...prev, steps: (prev.steps || []).map(s => s.id === step.id ? { ...s, action: actionText } : s) }
        : prev);
    });
  };

  const updateStepDescription = (step, description) => {
    chrome.runtime.sendMessage({ action: 'updateStepDescription', stepId: step.id, description }, (res) => {
      if (res?.error) {
        alert(`Failed to update description: ${res.error}`);
        return;
      }
      setSelectedGuide(prev => prev
        ? { ...prev, steps: (prev.steps || []).map(s => s.id === step.id ? { ...s, description } : s) }
        : prev);
    });
  };

  const updateStepColor = (step, color) => {
    chrome.runtime.sendMessage({ action: 'updateStepColor', stepId: step.id, color }, (res) => {
      if (res?.error) {
        alert(`Failed to update color: ${res.error}`);
        return;
      }
      setSelectedGuide(prev => prev
        ? { ...prev, steps: (prev.steps || []).map(s => s.id === step.id ? { ...s, color } : s) }
        : prev);
    });
  };

  // Flattens a blurred bitmap over the step's stored screenshot. Same IndexedDB
  // work the old standalone redaction save did — storageBytes delta, updatedAt —
  // but it now reports success instead of driving the UI, so the combined save
  // below can sequence it ahead of the annotation write.
  const writeRedactedScreenshot = (step, blob) => new Promise(async (resolve) => {
    try {
      const db = await openDashboardDb();
      const tx = db.transaction(['screenshots', 'guides'], 'readwrite');

      const ssStore = tx.objectStore('screenshots');
      const oldSs = await new Promise(r => {
        const req = ssStore.get(step.screenshotId);
        req.onsuccess = (e) => r(e.target.result);
      });
      const sizeDiff = blob.size - (oldSs?.blob?.size || 0);

      ssStore.put({ id: step.screenshotId, guideId: selectedGuide.id, blob });

      const guideStore = tx.objectStore('guides');
      const guide = await new Promise(r => {
        const req = guideStore.get(selectedGuide.id);
        req.onsuccess = (e) => r(e.target.result);
      });

      if (guide) {
        guide.storageBytes = (guide.storageBytes || 0) + sizeDiff;
        guide.updatedAt = new Date().toISOString();
        guideStore.put(guide);
      }

      tx.oncomplete = () => resolve(true);

      // A transaction that errors or aborts (quota, blocked upgrade) never fires
      // oncomplete, so without these the write silently did nothing.
      tx.onerror = tx.onabort = (ev) => {
        console.error('[Dashboard] redaction transaction failed:', ev.target?.error);
        alert('Failed to save redacted image: ' + (ev.target?.error?.message || 'storage error'));
        resolve(false);
      };
    } catch (e) {
      alert('Failed to save redacted image: ' + e.message);
      resolve(false);
    }
  });

  // One save for both kinds of edit the step editor produces.
  //
  // Blur goes first because it is the destructive half: if flattening the bitmap
  // fails we stop without touching anything, so the editor stays open with the
  // user's work intact rather than reporting success on a redaction that never
  // landed. Annotations are a plain field on the step record and can't lose a
  // capture. _refresh is bumped so the step list's key changes and
  // ScreenshotCanvas remounts to redraw — the mechanism redaction already used.
  // Resolves true only once everything landed, so the editor can re-enable its
  // buttons on failure instead of sitting disabled on "Saving…" forever.
  const handleSaveStepEdits = async (step, annotations, blurBlob) => {
    if (blurBlob) {
      const ok = await writeRedactedScreenshot(step, blurBlob);
      if (!ok) return false;
      loadStorageStats(); // the stored screenshot changed size
    }
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: 'updateStepAnnotations', stepId: step.id, annotations },
        (res) => {
          if (res?.error) {
            alert(`Failed to save annotations: ${res.error}`);
            resolve(false);
            return;
          }
          setEditingStep(null);
          setSelectedGuide(prev => prev
            ? {
                ...prev,
                steps: (prev.steps || []).map(s =>
                  s.id === step.id ? { ...s, annotations, _refresh: Date.now() } : s),
              }
            : prev);
          resolve(true);
        }
      );
    });
  };

  const deleteStep = (step) => {
    if (window.confirm('Are you sure you want to delete this step?')) {
      chrome.runtime.sendMessage({ action: 'deleteStep', stepId: step.id }, (res) => {
        if (res?.error) {
          alert(`Failed to delete step: ${res.error}`);
          return;
        }
        // Rebuild from `prev`, not from the `selectedGuide` this callback closed
        // over at render time. With the stale snapshot, deleting two steps before
        // a re-render landed resurrected the first one — a card whose record and
        // screenshot blob were already gone, so it rendered blank — and left
        // stepCount untouched, so the sidebar and the header disagreed.
        setSelectedGuide(prev => {
          if (!prev) return prev;
          const newSteps = (prev.steps || []).filter(s => s.id !== step.id);
          return { ...prev, steps: newSteps, stepCount: newSteps.length };
        });
        loadGuides();        // refresh sidebar count
        loadStorageStats();  // the screenshot blob is gone too
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


  // BUG N: sanitize title before using as filename — remove chars illegal on Windows/macOS
  const sanitizeFilename = (title) =>
    (title || 'Untitled').replace(/[/\\:*?"<>|]/g, '-').replace(/^[-\s]+|[-\s]+$/g, '') || 'Untitled';

  // ── Timeline Operations (Premium) ──────────────────────────────────────────
  const handleReorderSteps = async (fromIdx, toIdx) => {
    const steps = [...selectedGuide.steps];
    const [moved] = steps.splice(fromIdx, 1);
    steps.splice(toIdx, 0, moved);

    // Reassign sequential timestamps
    const baseTime = new Date(selectedGuide.createdAt || Date.now()).getTime();
    const updatedSteps = steps.map((s, idx) => ({
      ...s,
      timestamp: new Date(baseTime + idx * 10000).toISOString()
    }));

    try {
      const db = await openDashboardDb();
      const tx = db.transaction(['steps', 'guides'], 'readwrite');
      const stepsStore = tx.objectStore('steps');
      const guideStore = tx.objectStore('guides');

      for (const step of updatedSteps) {
        stepsStore.put(step);
      }

      const guide = await new Promise(r => {
        guideStore.get(selectedGuide.id).onsuccess = (e) => r(e.target.result);
      });
      if (guide) {
        guide.updatedAt = new Date().toISOString();
        guideStore.put(guide);
      }

      tx.oncomplete = () => {
        setSelectedGuide({ 
          ...selectedGuide, 
          steps: updatedSteps,
          updatedAt: new Date().toISOString() 
        });
        loadGuides();
      };

      // Without these a failed transaction left the on-screen order unchanged and
      // said nothing; the reorder simply never happened.
      tx.onerror = tx.onabort = (ev) => {
        console.error('[Dashboard] reorder transaction failed:', ev.target?.error);
        alert("Failed to reorder steps: " + (ev.target?.error?.message || 'storage error'));
      };
    } catch (e) {
      alert("Failed to reorder steps: " + e.message);
    }
  };

  const duplicateStep = async (step, index) => {
    try {
      const db = await openDashboardDb();
      const newStepId = Date.now() + '-' + Math.random().toString(36).slice(2, 9);
      const newScreenshotId = step.screenshotId ? 'ss_' + newStepId : null;

      const tx = db.transaction(['steps', 'screenshots', 'guides'], 'readwrite');
      const stepsStore = tx.objectStore('steps');
      const ssStore = tx.objectStore('screenshots');
      const guideStore = tx.objectStore('guides');

      let ssSize = 0;
      if (step.screenshotId) {
        const originalSs = await new Promise(r => {
          ssStore.get(step.screenshotId).onsuccess = (e) => r(e.target.result);
        });
        if (originalSs) {
          ssSize = originalSs.blob?.size || 0;
          ssStore.put({
            id: newScreenshotId,
            guideId: selectedGuide.id,
            blob: originalSs.blob
          });
        }
      }

      const newStep = {
        ...step,
        id: newStepId,
        screenshotId: newScreenshotId,
        action: step.action + ' (Copy)',
        timestamp: new Date(new Date(step.timestamp).getTime() + 5000).toISOString()
      };

      stepsStore.put(newStep);

      const guide = await new Promise(r => {
        guideStore.get(selectedGuide.id).onsuccess = (e) => r(e.target.result);
      });
      if (guide) {
        guide.stepCount = (guide.stepCount || 0) + 1;
        guide.storageBytes = (guide.storageBytes || 0) + ssSize;
        guide.updatedAt = new Date().toISOString();
        guideStore.put(guide);
      }

      tx.oncomplete = () => {
        const newSteps = [...selectedGuide.steps];
        newSteps.splice(index + 1, 0, newStep);
        
        const baseTime = new Date(selectedGuide.createdAt || Date.now()).getTime();
        const sequentiallyTimeSteps = newSteps.map((s, idx) => ({
          ...s,
          timestamp: new Date(baseTime + idx * 10000).toISOString()
        }));

        const tx2 = db.transaction(['steps'], 'readwrite');
        for (const s of sequentiallyTimeSteps) {
          tx2.objectStore('steps').put(s);
        }
        tx2.oncomplete = () => {
          setSelectedGuide({
            ...selectedGuide,
            steps: sequentiallyTimeSteps,
            stepCount: sequentiallyTimeSteps.length,
            updatedAt: new Date().toISOString()
          });
          loadGuides();
          loadStorageStats();
        };
        tx2.onerror = tx2.onabort = (ev) => {
          console.error('[Dashboard] duplicate re-sequence transaction failed:', ev.target?.error);
          alert("Step was duplicated, but re-ordering failed: " + (ev.target?.error?.message || 'storage error'));
        };
      };

      tx.onerror = tx.onabort = (ev) => {
        console.error('[Dashboard] duplicate transaction failed:', ev.target?.error);
        alert("Failed to duplicate step: " + (ev.target?.error?.message || 'storage error'));
      };
    } catch (e) {
      alert("Failed to duplicate step: " + e.message);
    }
  };

  const handleInsertBlankStep = async (insertIndex) => {
    try {
      const db = await openDashboardDb();
      const newStepId = Date.now() + '-' + Math.random().toString(36).slice(2, 9);

      const tx = db.transaction(['steps', 'guides'], 'readwrite');
      const stepsStore = tx.objectStore('steps');
      const guideStore = tx.objectStore('guides');

      const newStep = {
        id: newStepId,
        guideId: selectedGuide.id,
        action: 'New Note Card',
        description: '',
        stepType: 'note',
        timestamp: new Date().toISOString()
      };

      stepsStore.put(newStep);

      const guide = await new Promise(r => {
        guideStore.get(selectedGuide.id).onsuccess = (e) => r(e.target.result);
      });
      if (guide) {
        guide.stepCount = (guide.stepCount || 0) + 1;
        guide.updatedAt = new Date().toISOString();
        guideStore.put(guide);
      }

      tx.oncomplete = () => {
        const newSteps = [...selectedGuide.steps];
        newSteps.splice(insertIndex, 0, newStep);

        const baseTime = new Date(selectedGuide.createdAt || Date.now()).getTime();
        const sequentiallyTimeSteps = newSteps.map((s, idx) => ({
          ...s,
          timestamp: new Date(baseTime + idx * 10000).toISOString()
        }));

        const tx2 = db.transaction(['steps'], 'readwrite');
        for (const s of sequentiallyTimeSteps) {
          tx2.objectStore('steps').put(s);
        }
        tx2.oncomplete = () => {
          setSelectedGuide({
            ...selectedGuide,
            steps: sequentiallyTimeSteps,
            stepCount: sequentiallyTimeSteps.length,
            updatedAt: new Date().toISOString()
          });
          loadGuides();
        };
        tx2.onerror = tx2.onabort = (ev) => {
          console.error('[Dashboard] insert re-sequence transaction failed:', ev.target?.error);
          alert("Note card was added, but re-ordering failed: " + (ev.target?.error?.message || 'storage error'));
        };
      };

      tx.onerror = tx.onabort = (ev) => {
        console.error('[Dashboard] insert transaction failed:', ev.target?.error);
        alert("Failed to insert blank step: " + (ev.target?.error?.message || 'storage error'));
      };
    } catch (e) {
      alert("Failed to insert blank step: " + e.message);
    }
  };

  // ── Single Export Operations ───────────────────────────────────────────────
  const exportPDF = async () => {
    if (!selectedGuide?.steps?.length) return;
    setExportProgress({ current: 0, total: selectedGuide.steps.length, format: 'PDF' });
    
    try {
      const doc = new jsPDF();
      let isFirstPage = true;

      if (includeCoverPage) {
        isFirstPage = false;
        // Top right Logo
        if (coverLogo) {
          try {
            doc.addImage(coverLogo, 'PNG', 140, 20, 50, 25);
          } catch (e) {
            console.error("PDF logo error:", e);
          }
        }
        
        // Large Title
        doc.setFontSize(28);
        doc.setTextColor(24, 95, 165); // Steply primary blue
        const splitTitle = doc.splitTextToSize(coverTitle || selectedGuide.title || 'Untitled Guide', 170);
        doc.text(splitTitle, 20, 80);
        
        // Subtitle
        if (coverSubtitle) {
          doc.setFontSize(16);
          doc.setTextColor(75, 85, 99); // gray-600
          doc.text(coverSubtitle, 20, 80 + splitTitle.length * 10);
        }
        
        // Separator line
        doc.setDrawColor(229, 231, 235);
        doc.setLineWidth(1);
        doc.line(20, 140, 190, 140);
        
        // Meta info
        doc.setFontSize(12);
        doc.setTextColor(107, 114, 128); // gray-500
        let metaY = 160;
        if (coverAuthor) {
          doc.text(`Created by: ${coverAuthor}`, 20, metaY);
          metaY += 10;
        }
        if (coverOrg) {
          doc.text(`Organization: ${coverOrg}`, 20, metaY);
          metaY += 10;
        }
        doc.text(`Date: ${new Date().toLocaleDateString()}`, 20, metaY);
      }

      for (let i = 0; i < selectedGuide.steps.length; i++) {
        const step = selectedGuide.steps[i];
        
        if (isFirstPage) {
          isFirstPage = false;
        } else {
          doc.addPage();
        }

        let y = 20;
        doc.setFontSize(16);
        doc.setTextColor(17, 24, 39); // Gray 900
        const stepTitleLines = doc.splitTextToSize(`Step ${i + 1}: ${step.action}`, 180);
        doc.text(stepTitleLines, 10, y);
        y += stepTitleLines.length * 7 + 2;

        if (step.description) {
          doc.setFontSize(11);
          doc.setTextColor(100);
          const lines = doc.splitTextToSize(step.description, 180);
          doc.text(lines, 10, y);
          y += lines.length * 6 + 4;
        }
        
        if (step.stepType !== 'note' && (step.screenshot || step.screenshotId)) {
          const stepColor = step.color || selectedGuide.defaultColor || 'red';
          const annotated = await getAnnotatedDataUrl(
            step, 
            stepColor, 
            showTimestamp,
            timestampPosition,
            timestampStyle
          );
          if (annotated) {
            doc.addImage(annotated, 'JPEG', 10, y, 180, 100);
          } else {
            doc.setFontSize(10);
            doc.setTextColor(150);
            doc.text("[Image not available]", 10, y + 5);
          }
        }
        
        setExportProgress({ current: i + 1, total: selectedGuide.steps.length, format: 'PDF' });
      }
      
      doc.save(`${sanitizeFilename(selectedGuide.title)}.pdf`);
    } catch (err) {
      alert("Failed to export PDF: " + err.message);
    } finally {
      setExportProgress(null);
    }
  };

  const exportMarkdown = async () => {
    if (!selectedGuide?.steps?.length) return;
    setExportProgress({ current: 0, total: selectedGuide.steps.length, format: 'Markdown' });
    
    try {
      let md = '';
      if (includeCoverPage) {
        if (coverLogo) md += `![Company Logo](${coverLogo})\n\n`;
        md += `# ${coverTitle || selectedGuide.title}\n\n`;
        if (coverSubtitle) md += `## ${coverSubtitle}\n\n`;
        if (coverAuthor) md += `**Author:** ${coverAuthor}  \n`;
        if (coverOrg) md += `**Organization:** ${coverOrg}  \n`;
        md += `**Date:** ${new Date().toLocaleDateString()}\n\n---\n\n`;
      } else {
        md += `# ${selectedGuide.title}\n\n`;
      }

      for (let i = 0; i < selectedGuide.steps.length; i++) {
        const step = selectedGuide.steps[i];
        md += `## Step ${i + 1}: ${step.action}\n`;
        if (step.description) md += `\n> ${step.description}\n`;
        if (step.stepType !== 'note' && (step.screenshot || step.screenshotId)) {
          const stepColor = step.color || selectedGuide.defaultColor || 'red';
          const annotated = await getAnnotatedDataUrl(
            step, 
            stepColor, 
            showTimestamp,
            timestampPosition,
            timestampStyle
          );
          if (annotated) md += `\n![Screenshot](${annotated})\n`;
        }
        md += `\n`;
        setExportProgress({ current: i + 1, total: selectedGuide.steps.length, format: 'Markdown' });
      }
      downloadFile(new Blob([md], { type: 'text/markdown' }), `${sanitizeFilename(selectedGuide.title)}.md`);
    } catch (err) {
      alert("Failed to export Markdown: " + err.message);
    } finally {
      setExportProgress(null);
    }
  };

  const exportWord = async () => {
    if (!selectedGuide?.steps?.length) return;
    setExportProgress({ current: 0, total: selectedGuide.steps.length, format: 'Word' });
    
    try {
      const children = [];

      if (includeCoverPage) {
        if (coverLogo) {
          try {
            const b64 = coverLogo.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
            const bin = window.atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
            children.push(new Paragraph({ children: [new ImageRun({ data: bytes, transformation: { width: 120, height: 60 } })] }));
          } catch (e) { console.error('Word logo error:', e); }
        }
        
        children.push(new Paragraph({ text: coverTitle || selectedGuide.title || 'Untitled', heading: 'Title', spacing: { before: 2000, after: 200 } }));
        if (coverSubtitle) {
          children.push(new Paragraph({ text: coverSubtitle, heading: 'Subtitle', spacing: { after: 1200 } }));
        }
        if (coverAuthor) {
          children.push(new Paragraph({ text: `Author: ${coverAuthor}` }));
        }
        if (coverOrg) {
          children.push(new Paragraph({ text: `Organization: ${coverOrg}` }));
        }
        children.push(new Paragraph({ text: `Date: ${new Date().toLocaleDateString()}`, spacing: { after: 2000 } }));
        
        // Page break
        children.push(new Paragraph({ text: "", pageBreakBefore: true }));
      }

      // Prepend main title
      children.push(new Paragraph({ text: selectedGuide.title, heading: 'Heading1', spacing: { after: 400 } }));

      for (let i = 0; i < selectedGuide.steps.length; i++) {
        const step = selectedGuide.steps[i];
        children.push(new Paragraph({ text: `Step ${i + 1}: ${step.action}`, heading: 'Heading2', spacing: { before: 400, after: 200 } }));
        if (step.description) {
          children.push(new Paragraph({ text: step.description, spacing: { after: 200 } }));
        }
        if (step.stepType !== 'note' && (step.screenshot || step.screenshotId)) {
          try {
            const stepColor = step.color || selectedGuide.defaultColor || 'red';
            const annotated = await getAnnotatedDataUrl(
              step, 
              stepColor, 
              showTimestamp,
              timestampPosition,
              timestampStyle
            );
            if (annotated) {
              const b64  = annotated.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
              const bin  = window.atob(b64);
              const bytes = new Uint8Array(bin.length);
              for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
              children.push(new Paragraph({ children: [new ImageRun({ data: bytes, transformation: { width: 500, height: 300 } })] }));
            }
          } catch (e) { console.error('Word image error:', e); }
        }
        setExportProgress({ current: i + 1, total: selectedGuide.steps.length, format: 'Word' });
      }

      const blob = await Packer.toBlob(new Document({ sections: [{ children }] }));
      downloadFile(blob, `${sanitizeFilename(selectedGuide.title)}.docx`);
    } catch (err) {
      alert("Failed to export Word: " + err.message);
    } finally {
      setExportProgress(null);
    }
  };

  const exportJSON = async () => {
    if (!selectedGuide?.steps?.length) return;
    setExportProgress({ current: 0, total: selectedGuide.steps.length, format: 'JSON' });
    
    try {
      const standardizeStep = async (step, defaultColor, showTimestamp, timestampPosition, timestampStyle) => ({
        id: step.id || "",
        guideId: step.guideId || "",
        action: step.action || "",
        description: step.description || "",
        stepType: step.stepType || "click",
        elementData: step.elementData || null,
        // screenshotDataUrl below already has the markup rendered into it; the raw
        // array is emitted too so the bundle stays round-trippable.
        annotations: Array.isArray(step.annotations) ? step.annotations : [],
        color: step.color || null,
        timestamp: step.timestamp || new Date().toISOString(),
        screenshotId: step.screenshotId || null,
        screenshotDataUrl: (step.stepType !== 'note' && (step.screenshot || step.screenshotId)) 
          ? await getAnnotatedDataUrl(step, step.color || defaultColor || 'red', showTimestamp, timestampPosition, timestampStyle) 
          : null
      });

      const processedSteps = [];
      for (let i = 0; i < selectedGuide.steps.length; i++) {
        const s = selectedGuide.steps[i];
        const processed = await standardizeStep(
          s, 
          selectedGuide.defaultColor, 
          showTimestamp,
          timestampPosition,
          timestampStyle
        );
        processedSteps.push(processed);
        setExportProgress({ current: i + 1, total: selectedGuide.steps.length, format: 'JSON' });
      }

      const exportData = {
        exportType: "steply_bundle",
        version: "1.0",
        exportTitle: selectedGuide.title || "Untitled",
        exportedAt: new Date().toISOString(),
        guides: [
          {
            id: selectedGuide.id || "",
            title: selectedGuide.title || "Untitled",
            url: selectedGuide.url || "",
            createdAt: selectedGuide.createdAt || new Date().toISOString(),
            updatedAt: selectedGuide.updatedAt || new Date().toISOString(),
            stepCount: selectedGuide.stepCount || 0,
            defaultColor: selectedGuide.defaultColor || "red",
            steps: processedSteps
          }
        ]
      };

      const jsonString = JSON.stringify(exportData, null, 2);
      downloadFile(
        new Blob([jsonString], { type: 'application/json' }), 
        `${sanitizeFilename(selectedGuide.title)}.json`
      );
    } catch (err) {
      alert("Failed to export JSON: " + err.message);
    } finally {
      setExportProgress(null);
    }
  };

  const exportHTML = async () => {
    if (!selectedGuide?.steps?.length) return;
    setExportProgress({ current: 0, total: selectedGuide.steps.length, format: 'HTML' });
    
    try {
      let stepsHtml = '';
      for (let i = 0; i < selectedGuide.steps.length; i++) {
        const step = selectedGuide.steps[i];
        const stepColor = step.color || selectedGuide.defaultColor || 'red';
        const annotated = (step.stepType !== 'note' && (step.screenshot || step.screenshotId))
          ? await getAnnotatedDataUrl(
              step, 
              stepColor, 
              showTimestamp,
              timestampPosition,
              timestampStyle
            )
          : null;
          
        stepsHtml += `
          <div class="step-card">
            <div class="step-header">
              <div class="step-num">${i + 1}</div>
              <h3 class="step-title">${escapeHtml(step.action)}</h3>
            </div>
            ${step.description ? `<div class="step-description">${escapeHtml(step.description)}</div>` : ''}
            ${annotated ? `<div class="step-screenshot-wrap"><img src="${annotated}" alt="Step ${i+1} Screenshot" /></div>` : ''}
          </div>
        `;
        setExportProgress({ current: i + 1, total: selectedGuide.steps.length, format: 'HTML' });
      }
      
      let coverHtml = '';
      if (includeCoverPage) {
        coverHtml = `
          <div class="cover-page">
            ${coverLogo ? `<img src="${coverLogo}" class="cover-logo" alt="Logo" />` : ''}
            <h1 class="cover-title">${escapeHtml(coverTitle || selectedGuide.title)}</h1>
            ${coverSubtitle ? `<p class="cover-subtitle">${escapeHtml(coverSubtitle)}</p>` : ''}
            <div class="cover-divider"></div>
            <div class="cover-meta">
              ${coverAuthor ? `<p><strong>Created by:</strong> ${escapeHtml(coverAuthor)}</p>` : ''}
              ${coverOrg ? `<p><strong>Organization:</strong> ${escapeHtml(coverOrg)}</p>` : ''}
              <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            </div>
          </div>
          <div class="page-break"></div>
        `;
      }

      const fullHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(selectedGuide.title)}</title>
  <style>
    :root {
      --primary-color: #185FA5;
      --bg-color: #fafafa;
      --card-bg: #ffffff;
      --text-primary: #111827;
      --text-secondary: #4b5563;
      --border-color: #e5e7eb;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg-color);
      color: var(--text-primary);
      margin: 0;
      padding: 40px 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .container {
      max-width: 680px;
      width: 100%;
    }
    .cover-page {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 60px 40px;
      margin-bottom: 40px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04);
      text-align: left;
      position: relative;
    }
    .cover-logo {
      max-height: 60px;
      max-width: 160px;
      margin-bottom: 40px;
      display: block;
    }
    .cover-title {
      font-size: 32px;
      font-weight: 700;
      color: var(--primary-color);
      margin: 0 0 10px;
      line-height: 1.2;
    }
    .cover-subtitle {
      font-size: 18px;
      color: var(--text-secondary);
      margin: 0 0 30px;
    }
    .cover-divider {
      height: 1px;
      background: var(--border-color);
      margin: 30px 0;
    }
    .cover-meta p {
      margin: 6px 0;
      font-size: 14px;
      color: var(--text-secondary);
    }
    .guide-header {
      margin-bottom: 30px;
      text-align: center;
    }
    .guide-title {
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 6px;
    }
    .guide-meta {
      font-size: 13px;
      color: var(--text-secondary);
      margin: 0;
    }
    .step-card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.02);
    }
    .step-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-color);
    }
    .step-num {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--primary-color);
      color: white;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .step-title {
      font-size: 15px;
      font-weight: 600;
      margin: 0;
      color: var(--text-primary);
    }
    .step-description {
      padding: 12px 20px;
      font-size: 14px;
      color: var(--text-secondary);
      background: #f8fafc;
      border-bottom: 1px solid var(--border-color);
      line-height: 1.6;
    }
    .step-screenshot-wrap {
      background: #0f1929;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .step-screenshot-wrap img {
      max-width: 100%;
      height: auto;
      display: block;
    }
    @media print {
      body {
        background: white;
        padding: 0;
      }
      .container {
        max-width: 100%;
      }
      .page-break {
        page-break-after: always;
      }
      .step-card {
        box-shadow: none;
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    ${coverHtml}
    ${!includeCoverPage ? `
    <div class="guide-header">
      <h1 class="guide-title">${escapeHtml(selectedGuide.title)}</h1>
      <p class="guide-meta">${selectedGuide.steps.length} steps · Created on ${new Date(selectedGuide.createdAt).toLocaleDateString()}</p>
    </div>
    ` : ''}
    <div class="steps-list">
      ${stepsHtml}
    </div>
  </div>
</body>
</html>
      `;
      downloadFile(new Blob([fullHtml], { type: 'text/html' }), `${sanitizeFilename(selectedGuide.title)}.html`);
    } catch (err) {
      alert("Failed to export HTML: " + err.message);
    } finally {
      setExportProgress(null);
    }
  };

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── Bulk Export Logic ──────────────────────────────────────────────────────
  const toggleBulkMode = () => {
    setBulkMode(!bulkMode);
    setExportOpen(false); // Close dropdown when switching
    if (!bulkMode) {
      setBulkTitle('Bulk Export');
      setBulkTitleInput('Bulk Export');
    }
    if (bulkMode) setSelectedIds([]); // clear on exit
  };

  const updateBulkTitle = () => {
    const safeTitle = bulkTitleInput.trim() || 'Bulk Export';
    setBulkTitle(safeTitle);
    setBulkTitleInput(safeTitle);
    setEditingBulkTitle(false);
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === guides.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(guides.map(g => g.id));
    }
  };

  const toggleSelectGuide = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const moveBulkItem = (index, direction) => {
    const newIds = [...selectedIds];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= newIds.length) return;
    const [moved] = newIds.splice(index, 1);
    newIds.splice(targetIndex, 0, moved);
    setSelectedIds(newIds);
  };

  const runBulkExport = async (format) => {
    if (!selectedIds.length) return;
    setIsExportingBulk(true);
    
    try {
      // Fetch all guides with full step data
      const fullGuides = [];
      for (const id of selectedIds) {
        const res = await new Promise(r => chrome.runtime.sendMessage({ action: 'getGuide', guideId: id }, r));
        if (res?.guide) fullGuides.push(res.guide);
      }

      let totalSteps = fullGuides.reduce((acc, g) => acc + (g.steps?.length || 0), 0);
      let currentStep = 0;
      setExportProgress({ current: 0, total: totalSteps, format: format.toUpperCase() });

      if (format === 'json') {
        const standardizeStep = async (step, defaultColor, showTimestamp, timestampPosition, timestampStyle) => ({
          id: step.id || "",
          guideId: step.guideId || "",
          action: step.action || "",
          description: step.description || "",
          stepType: step.stepType || "click",
          elementData: step.elementData || null,
          annotations: Array.isArray(step.annotations) ? step.annotations : [],
          color: step.color || null,
          timestamp: step.timestamp || new Date().toISOString(),
          screenshotId: step.screenshotId || null,
          screenshotDataUrl: (step.stepType !== 'note' && (step.screenshot || step.screenshotId)) 
            ? await getAnnotatedDataUrl(step, step.color || defaultColor || 'red', showTimestamp, timestampPosition, timestampStyle) 
            : null
        });

        const exportGuides = [];
        for (const g of fullGuides) {
          const processedSteps = [];
          for (const s of g.steps) {
            const processed = await standardizeStep(
              s, 
              g.defaultColor, 
              g.showTimestamp !== false, 
              g.timestampPosition || 'bottom_right', 
              g.timestampStyle || 'minimal_black'
            );
            processedSteps.push(processed);
            currentStep++;
            setExportProgress({ current: currentStep, total: totalSteps, format: 'JSON' });
          }
          exportGuides.push({
            id: g.id || "",
            title: g.title || "Untitled",
            url: g.url || "",
            createdAt: g.createdAt || new Date().toISOString(),
            updatedAt: g.updatedAt || new Date().toISOString(),
            stepCount: g.stepCount || 0,
            defaultColor: g.defaultColor || "red",
            steps: processedSteps
          });
        }

        const exportData = {
          exportType: "steply_bundle",
          version: "1.0",
          exportTitle: bulkTitle,
          exportedAt: new Date().toISOString(),
          guides: exportGuides
        };

        downloadFile(new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' }), `${sanitizeFilename(bulkTitle)}.json`);
      } 
      else if (format === 'md') {
        let md = `# ${bulkTitle}\n\n*Exported on ${new Date().toLocaleDateString()}*\n\n`;
        for (const g of fullGuides) {
          md += `## Guide: ${g.title}\n\n`;
          for (let i = 0; i < g.steps.length; i++) {
            const step = g.steps[i];
            md += `### Step ${i + 1}: ${step.action}\n`;
            if (step.description) md += `\n> ${step.description}\n`;
            if (step.stepType !== 'note' && (step.screenshot || step.screenshotId)) {
              const stepColor = step.color || g.defaultColor || 'red';
              const annotated = await getAnnotatedDataUrl(
                step, 
                stepColor, 
                g.showTimestamp !== false, 
                g.timestampPosition || 'bottom_right', 
                g.timestampStyle || 'minimal_black'
              );
              if (annotated) md += `\n![Screenshot](${annotated})\n`;
            }
            md += `\n`;
            currentStep++;
            setExportProgress({ current: currentStep, total: totalSteps, format: 'Markdown' });
          }
          md += `\n---\n\n`;
        }
        downloadFile(new Blob([md], { type: 'text/markdown' }), `${sanitizeFilename(bulkTitle)}.md`);
      }
      else if (format === 'pdf') {
        const doc = new jsPDF();
        doc.setFontSize(22); doc.text(bulkTitle, 10, 20);
        doc.setFontSize(10); doc.setTextColor(150); doc.text(`Exported on ${new Date().toLocaleDateString()}`, 10, 28);
        
        for (const g of fullGuides) {
          doc.addPage();
          doc.setFontSize(20); doc.setTextColor(0);
          doc.text(g.title, 10, 20);
          let y = 40;
          for (let i = 0; i < g.steps.length; i++) {
            const step = g.steps[i];
            if (y > 250) { doc.addPage(); y = 20; }
            doc.setFontSize(14); doc.text(`Step ${i + 1}: ${step.action}`, 10, y); y += 8;
            if (step.description) {
              doc.setFontSize(11); doc.setTextColor(100);
              const lines = doc.splitTextToSize(step.description, 180);
              doc.text(lines, 10, y); y += lines.length * 6 + 4;
              doc.setTextColor(0);
            }
            y += 4;
            if (step.stepType !== 'note' && (step.screenshot || step.screenshotId)) {
              const stepColor = step.color || g.defaultColor || 'red';
              const annotated = await getAnnotatedDataUrl(
                step, 
                stepColor, 
                g.showTimestamp !== false, 
                g.timestampPosition || 'bottom_right', 
                g.timestampStyle || 'minimal_black'
              );
              if (annotated) {
                doc.addImage(annotated, 'JPEG', 10, y, 180, 100);
                y += 110;
                if (y > 250) { doc.addPage(); y = 20; }
              }
            }
            currentStep++;
            setExportProgress({ current: currentStep, total: totalSteps, format: 'PDF' });
          }
        }
        doc.save(`${sanitizeFilename(bulkTitle)}.pdf`);
      }
      else if (format === 'word') {
        const sections = [{
          children: [
            new Paragraph({ text: bulkTitle, heading: 'Title' }),
            new Paragraph({ text: `Exported on ${new Date().toLocaleDateString()}` })
          ]
        }];
        for (const g of fullGuides) {
          const children = [new Paragraph({ text: g.title, heading: 'Heading1' })];
          for (let i = 0; i < g.steps.length; i++) {
            const step = g.steps[i];
            children.push(new Paragraph({ text: `Step ${i + 1}: ${step.action}`, heading: 'Heading2' }));
            if (step.description) children.push(new Paragraph({ text: step.description }));
            if (step.stepType !== 'note' && (step.screenshot || step.screenshotId)) {
              const stepColor = step.color || g.defaultColor || 'red';
              const annotated = await getAnnotatedDataUrl(
                step, 
                stepColor, 
                g.showTimestamp !== false, 
                g.timestampPosition || 'bottom_right', 
                g.timestampStyle || 'minimal_black'
              );
              if (annotated) {
                const b64 = annotated.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
                const bin = window.atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
                children.push(new Paragraph({ children: [new ImageRun({ data: bytes, transformation: { width: 500, height: 300 } })] }));
              }
            }
            currentStep++;
            setExportProgress({ current: currentStep, total: totalSteps, format: 'Word' });
          }
          sections.push({ children });
        }
        const blob = await Packer.toBlob(new Document({ sections }));
        downloadFile(blob, `${sanitizeFilename(bulkTitle)}.docx`);
      }
      else if (format === 'html') {
        let guidesHtml = '';
        for (const g of fullGuides) {
          let stepsHtml = '';
          for (let i = 0; i < g.steps.length; i++) {
            const step = g.steps[i];
            const stepColor = step.color || g.defaultColor || 'red';
            const annotated = (step.stepType !== 'note' && (step.screenshot || step.screenshotId))
              ? await getAnnotatedDataUrl(
                  step, 
                  stepColor, 
                  g.showTimestamp !== false, 
                  g.timestampPosition || 'bottom_right', 
                  g.timestampStyle || 'minimal_black'
                )
              : null;
            
            stepsHtml += `
              <div class="step-card">
                <div class="step-header">
                  <div class="step-num">${i + 1}</div>
                  <h3 class="step-title">${escapeHtml(step.action)}</h3>
                </div>
                ${step.description ? `<div class="step-description">${escapeHtml(step.description)}</div>` : ''}
                ${annotated ? `<div class="step-screenshot-wrap"><img src="${annotated}" alt="Step ${i+1} Screenshot" /></div>` : ''}
              </div>
            `;
            currentStep++;
            setExportProgress({ current: currentStep, total: totalSteps, format: 'HTML' });
          }
          
          guidesHtml += `
            <div class="guide-section">
              <h2 class="guide-title">${escapeHtml(g.title)}</h2>
              <p class="guide-meta">${g.steps.length} steps · Created on ${new Date(g.createdAt).toLocaleDateString()}</p>
              <div class="steps-list">
                ${stepsHtml}
              </div>
            </div>
            <div class="page-break"></div>
          `;
        }

        const fullHtml = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(bulkTitle)}</title>
    <style>
      :root {
        --primary-color: #185FA5;
        --bg-color: #fafafa;
        --card-bg: #ffffff;
        --text-primary: #111827;
        --text-secondary: #4b5563;
        --border-color: #e5e7eb;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background-color: var(--bg-color);
        color: var(--text-primary);
        margin: 0;
        padding: 40px 20px;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .container {
        max-width: 680px;
        width: 100%;
      }
      .bulk-header-card {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 16px;
        padding: 40px;
        margin-bottom: 40px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04);
      }
      .bulk-title {
        font-size: 28px;
        font-weight: 700;
        color: var(--primary-color);
        margin: 0 0 10px;
      }
      .bulk-meta {
        font-size: 14px;
        color: var(--text-secondary);
        margin: 0;
      }
      .guide-section {
        margin-bottom: 60px;
      }
      .guide-title {
        font-size: 22px;
        font-weight: 600;
        color: var(--text-primary);
        margin: 0 0 6px;
      }
      .guide-meta {
        font-size: 13px;
        color: var(--text-secondary);
        margin: 0 0 24px;
      }
      .step-card {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        overflow: hidden;
        margin-bottom: 24px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.02);
      }
      .step-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px 20px;
        border-bottom: 1px solid var(--border-color);
      }
      .step-num {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: var(--primary-color);
        color: white;
        font-size: 13px;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .step-title {
        font-size: 15px;
        font-weight: 600;
        margin: 0;
        color: var(--text-primary);
      }
      .step-description {
        padding: 12px 20px;
        font-size: 14px;
        color: var(--text-secondary);
        background: #f8fafc;
        border-bottom: 1px solid var(--border-color);
        line-height: 1.6;
      }
      .step-screenshot-wrap {
        background: #0f1929;
        display: flex;
        justify-content: center;
        align-items: center;
      }
      .step-screenshot-wrap img {
        max-width: 100%;
        height: auto;
        display: block;
      }
      @media print {
        body {
          background: white;
          padding: 0;
        }
        .container {
          max-width: 100%;
        }
        .page-break {
          page-break-after: always;
        }
        .step-card {
          box-shadow: none;
          page-break-inside: avoid;
        }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="bulk-header-card">
        <h1 class="bulk-title">${escapeHtml(bulkTitle)}</h1>
        <p class="bulk-meta">Combined export of ${fullGuides.length} guides · Exported on ${new Date().toLocaleDateString()}</p>
      </div>
      ${guidesHtml}
    </div>
  </body>
  </html>
        `;
        downloadFile(new Blob([fullHtml], { type: 'text/html' }), `${sanitizeFilename(bulkTitle)}.html`);
      }
    } catch (err) {
      alert("Failed to export: " + err.message);
    } finally {
      setIsExportingBulk(false);
      setExportProgress(null);
    }
  };

  const BulkExportView = () => {
    const selectedGuides = selectedIds.map(id => guides.find(g => g.id === id)).filter(Boolean);
    
    return (
      <div className="bulk-manager">
        <div className="bulk-header">
          <div className="bulk-title-group">
            {editingBulkTitle ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input 
                  className="edit-input" 
                  style={{ fontSize: '16px', fontWeight: 600, minWidth: '300px' }}
                  value={bulkTitleInput} 
                  onChange={e => setBulkTitleInput(e.target.value)} 
                  autoFocus 
                  onBlur={updateBulkTitle}
                  onKeyDown={e => e.key === 'Enter' && updateBulkTitle()}
                />
              </div>
            ) : (
              <h2 
                onClick={() => setEditingBulkTitle(true)} 
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
                title="Click to rename"
              >
                {bulkTitle}
                <i className="ti ti-edit" style={{ fontSize: '14px', color: 'var(--color-text-tertiary)' }}></i>
              </h2>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' }}>
              <p style={{ margin: 0 }}>{selectedIds.length} guides selected · Drag to reorder</p>
              <button 
                onClick={toggleSelectAll}
                style={{ background: 'none', border: 'none', color: '#185FA5', fontSize: '11px', fontWeight: 600, cursor: 'pointer', padding: 0 }}
              >
                {selectedIds.length === guides.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn-secondary" onClick={toggleBulkMode}>Cancel</button>
            <div className="export-dropdown-wrap">
              <button 
                className="btn-primary" 
                onClick={() => setExportOpen(!exportOpen)}
                disabled={isExportingBulk || !selectedIds.length}
              >
                <i className={isExportingBulk ? "ti ti-loader rotate" : "ti ti-download"}></i>
                {isExportingBulk ? 'Exporting...' : 'Export Combined'}
                <i className={`ti ti-chevron-${exportOpen ? 'up' : 'down'}`} style={{ fontSize: '12px' }}></i>
              </button>
              {exportOpen && (
                <div className="export-dropdown-menu">
                  <button className="export-dropdown-item" onClick={() => { runBulkExport('pdf'); setExportOpen(false); }}>
                    <i className="ti ti-file-type-pdf"></i> Export as PDF
                  </button>
                  <button className="export-dropdown-item" onClick={() => { runBulkExport('word'); setExportOpen(false); }}>
                    <i className="ti ti-file-type-doc"></i> Export as Word
                  </button>
                  <button className="export-dropdown-item" onClick={() => { runBulkExport('md'); setExportOpen(false); }}>
                    <i className="ti ti-markdown"></i> Export as Markdown
                  </button>
                  <button className="export-dropdown-item" onClick={() => { runBulkExport('json'); setExportOpen(false); }}>
                    <i className="ti ti-code"></i> Export as JSON
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="bulk-list">
          {selectedGuides.length === 0 ? (
            <div className="bulk-empty">
              <i className="ti ti-checkbox"></i>
              <h3>No guides selected</h3>
              <p>Select guides from the sidebar on the left to include them in your bulk export.</p>
            </div>
          ) : (
            selectedGuides.map((g, idx) => (
              <div 
                key={g.id} 
                className="bulk-item"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('index', idx)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const fromIdx = parseInt(e.dataTransfer.getData('index'));
                  const toIdx = idx;
                  const newIds = [...selectedIds];
                  const [moved] = newIds.splice(fromIdx, 1);
                  newIds.splice(toIdx, 0, moved);
                  setSelectedIds(newIds);
                }}
              >
                <div className="bulk-item-drag-handle">
                  <i className="ti ti-grip-vertical"></i>
                </div>
                <div className="bulk-item-content">
                  <div className="bulk-item-title">{g.title || 'Untitled'}</div>
                  <div className="bulk-item-meta">{g.stepCount} steps · {timeAgo(g.updatedAt)}</div>
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                   <button className="bulk-item-remove" onClick={() => moveBulkItem(idx, -1)} disabled={idx === 0}>
                    <i className="ti ti-chevron-up"></i>
                  </button>
                  <button className="bulk-item-remove" onClick={() => moveBulkItem(idx, 1)} disabled={idx === selectedIds.length - 1}>
                    <i className="ti ti-chevron-down"></i>
                  </button>
                  <button className="bulk-item-remove" style={{ marginLeft: '8px' }} onClick={() => toggleSelectGuide(g.id)}>
                    <i className="ti ti-x"></i>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
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

  const updateTimestampOptions = (options) => {
    chrome.runtime.sendMessage({ 
      action: 'updateGuideTimestampOptions', 
      guideId: selectedGuide.id, 
      ...options 
    }, (res) => {
      if (res?.error) {
        alert(`Failed to update timestamp options: ${res.error}`);
        return;
      }
      setSelectedGuide({ ...selectedGuide, ...options });
      loadGuides();
    });
  };

  const guideColor = selectedGuide?.defaultColor || 'red';

  return (
    <div className="dash-root dash-fade-in">
      
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
          <button 
            className={`bulk-export-toggle ${bulkMode ? 'active' : ''}`}
            onClick={toggleBulkMode}
          >
            <i className={bulkMode ? "ti ti-x" : "ti ti-stack-2"}></i>
            {bulkMode ? 'Exit' : 'Bulk'}
          </button>
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
                  className={`guide-item ${isActive && !bulkMode ? 'active' : ''}`} 
                  onClick={() => bulkMode ? toggleSelectGuide(g.id) : loadGuideDetails(g.id)}
                >
                  {bulkMode && (
                    <div className="guide-checkbox-wrap">
                      <input 
                        type="checkbox" 
                        className="guide-checkbox"
                        checked={selectedIds.includes(g.id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleSelectGuide(g.id);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  )}
                  <div className="gi-icon" style={{ background: (isActive && !bulkMode) ? '#E6F1FB' : 'var(--color-background-secondary)', position: 'relative' }}>
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
        {bulkMode ? (
          <BulkExportView />
        ) : selectedGuide ? (
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
                  
                  {/* Export Trigger */}
                  <button className="btn-secondary" onClick={() => setExportModalOpen(true)}>
                    <i className="ti ti-download" style={{ fontSize: '13px' }}></i>
                    Export
                  </button>

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

                  {/* ── Timestamp Toggle (Guide Level) ── */}
                  <div className="trinity-toggle" title="Show timestamps on screenshots">
                    <button
                      className={`trinity-btn ${showTimestamp ? 'active-none' : ''}`}
                      onClick={() => updateTimestampOptions({ showTimestamp: true })}
                      title="Show timestamps"
                    >
                      <i className="ti ti-clock" style={{ fontSize: '12px', color: showTimestamp ? '#185FA5' : 'inherit' }} />
                      Time: Yes
                    </button>
                    <button
                      className={`trinity-btn ${!showTimestamp ? 'active-none' : ''}`}
                      onClick={() => updateTimestampOptions({ showTimestamp: false })}
                      title="Hide timestamps"
                    >
                      <i className="ti ti-clock-off" style={{ fontSize: '12px' }} />
                      Time: No
                    </button>
                  </div>

                  {showTimestamp && (
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <button
                        className={`timestamp-settings-trigger ${showTimestampPopover ? 'active' : ''}`}
                        onClick={() => setShowTimestampPopover(!showTimestampPopover)}
                        title="Customize timestamp font, style, and position"
                      >
                        <i className="ti ti-settings" style={{ fontSize: '13px' }} />
                      </button>
                      {showTimestampPopover && (
                        <div className="timestamp-popover">
                          <div className="timestamp-popover-header">
                            <span>Customize Timestamp</span>
                            <button className="timestamp-popover-close" onClick={() => setShowTimestampPopover(false)}>&times;</button>
                          </div>
                          
                          <div className="timestamp-popover-section">
                            <label>Placement Position</label>
                            <div className="timestamp-position-grid">
                              <button 
                                className={`pos-grid-cell ${selectedGuide.timestampPosition === 'top_left' ? 'selected' : ''}`}
                                onClick={() => updateTimestampOptions({ timestampPosition: 'top_left' })}
                                title="Top Left"
                              >
                                <span className="pos-dot top-left" />
                              </button>
                              <button 
                                className={`pos-grid-cell ${selectedGuide.timestampPosition === 'top_right' ? 'selected' : ''}`}
                                onClick={() => updateTimestampOptions({ timestampPosition: 'top_right' })}
                                title="Top Right"
                              >
                                <span className="pos-dot top-right" />
                              </button>
                              <button 
                                className={`pos-grid-cell ${selectedGuide.timestampPosition === 'bottom_left' ? 'selected' : ''}`}
                                onClick={() => updateTimestampOptions({ timestampPosition: 'bottom_left' })}
                                title="Bottom Left"
                              >
                                <span className="pos-dot bottom-left" />
                              </button>
                              <button 
                                className={`pos-grid-cell ${(selectedGuide.timestampPosition === 'bottom_right' || !selectedGuide.timestampPosition) ? 'selected' : ''}`}
                                onClick={() => updateTimestampOptions({ timestampPosition: 'bottom_right' })}
                                title="Bottom Right"
                              >
                                <span className="pos-dot bottom-right" />
                              </button>
                            </div>
                          </div>

                          <div className="timestamp-popover-section">
                            <label>Overlay Theme & Font</label>
                            <div className="timestamp-theme-list">
                              <button 
                                className={`theme-list-item ${selectedGuide.timestampStyle !== 'minimal_white' ? 'selected' : ''}`}
                                onClick={() => updateTimestampOptions({ timestampStyle: 'minimal_black' })}
                              >
                                <div className="theme-preview minimal-black">11:14:23</div>
                                <div className="theme-meta">
                                  <div className="theme-name">Normal Black</div>
                                  <div className="theme-desc">DM Sans, black color, no box/border</div>
                                </div>
                              </button>
                              <button 
                                className={`theme-list-item ${selectedGuide.timestampStyle === 'minimal_white' ? 'selected' : ''}`}
                                onClick={() => updateTimestampOptions({ timestampStyle: 'minimal_white' })}
                              >
                                <div className="theme-preview minimal-white">11:14:23</div>
                                <div className="theme-meta">
                                  <div className="theme-name">Normal White</div>
                                  <div className="theme-desc">DM Sans, white color, no box/border</div>
                                </div>
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

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
                <React.Fragment key={`${step.id}-${step._refresh || ''}`}>
                  {index === 0 && (
                    <div className="insert-divider-container">
                      <button 
                        className="insert-divider-btn" 
                        onClick={() => handleInsertBlankStep(0)}
                        title="Insert blank note step here"
                      >
                        <i className="ti ti-plus"></i>
                        <span>Insert Note Card</span>
                      </button>
                    </div>
                  )}
                  <StepCard 
                    step={step} 
                    index={index} 
                    updateStepText={updateStepText} 
                    updateStepDescription={updateStepDescription} 
                    deleteStep={deleteStep}
                    updateStepColor={updateStepColor}
                    guideColor={guideColor}
                    showTimestamp={showTimestamp}
                    timestampPosition={timestampPosition}
                    timestampStyle={timestampStyle}
                    onAnnotate={setEditingStep}
                    duplicateStep={duplicateStep}
                    draggingIndex={draggingIndex}
                    setDraggingIndex={setDraggingIndex}
                    handleReorderSteps={handleReorderSteps}
                  />
                  <div className="insert-divider-container">
                    <button 
                      className="insert-divider-btn" 
                      onClick={() => handleInsertBlankStep(index + 1)}
                      title="Insert blank note step here"
                    >
                      <i className="ti ti-plus"></i>
                      <span>Insert Note Card</span>
                    </button>
                  </div>
                </React.Fragment>
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

      {/* ─── STEP EDITOR OVERLAY — annotations + redaction (Root Level) ─────── */}
      {editingStep && (
        <StepEditorWorkspace
          step={editingStep}
          highlightColor={editingStep.color || guideColor}
          showTimestamp={showTimestamp}
          timestampPosition={timestampPosition}
          timestampStyle={timestampStyle}
          onCancel={() => setEditingStep(null)}
          onSave={handleSaveStepEdits}
        />
      )}

      {/* ─── EXPORT OPTIONS MODAL (Root Level) ─── */}
      {exportModalOpen && selectedGuide && (
        <div className="export-modal-overlay" onClick={() => setExportModalOpen(false)}>
          <div className="export-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="export-modal-header">
              <h3>Export Options</h3>
              <button className="btn-close-modal" onClick={() => setExportModalOpen(false)}>
                <i className="ti ti-x"></i>
              </button>
            </div>
            
            <div className="export-modal-body">
              {/* Cover Page Options */}
              <div className="export-modal-section">
                <div 
                  className="export-modal-toggle-row"
                  onClick={() => setIncludeCoverPage(!includeCoverPage)}
                >
                  <div className="toggle-row-info">
                    <h4>Include Cover Page</h4>
                    <p>Prepend a beautiful title slide to PDF/Word/HTML exports</p>
                  </div>
                  <input 
                    type="checkbox" 
                    className="switch-input"
                    checked={includeCoverPage}
                    onChange={(e) => setIncludeCoverPage(e.target.checked)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
                
                {includeCoverPage && (
                  <div className="export-modal-grid">
                    <div className="export-modal-input-group">
                      <label>Title</label>
                      <input 
                        type="text" 
                        className="export-modal-input" 
                        value={coverTitle} 
                        onChange={(e) => setCoverTitle(e.target.value)} 
                        placeholder="Guide Title"
                      />
                    </div>
                    <div className="export-modal-input-group">
                      <label>Subtitle</label>
                      <input 
                        type="text" 
                        className="export-modal-input" 
                        value={coverSubtitle} 
                        onChange={(e) => setCoverSubtitle(e.target.value)} 
                        placeholder="Step-by-step Guide"
                      />
                    </div>
                    <div className="export-modal-input-group">
                      <label>Author</label>
                      <input 
                        type="text" 
                        className="export-modal-input" 
                        value={coverAuthor} 
                        onChange={(e) => setCoverAuthor(e.target.value)} 
                        placeholder="Your Name"
                      />
                    </div>
                    <div className="export-modal-input-group">
                      <label>Company / Organization Name</label>
                      <input 
                        type="text" 
                        className="export-modal-input" 
                        value={coverOrg} 
                        onChange={(e) => setCoverOrg(e.target.value)} 
                        placeholder="Company Name"
                      />
                    </div>
                    <div className="export-modal-input-group">
                      <label>Company Logo</label>
                      <div className="logo-upload-zone">
                        <input 
                          type="file" 
                          accept="image/*" 
                          onChange={(e) => {
                            const file = e.target.files[0];
                            if (file) {
                              const reader = new FileReader();
                              reader.onloadend = () => {
                                setCoverLogo(reader.result);
                              };
                              reader.readAsDataURL(file);
                            }
                          }} 
                          style={{ display: 'none' }}
                          id="cover-logo-file"
                        />
                        <label htmlFor="cover-logo-file" className="logo-upload-label">
                          {coverLogo ? (
                            <div className="logo-preview-wrap">
                              <img src={coverLogo} alt="Logo preview" className="logo-preview-img" />
                              <button type="button" className="logo-remove-btn" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setCoverLogo(null); }}>Remove Logo</button>
                            </div>
                          ) : (
                            <div className="logo-upload-placeholder">
                              <i className="ti ti-photo" style={{ fontSize: '20px', color: '#185FA5' }}></i>
                              <span>Upload Company Logo</span>
                            </div>
                          )}
                        </label>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              
              {/* Choose Format */}
              <div className="export-modal-section">
                <span className="export-modal-section-title">Select Format to Download</span>
                <div className="export-format-grid">
                  <div className="export-format-card" onClick={() => { exportPDF(); setExportModalOpen(false); }}>
                    <div className="export-format-icon pdf">
                      <i className="ti ti-file-type-pdf"></i>
                    </div>
                    <div className="export-format-info">
                      <h4>PDF Document</h4>
                      <p>For printing and sharing</p>
                    </div>
                  </div>
                  
                  <div className="export-format-card" onClick={() => { exportWord(); setExportModalOpen(false); }}>
                    <div className="export-format-icon word">
                      <i className="ti ti-file-type-doc"></i>
                    </div>
                    <div className="export-format-info">
                      <h4>Word Document</h4>
                      <p>Editable Docx file</p>
                    </div>
                  </div>
                  
                  <div className="export-format-card" onClick={() => { exportHTML(); setExportModalOpen(false); }}>
                    <div className="export-format-icon html">
                      <i className="ti ti-code"></i>
                    </div>
                    <div className="export-format-info">
                      <h4>HTML Standalone</h4>
                      <p>Interactive web page</p>
                    </div>
                  </div>
                  
                  <div className="export-format-card" onClick={() => { exportMarkdown(); setExportModalOpen(false); }}>
                    <div className="export-format-icon markdown">
                      <i className="ti ti-markdown"></i>
                    </div>
                    <div className="export-format-info">
                      <h4>Markdown File</h4>
                      <p>For dev wikis and blogs</p>
                    </div>
                  </div>
                  
                  <div style={{ gridColumn: 'span 2' }} className="export-format-card" onClick={() => { exportJSON(); setExportModalOpen(false); }}>
                    <div className="export-format-icon json">
                      <i className="ti ti-braces"></i>
                    </div>
                    <div className="export-format-info">
                      <h4>JSON Bundle</h4>
                      <p>Steply raw database backup</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* ─── EXPORT PROGRESS CARD OVERLAY (Root Level) ─── */}
      {exportProgress && (
        <div className="export-progress-overlay">
          <div className="export-progress-card">
            <div className="spinner rotate">
              <i className="ti ti-loader" style={{ fontSize: '24px', color: '#185FA5' }}></i>
            </div>
            <p className="progress-text">Exporting to {exportProgress.format}...</p>
            <div className="progress-bar-bg">
              <div 
                className="progress-bar-fill" 
                style={{ width: `${(exportProgress.current / exportProgress.total) * 100}%` }}
              ></div>
            </div>
            <p className="progress-detail">Processing step {exportProgress.current} of {exportProgress.total}</p>
          </div>
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<Dashboard />);
