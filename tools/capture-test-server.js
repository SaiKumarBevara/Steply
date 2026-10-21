// Local test pages for "Save current page as PDF". Each page reproduces one way the
// full-page capture has gone wrong, so a fix can be checked in a real browser against a
// page where the right answer is known in advance.
//
//   node tools/capture-test-server.js        then open http://localhost:8765/
//
// No dependencies. Images are solid colours and every image response is delayed, so a
// slice captured before its images finished loading shows up as an obvious blank box.

const http = require('http');
const zlib = require('zlib');

const PORT      = Number(process.env.PORT) || 8765;
const IMG_DELAY = 700; // ms: a slow-ish real network

// ── Minimal PNG encoder (solid colour, RGB) ──────────────────────────────────
function crc32(buf) {
  let crc = ~0;
  for (const b of buf) {
    let c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const COLOURS = { green: [0, 170, 0], blue: [0, 60, 220] };

// ── Pages ────────────────────────────────────────────────────────────────────
const shell = (title, expect, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font:18px system-ui,sans-serif}
section{height:900px;padding:32px;box-sizing:border-box;border-top:1px solid #ccc}
h2{margin:0 0 12px}.expect{background:#fff8db;padding:12px 32px;border-bottom:1px solid #e8d48a}</style></head>
<body><div class="expect"><b>${title}.</b> Expect: ${expect}</div>${body}</body></html>`;

const sections = (n, inner) => Array.from({ length: n }, (_, i) =>
  `<section><h2>SECTION ${i + 1} of ${n}</h2>${inner(i)}</section>`).join('');

const pages = {
  '/': `<!doctype html><meta charset="utf-8"><title>Steply capture tests</title>
<body style="font:18px system-ui,sans-serif;max-width:720px;margin:40px auto;line-height:1.6">
<h1>Steply — capture test pages</h1>
<p>Open each page, then use <b>Save current page as PDF</b> from the Steply popup.</p>
<ol>
<li><a href="/lazy.html">Lazy images</a> — every box filled in, none blank.</li>
<li><a href="/shadow.html">Pinned bars in web components</a> — magenta banner once, orange bar once.</li>
<li><a href="/pane.html">Inner scrolling pane</a> — all 6 sections, page scrolls.</li>
<li><a href="/iframes.html">Page with iframes</a> — all 6 sections; one HUD while recording.</li>
</ol></body>`,

  // Native and script-driven lazy loading, both below the first screen.
  '/lazy.html': shell('Lazy images',
    'every section shows a GREEN box (native loading="lazy") and a BLUE box (script loader). A white or empty box is the bug.',
    sections(6, (i) => `
      <p><img loading="lazy" width="500" height="250" src="/img/green-${i}.png" alt="native lazy ${i + 1}"></p>
      <p><img class="js-lazy" width="500" height="250" alt="script lazy ${i + 1}"
              src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/blue-${i}.png"></p>`) + `
    <script>
      const io = new IntersectionObserver((entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.src = e.target.dataset.src; io.unobserve(e.target); }
      }));
      document.querySelectorAll('.js-lazy').forEach((el) => io.observe(el));
    </script>`),

  // A fixed banner and a sticky bar, each inside a shadow root.
  '/shadow.html': shell('Pinned bars in web components',
    'the MAGENTA banner appears once, at the bottom of the first screen; the ORANGE bar appears once, at the top of section 2. Either one repeating down the PDF is the bug.',
    `<x-banner></x-banner>` + sections(6, (i) => (i === 1 ? '<x-sticky></x-sticky>' : '')) + `
    <script>
      customElements.define('x-banner', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML =
          '<div style="position:fixed;bottom:0;left:0;right:0;height:56px;background:#f0f;color:#fff;font:bold 20px sans-serif;display:flex;align-items:center;padding-left:24px;z-index:9">SHADOW FIXED BANNER</div>'; }
      });
      customElements.define('x-sticky', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML =
          '<div style="position:sticky;top:0;height:48px;background:#ff8c00;color:#fff;font:bold 18px sans-serif;display:flex;align-items:center;padding-left:24px">SHADOW STICKY BAR</div><div style="height:2400px"></div>'; }
      });
    </script>`),

  // The document itself doesn't scroll; an inner pane does.
  '/pane.html': shell('Inner scrolling pane',
    'the PDF holds all 6 sections, and the page visibly scrolls while capturing. Only the first screen is the bug.',
    `<div style="position:fixed;top:48px;bottom:0;left:0;right:0;overflow:auto">${sections(6, () => '')}</div>
     <style>html,body{height:100%;overflow:hidden}</style>`),

  // Iframes each carry their own content script.
  '/iframes.html': shell('Page with iframes',
    'the PDF holds all 6 sections, and while recording there is exactly one Steply HUD.',
    sections(6, (i) => (i < 2
      ? `<iframe src="/frame.html" style="width:420px;height:260px;border:1px solid #999"></iframe>`
      : ''))),
  '/frame.html': '<!doctype html><body style="margin:0;font:16px sans-serif;background:#eef;height:600px;padding:12px">an iframe</body>',
};

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (pages[url]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(pages[url]);
  }
  const m = url.match(/^\/img\/(green|blue)-\d+\.png$/);
  if (m) {
    return setTimeout(() => {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(solidPng(500, 250, COLOURS[m[1]]));
    }, IMG_DELAY);
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(`Steply capture tests: http://localhost:${PORT}/`));
