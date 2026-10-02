import { jsPDF } from 'jspdf';

// ─── "Save current page as PDF" ──────────────────────────────────────────────
// The service worker scrolls the page, stitches the screens into one or more tall
// JPEGs and leaves them in storage.local; this page turns those into an A4 PDF and
// downloads it.
//
// It has to be a page rather than the service worker because a worker has no
// URL.createObjectURL and no anchor to click, and rather than the popup because the
// popup closes the moment the user clicks the page — mid-capture, that is most of the
// time. Downloading from a document needs no "downloads" permission; this is the same
// mechanism the dashboard's existing exports use.
//
// The capture arrives in chunks because Chrome will not allocate a canvas taller than
// about 16384px. Chunk boundaries fall on screen boundaries and the chunks run in
// order, so they are laid out end to end here as though they were one image.

// A4 portrait, millimetres. The capture is drawn edge to edge at full page width, so
// the result reads as a printout of the page rather than a screenshot pasted into a
// document. The bottom strip is kept clear for the footer.
const PAGE_W   = 210;
const PAGE_H   = 297;
const FOOTER_H = 12;
const BAND_H   = PAGE_H - FOOTER_H;  // millimetres of image per page
// The capture arrives as JPEG and has to be re-encoded to be cut into pages, so this is
// a second generation of JPEG loss — kept high enough that page text stays crisp, which
// is the whole point of the document.
const BAND_QUALITY = 0.86;

const el = (id) => document.getElementById(id);

function setStatus(text, { done = false } = {}) {
  el('statusText').textContent = text;
  el('spinner').style.display = done ? 'none' : 'block';
}

function showNote(text) {
  el('note').textContent = text;
  el('note').style.display = 'block';
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => (img.naturalWidth && img.naturalHeight
      ? resolve(img)
      : reject(new Error('empty capture')));
    img.onerror = () => reject(new Error('capture could not be decoded'));
    img.src = src;
  });
}

function filenameFor(meta) {
  let base = (meta.pageTitle || '').trim();
  if (!base) {
    try { base = new URL(meta.pageUrl).hostname.replace(/^www\./, ''); } catch (e) { base = ''; }
  }
  // Same character class the dashboard's exports strip, so a title that saved fine
  // there saves fine here.
  base = base.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80)
             .replace(/^[-\s]+|[-\s]+$/g, '');
  const d = new Date(meta.capturedAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${base || 'page'} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.pdf`;
}

// Source URL on the left, page number on the right, in the strip below the image.
function stampFooter(doc, meta, page, total) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(156, 163, 175);

  const right  = `${page} / ${total}`;
  const rightW = doc.getTextWidth(right);
  const left   = doc.splitTextToSize(meta.pageUrl || 'Captured page', PAGE_W - 24 - rightW)[0];
  doc.text(left, 10, PAGE_H - 4);
  doc.text(right, PAGE_W - 10, PAGE_H - 4, { align: 'right' });

  // Said on the page where the content actually stops, so a partial capture is never
  // handed over as if it were the whole page.
  if (meta.truncated && page === total) {
    doc.setFontSize(8);
    doc.setTextColor(180, 83, 9);
    doc.text(
      `Capture stopped after ${meta.screens} screens — this page is longer than Steply can capture in one pass.`,
      PAGE_W / 2, PAGE_H - 8.5, { align: 'center' }
    );
  }
}

// The service worker reports each chunk's size; this only has to measure when it
// couldn't, which is the fallback path where a capture is handed over unprocessed.
async function measureChunks(chunks) {
  for (const c of chunks) {
    if (c.width > 0 && c.height > 0) continue;
    const img = await loadImage(c.dataUrl);
    c.width  = img.naturalWidth;
    c.height = img.naturalHeight;
    img.src = '';
  }
  return chunks;
}

// How many sheets each chunk needs, worked out before anything is drawn so the footers
// can say "4 / 31" rather than counting up as they go. Bands are evened out across the
// sheets a chunk needs rather than each taking the maximum: packing them tight leaves
// whatever is left over as the last page, and a page holding 10mm of content above
// 280mm of white reads as a mistake. Scale is per chunk so a chunk that came through
// at a different width still fills the sheet.
function planPages(chunks) {
  return chunks.map((chunk) => {
    const mmPerPx   = PAGE_W / chunk.width;
    const maxBandPx = Math.max(1, Math.floor(BAND_H / mmPerPx));
    const pages     = Math.max(1, Math.ceil(chunk.height / maxBandPx));
    return { chunk, mmPerPx, pages, bandPx: Math.ceil(chunk.height / pages) };
  });
}

async function buildPdf(meta) {
  const chunks = await measureChunks(meta.chunks);
  const plan   = planPages(chunks);
  const total  = plan.reduce((n, part) => n + part.pages, 0);
  const doc    = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

  // A page that fits on one sheet keeps its own proportions rather than being stretched
  // down it, and the original JPEG goes in untouched.
  if (total === 1) {
    doc.addImage(chunks[0].dataUrl, 'JPEG', 0, 0, PAGE_W, chunks[0].height * plan[0].mmPerPx);
    stampFooter(doc, meta, 1, 1);
    return { doc, pages: 1 };
  }

  // Cut into full-width horizontal bands, one per sheet. The cut lands wherever it
  // lands — nothing here knows where the page's own lines and paragraphs are — which is
  // the same compromise the browser's own Print to PDF makes.
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  let page = 0;

  for (const part of plan) {
    const img = await loadImage(part.chunk.dataUrl);
    const w   = part.chunk.width;

    for (let p = 0; p < part.pages; p++) {
      const srcY = p * part.bandPx;
      const h    = Math.min(part.bandPx, part.chunk.height - srcY);
      if (h <= 0) break; // nothing left in this chunk; never reached for a real capture

      canvas.width  = w;
      canvas.height = h;
      ctx.drawImage(img, 0, srcY, w, h, 0, 0, w, h);

      if (page > 0) doc.addPage();
      doc.addImage(canvas.toDataURL('image/jpeg', BAND_QUALITY), 'JPEG', 0, 0, PAGE_W, h * part.mmPerPx);
      page += 1;
      stampFooter(doc, meta, page, total);

      // Yields so the page count on screen actually repaints; a tall capture is a few
      // dozen sheets and several seconds of encoding.
      setStatus(`Building your PDF… page ${page} of ${total}`);
      await new Promise((r) => setTimeout(r, 0));
    }

    // Drop this chunk's decoded pixels before the next one is loaded. A long capture is
    // several chunks and each is tens of megabytes once decoded.
    img.src = '';
  }

  return { doc, pages: page };
}

async function main() {
  let meta;
  try {
    const stored = await chrome.storage.local.get('steplyPendingCapture');
    meta = stored && stored.steplyPendingCapture;
  } catch (e) {
    meta = null;
  }

  if (!meta || !meta.chunks || !meta.chunks.length) {
    setStatus('Nothing to download', { done: true });
    showNote('Open the Steply popup on the page you want and choose "Save current page as PDF".');
    return;
  }

  // Read once. A multi-megabyte capture shouldn't outlive the download it was for, and
  // reloading this tab shouldn't quietly hand over the same file a second time.
  chrome.storage.local.remove('steplyPendingCapture');

  el('meta').textContent = meta.pageUrl || '';
  el('preview').src = meta.chunks[0].dataUrl;
  el('previewWrap').style.display = 'block';

  try {
    const { doc, pages } = await buildPdf(meta);
    const name = filenameFor(meta);

    doc.save(name);

    setStatus(`Saved ${pages} ${pages === 1 ? 'page' : 'pages'}`, { done: true });
    el('meta').textContent = name;
    if (meta.truncated) {
      showNote(`Only the first ${meta.screens} screens fitted in one pass, so the PDF stops partway down this page. Its last page says so too.`);
    }

    // Chrome allows one download per page load without a click; if it decides this one
    // wasn't wanted, or the user loses the file, this button is a plain user gesture.
    const again = el('againBtn');
    again.style.display = 'inline-flex';
    again.addEventListener('click', () => doc.save(name));
  } catch (e) {
    console.error('STEPLY capture.html error:', e);
    setStatus("Couldn't build the PDF", { done: true });
    showNote('The capture came through but could not be turned into a PDF. Please try capturing the page again.');
  }
}

main();
