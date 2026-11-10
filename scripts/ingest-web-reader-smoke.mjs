// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
// Run inside the built page reader image (inner#1664), offline: a local origin
// serves samples and the service in /app/server.mjs reads them with its own
// browser. The samples: an article, a redirect to it, a two-page PDF, a missing
// page; a CSP page, an XML page, an empty app shell, a page its script writes,
// a download past the size limit, a page that never stops running; a
// plain-text file, a GBK text, a JSON file, a PDF download sent as
// application/x-pdf, a PDF sent as text/plain; a PNG with no type, UTF-8 text
// with no charset, an RSS feed, a CSV download, a latin1 CSV with no charset, a
// JavaScript file; a 503 and a 403 that arrive as downloads; an HTML page that
// declares a length past the limit; two articles that go on to a large
// download after they load (by script and by meta refresh); articles that go
// on after they load to an HTML page past the size limit (by script and by
// meta refresh), to a slow HTML page (and that slow page read directly), to a
// text file, to another article, to a missing page, and to a text file and an
// HTML page past the size limit at addresses with a fragment; pages that a
// script in their head replaces with a missing page, a text file and a CSV
// attachment (and that attachment read directly); an article that goes on to
// a page answering after the settle wait; a download landing page whose
// hidden iframe downloads a zip; an article that goes on to a redirect loop
// (and the loop read directly); a page its head replaces with a 404 attachment
// and an article that goes on to a 503 attachment (and both attachments read
// directly); a PDF and a CSV attachment read at an address with a fragment, and
// a page its head replaces with that attachment at a fragment; and a malformed
// request to the service itself.
//   docker run --rm --network none -v "$PWD/scripts/ingest-web-reader-smoke.mjs:/tmp/web-reader-smoke.mjs:ro" \
//     --entrypoint node <image> /tmp/web-reader-smoke.mjs
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

const HEADING = 'Reading inside the container';
const PARAGRAPH = 'The quiet harbour lighthouse guides every fishing boat home before the evening storm arrives.';
const PDF_PAGES = ['Hello page one', 'Second page here'];

/**
 * A minimal valid PDF with one line of Helvetica text per page, its xref
 * offsets exact; with `binaryMarker`, a comment line of control bytes
 * (0x01 to 0x08) follows the header.
 */
function pdfOf(lines, binaryMarker = false) {
  const objects = [];
  const pageIds = lines.map((_, i) => 3 + i * 2);
  const fontId = 3 + lines.length * 2;
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${lines.length} >>`;
  lines.forEach((line, i) => {
    const pageId = pageIds[i];
    const content = `BT /F1 24 Tf 72 720 Td (${line}) Tj ET`;
    objects[pageId] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = binaryMarker ? '%PDF-1.4\n%\x01\x02\x03\x04\x05\x06\x07\x08\n' : '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// Long enough that Readability takes it as the article on its first pass.
const ARTICLE = `<!doctype html><html><head><title>Smoke Article</title></head><body>
<nav><a href="/">Home</a></nav>
<article><h2>${HEADING}</h2>
<p>${PARAGRAPH} ${'Each line of this story is plain text worth keeping. '.repeat(8)}</p>
<p>The full notes are in the <a href="/notes">harbour notes</a>, read the same way.</p>
</article></body></html>`;
const PDF = pdfOf(PDF_PAGES);
// Sent as text/plain with no content-disposition: only its bytes say it is a PDF.
// Chromium downloads a text/plain response only when its first bytes look binary.
const BINARY_PDF = pdfOf(PDF_PAGES, true);

const CSP_PARAGRAPH = 'The lighthouse keeper writes the tide tables by hand every Sunday morning before dawn.';
// Its policy forbids inline scripts, the way the reader adds Readability.
const CSP_ARTICLE = `<!doctype html><html><head><title>Policy Article</title></head><body>
<article><h2>Kept under a content security policy</h2>
<p>${CSP_PARAGRAPH} ${'Each line of this story is plain text worth keeping. '.repeat(8)}</p>
</article></body></html>`;
const XML_TEXT = 'Harbour tide table for the northern pier';
// An XML document has no body.
const XML = `<?xml version="1.0" encoding="UTF-8"?><notes><note>${XML_TEXT}</note></notes>`;
// Nothing a person reads: a style and the data a script would render from.
const SHELL = `<!doctype html><html><head><title>App</title><style>#root { min-height: 100vh; }</style></head>
<body><div id="root"></div><script type="application/json" id="__DATA__">{"route":"/","token":"abc123"}</script></body></html>`;
const RENDERED_PARAGRAPH = 'Fishing boats return to the harbour at dusk when the lighthouse lamp is lit.';
const RENDERED = `<!doctype html><html><head><title>Rendered</title></head><body><div id="app"></div>
<script>document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('app').innerHTML = '<article><h2>Written by the page</h2><p>${RENDERED_PARAGRAPH} ' +
    '${'Each line of this story is plain text worth keeping. '.repeat(8)}</p></article>';
});</script></body></html>`;
// Plan section 15 rows 4 and 7: an article that, once it has loaded, sends
// the browser on to a large download; the article is what is read.
const LEAVING_PARAGRAPH = 'The harbour master posts the evening tide times on the board beside the ferry gate.';
const LEAVING_BODY = `<article><h2>Before the download</h2><p>${LEAVING_PARAGRAPH} ` +
  `${'Each line of this story is plain text worth keeping. '.repeat(8)}</p></article>`;
const LEAVES_BY_SCRIPT = `<!doctype html><html><head><title>Leaves by script</title></head><body>${LEAVING_BODY}` +
  "<script>setTimeout(() => { location.href = '/big.bin'; }, 50);</script></body></html>";
const LEAVES_BY_REFRESH = '<!doctype html><html><head><title>Leaves by refresh</title>' +
  `<meta http-equiv="refresh" content="0;url=/big.bin"></head><body>${LEAVING_BODY}</body></html>`;
// Plan section 16 rows 3 and 4: an article that, once it has loaded, goes on
// to another document; that document is checked and read as if asked for.
const goesOnTo = (title, target, how) => {
  const head =
    how === 'refresh' ? `<meta http-equiv="refresh" content="0;url=${target}">`
      : how === 'head-replace' ? `<script>location.replace('${target}')</script>` : '';
  const tail = how === 'script' ? `<script>setTimeout(() => { location.href = '${target}'; }, 50);</script>` : '';
  return `<!doctype html><html><head><title>${title}</title>${head}</head><body>${LEAVING_BODY}${tail}</body></html>`;
};
// Its parser never reaches the end of the head.
const BUSY = '<!doctype html><html><head><title>Busy</title><script>for (;;) {}</script></head><body><p>Never shown</p></body></html>';
// Markdown-looking text a plain-text file holds, which must come back unescaped.
const PLAIN_LINES = ['# Install', '* run `pnpm i`', '/\\d+/'];
const PLAIN = `${PLAIN_LINES.join('\n')}\n`;
// Four Chinese characters in GBK, written out because Node's TextEncoder only writes UTF-8.
const GBK_TEXT = '\u4e2d\u6587\u6d4b\u8bd5';
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
// Plan section 13.1: one sample of each kind of body that is not HTML.
// A 1x1 PNG sent with no content-type at all: the browser still sees an image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
// UTF-8 Chinese sent as text/plain with no charset, which Chromium decodes as windows-1252.
const UTF8_TEXT = '\u4e2d\u6587\u7f51\u9875\u7684\u6587\u5b57\n\u7b2c\u4e8c\u884c caf\u00e9\n';
const FEED_ITEM = 'Harbour lights repaired before the winter storms';
const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Harbour news</title>` +
  `<item><title>${FEED_ITEM}</title><link>https://example.com/lights</link></item></channel></rss>`;
// Chromium downloads a text/csv response rather than showing it.
const CSV = 'pier,tide_m\nnorth,2.4\nsouth,1.9\n';
// Plan section 18: a download landing page, the kind a site shows while a
// hidden iframe starts the file; its own article is what is read.
const LANDING_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]);
const LANDING = '<!doctype html><html><head><title>Download</title></head><body>' +
  `${LEAVING_BODY}<iframe src='/landing.zip' style='display:none'></iframe>` +
  "<script src='/landing.js'></script></body></html>";
// Sent as an attachment: a download whether opened directly or reached from a page.
const NOTES_CSV = 'name,count\napples,3\n';
// Plan section 14: a latin1 CSV that names no charset ("Z\xfcrich,caf\xe9").
const LATIN1_CSV = Buffer.from([0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68, 0x2c, 0x63, 0x61, 0x66, 0xe9, 0x0a]);
const LATIN1_TEXT = 'Z\u00fcrich,caf\u00e9\n';
const SCRIPT = "export function tide(hour) {\n  return Math.sin(hour / 12) * 2.4;\n}\n";
const JSON_BODY = '{"name":"harbour","tides":[1,2,3],"note":"# not a heading"}';
const BIG_BYTES = 30 * 1024 * 1024;
const MAX_BYTES = 20 * 1024 * 1024;
const CHUNK = Buffer.alloc(1024 * 1024);

/**
 * Send an HTML page that declares a length past the limit, slowly, so that
 * only a reader that stops at the declared length answers quickly.
 */
async function sendBigPage(res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': BIG_BYTES });
  const chunk = Buffer.from(`<p>${'harbour '.repeat(127_000)}</p>`);
  for (let sent = 0; sent + chunk.length <= BIG_BYTES && !res.destroyed; sent += chunk.length) {
    res.write(chunk);
    await setTimeout(500);
  }
  res.end();
}

/**
 * Send an HTML page with no declared length that never finishes arriving
 * within a page timeout: a little text every half second for a minute.
 */
async function sendSlowPage(res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.write('<!doctype html><html><head><title>Slow</title></head><body><p>');
  for (let i = 0; i < 120 && !res.destroyed; i++) {
    res.write('slow words arriving one part at a time ');
    await setTimeout(500);
  }
  res.end('</p></body></html>');
}

/**
 * Send a 30 MiB download slowly, a mebibyte every half second, so that
 * reading it whole would take 15 s: only a reader that stops at the declared
 * length answers quickly.
 */
async function sendBigDownload(res) {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': BIG_BYTES,
    'content-disposition': 'attachment; filename="big.bin"',
  });
  for (let sent = 0; sent < BIG_BYTES && !res.destroyed; sent += CHUNK.length) {
    res.write(CHUNK);
    await setTimeout(500);
  }
  res.end();
}

const origin = createServer((req, res) => {
  if (req.url === '/article') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ARTICLE);
  else if (req.url === '/moved') res.writeHead(302, { location: '/article' }).end();
  else if (req.url === '/report.pdf') res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF.length }).end(PDF);
  else if (req.url === '/csp') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "script-src 'self'" }).end(CSP_ARTICLE);
  } else if (req.url === '/notes.xml') res.writeHead(200, { 'content-type': 'application/xml' }).end(XML);
  else if (req.url === '/shell') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SHELL);
  else if (req.url === '/leaves-by-script') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LEAVES_BY_SCRIPT);
  else if (req.url === '/leaves-by-refresh') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LEAVES_BY_REFRESH);
  else if (req.url === '/rendered') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(RENDERED);
  else if (req.url === '/busy') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(BUSY);
  else if (req.url === '/big.bin') void sendBigDownload(res);
  else if (req.url === '/readme.txt') res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(PLAIN);
  else if (req.url === '/pixel.png') res.writeHead(200, { 'content-length': PNG.length }).end(PNG);
  else if (req.url === '/utf8.txt') res.writeHead(200, { 'content-type': 'text/plain' }).end(Buffer.from(UTF8_TEXT, 'utf8'));
  else if (req.url === '/feed.rss') res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(RSS);
  else if (req.url === '/latin1.csv') res.writeHead(200, { 'content-type': 'text/csv' }).end(LATIN1_CSV);
  else if (req.url === '/tide.js') res.writeHead(200, { 'content-type': 'application/javascript' }).end(SCRIPT);
  // A failure answer the browser turns into a download: its status still says how the read ended.
  else if (req.url === '/busy.csv') res.writeHead(503, { 'content-type': 'text/csv' }).end('busy,try later\n');
  else if (req.url === '/forbidden.bin') {
    res.writeHead(403, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x.bin"' })
      .end('no');
  } else if (req.url === '/big.html') void sendBigPage(res);
  else if (req.url === '/slow.html') void sendSlowPage(res);
  else if (req.url === '/goes-to-big-by-script') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('To big', '/big.html', 'script'));
  } else if (req.url === '/goes-to-big-by-refresh') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('To big', '/big.html', 'refresh'));
  } else if (req.url === '/goes-to-slow') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('To slow', '/slow.html', 'script'));
  } else if (req.url === '/goes-to-text') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('To text', '/readme.txt', 'script'));
  } else if (req.url === '/goes-to-article') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('To article', '/article', 'script'));
  } else if (req.url === '/goes-to-missing') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('To missing', '/missing', 'script'));
  } else if (req.url === '/goes-to-text-at-fragment') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('To text', '/readme.txt#part', 'script'));
  } else if (req.url === '/goes-to-big-at-fragment') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('To big', '/big.html#top', 'script'));
  } else if (req.url === '/head-replace-to-missing') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('Replaced', '/missing', 'head-replace'));
  } else if (req.url === '/head-replace-to-text') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('Replaced', '/readme.txt', 'head-replace'));
  } else if (req.url === '/goes-to-late') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('To late', '/late-article', 'script'));
  } else if (req.url === '/late-article') {
    // Answers after the reader's settle wait is over.
    void setTimeout(2500).then(() => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ARTICLE));
  }
  else if (req.url === '/notes.csv') {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="notes.csv"' })
      .end(NOTES_CSV);
  } else if (req.url === '/download-landing') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LANDING);
  } else if (req.url === '/landing.zip') {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="landing.zip"' })
      .end(LANDING_ZIP);
  } else if (req.url === '/landing.js') {
    // Holds the page's DOMContentLoaded back a little, past the iframe's download.
    void setTimeout(300).then(() => res.writeHead(200, { 'content-type': 'text/javascript' }).end('void 0;'));
  } else if (req.url === '/loop') res.writeHead(302, { location: '/loop' }).end();
  else if (req.url === '/goes-to-loop') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('To loop', '/loop', 'script'));
  } else if (req.url === '/missing.txt') {
    res.writeHead(404, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="missing.txt"' }).end('missing');
  } else if (req.url === '/head-replace-to-missing-attachment') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('Replaced', '/missing.txt', 'head-replace'));
  } else if (req.url === '/busy.bin') {
    res.writeHead(503, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="busy.bin"' })
      .end('busy');
  } else if (req.url === '/goes-to-busy-attachment') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('To busy', '/busy.bin', 'script'));
  } else if (req.url === '/head-replace-to-download-at-fragment') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('Replaced', '/notes.csv#x', 'head-replace'));
  } else if (req.url === '/head-replace-to-download') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(goesOnTo('Replaced', '/notes.csv', 'head-replace'));
  } else if (req.url === '/tides.csv') res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' }).end(CSV);
  else if (req.url === '/gbk.txt') res.writeHead(200, { 'content-type': 'text/plain; charset=gbk' }).end(GBK_BYTES);
  else if (req.url === '/binary.pdf') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': BINARY_PDF.length }).end(BINARY_PDF);
  } else if (req.url === '/data.json') res.writeHead(200, { 'content-type': 'application/json' }).end(JSON_BODY);
  else if (req.url === '/download.pdf') {
    res.writeHead(200, {
      'content-type': 'application/x-pdf',
      'content-length': PDF.length,
      'content-disposition': 'attachment; filename="report.pdf"',
    }).end(PDF);
  }
  else res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title><p>Not found</p>');
});

try {
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const at = (path) => `http://127.0.0.1:${origin.address().port}${path}`;

  await import('/app/server.mjs');
  for (let attempt = 0; ; attempt++) {
    try {
      const ready = await fetch('http://127.0.0.1:8080/', { signal: AbortSignal.timeout(1000) });
      assert.equal(ready.status, 404);
      break;
    } catch (error) {
      if (attempt >= 49) throw error;
      await setTimeout(100);
    }
  }

  /** Ask the service to read some paths; answers the pages and how long the call took. */
  const read = async (paths, limits = {}) => {
    const urls = paths.map(at);
    const startedAt = Date.now();
    const answered = await fetch('http://127.0.0.1:8080/read', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls, deadlineAt: Date.now() + 60000, pageTimeoutMs: 20000, settleMs: 1000,
        concurrency: 4, maxBytes: MAX_BYTES, ...limits }),
      signal: AbortSignal.timeout(90000),
    });
    assert.equal(answered.status, 200);
    const body = await answered.json();
    assert.deepEqual(body.pages.map((page) => page.url), urls, 'pages answered in order');
    return { body, ms: Date.now() - startedAt };
  };

  const urls = ['/article', '/moved', '/report.pdf', '/missing'].map(at);
  const { body: answer } = await read(['/article', '/moved', '/report.pdf', '/missing']);
  assert.deepEqual(Object.keys(answer).sort(), ['cpuUsec', 'pages']);
  assert.ok(answer.cpuUsec === null || (typeof answer.cpuUsec === 'number' && answer.cpuUsec >= 0), 'cpuUsec: a number or null');
  assert.deepEqual(answer.pages.map((page) => page.url), urls, 'pages answered in order');
  const [article, moved, pdf, missing] = answer.pages;

  assert.equal(article.status, 'ok', 'article: read');
  assert.equal(article.kind, 'html');
  assert.ok(article.text.replace(/\s+/g, ' ').includes(PARAGRAPH), 'article: paragraph kept');
  assert.match(article.text, new RegExp(`^#{1,6} ${HEADING}$`, 'm'), 'article: heading as an ATX heading');

  assert.equal(moved.status, 'ok', 'redirect: read');
  assert.ok(moved.finalUrl.endsWith('/article'), `redirect: ends at the article, got ${moved.finalUrl}`);

  assert.equal(pdf.status, 'ok', 'pdf: read');
  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.pages, 2);
  const pdfWords = pdf.text.replace(/\s+/g, ' ');
  for (const line of PDF_PAGES) assert.ok(pdfWords.includes(line), `pdf: "${line}" read`);

  assert.equal(missing.status, 'unreachable', 'missing page: unreachable');
  assert.equal(missing.httpStatus, 404);

  // Plan section 9 rows N, F, Q: a page whose policy forbids inline scripts, a
  // document with no body, an app shell with nothing to read, and a page its
  // own script writes once the document is parsed.
  const { body: kinds } = await read(['/csp', '/notes.xml', '/shell', '/rendered']);
  const [csp, xml, shell, rendered] = kinds.pages;
  assert.equal(csp.status, 'ok', `csp page: read, got ${csp.status}`);
  assert.ok(csp.text.replace(/\s+/g, ' ').includes(CSP_PARAGRAPH), 'csp page: paragraph kept');
  assert.equal(xml.status, 'ok', `xml page: read, got ${xml.status}`);
  assert.equal(xml.text, XML, `xml page: the XML as served, got ${JSON.stringify(xml.text)}`);
  assert.equal(shell.status, 'empty', `app shell: empty, got ${shell.status} ${JSON.stringify(shell.text ?? '')}`);
  assert.equal(rendered.status, 'ok', `rendered page: read, got ${rendered.status}`);
  assert.ok(rendered.text.replace(/\s+/g, ' ').includes(RENDERED_PARAGRAPH), 'rendered page: the text its script wrote');

  // A document that is not HTML is read as its text, with no Markdown escapes;
  // a download with a type other than application/pdf is still checked for
  // the PDF signature rather than refused for its type.
  const { body: files } = await read(['/readme.txt', '/data.json', '/download.pdf', '/gbk.txt', '/binary.pdf']);
  const [plain, json, download, gbk, binaryPdf] = files.pages;
  assert.equal(plain.status, 'ok', `plain text: read, got ${plain.status}`);
  for (const line of PLAIN_LINES) {
    assert.ok(plain.text.split('\n').includes(line), `plain text: "${line}" kept as written, got ${JSON.stringify(plain.text)}`);
  }
  assert.equal(json.status, 'ok', `json: read, got ${json.status}`);
  assert.equal(json.text.trim(), JSON_BODY, `json: the raw JSON, got ${JSON.stringify(json.text)}`);
  assert.equal(download.status, 'ok', `x-pdf download: read, got ${download.status}`);
  assert.equal(download.kind, 'pdf', `x-pdf download: a pdf, got ${download.kind}`);
  assert.equal(download.pages, 2);
  const downloadWords = download.text.replace(/\s+/g, ' ');
  for (const line of PDF_PAGES) assert.ok(downloadWords.includes(line), `x-pdf download: "${line}" read`);
  // The bytes are decoded in the charset the response names.
  assert.equal(gbk.status, 'ok', `gbk text: read, got ${gbk.status}`);
  assert.ok(gbk.text.includes(GBK_TEXT), `gbk text: decoded as GBK, got ${JSON.stringify(gbk.text)}`);
  // A PDF sent as text/plain is told by its signature, binary bytes and all.
  assert.equal(binaryPdf.status, 'ok', `pdf sent as text: read, got ${binaryPdf.status}`);
  assert.equal(binaryPdf.kind, 'pdf', `pdf sent as text: a pdf, got ${binaryPdf.kind}`);
  assert.equal(binaryPdf.pages, 2);
  const binaryWords = binaryPdf.text.replace(/\s+/g, ' ');
  for (const line of PDF_PAGES) assert.ok(binaryWords.includes(line), `pdf sent as text: "${line}" read`);

  // Plan section 9 row K: a download whose declared length is past the limit ends
  // at its headers, long before the 15 s the whole file would take.
  const big = await read(['/big.bin'], { maxBytes: MAX_BYTES });
  assert.equal(big.body.pages[0].status, 'too_large', `big download: too_large, got ${big.body.pages[0].status}`);
  assert.ok(big.ms < 5000, `big download: answered in ${big.ms} ms, not after reading it whole`);

  // Plan section 15 rows 4 and 7: the size check applies only while the page
  // itself is arriving; a download the page starts after it loaded leaves the
  // article as it was read.
  const { body: leaving } = await read(['/leaves-by-script', '/leaves-by-refresh'], { maxBytes: MAX_BYTES });
  for (const [label, page] of [['by script', leaving.pages[0]], ['by refresh', leaving.pages[1]]]) {
    assert.equal(page.status, 'ok', `article that leaves ${label}: read, got ${page.status}`);
    assert.ok(page.text.replace(/\s+/g, ' ').includes(LEAVING_PARAGRAPH), `article that leaves ${label}: its text kept`);
  }

  // Plan section 16 rows 3 and 4: a document the page goes on to after it
  // loaded is checked and read as if it had been asked for: past the size
  // limit it is too_large, too slow to arrive it is too_slow (as when read
  // directly), and otherwise it is what is read, from its own address.
  const { body: goneOn } = await read(
    ['/goes-to-big-by-script', '/goes-to-big-by-refresh', '/goes-to-text', '/goes-to-article'],
    { maxBytes: MAX_BYTES },
  );
  const [toBigByScript, toBigByRefresh, toText, toArticle] = goneOn.pages;
  assert.equal(toBigByScript.status, 'too_large', `page that goes on to a big page by script: too_large, got ${toBigByScript.status}`);
  assert.equal(toBigByRefresh.status, 'too_large', `page that goes on to a big page by refresh: too_large, got ${toBigByRefresh.status}`);
  assert.equal(toText.status, 'ok', `page that goes on to a text file: read, got ${toText.status}`);
  assert.equal(toText.text, PLAIN, `page that goes on to a text file: the file's text, got ${JSON.stringify(toText.text)}`);
  assert.ok(toText.finalUrl.endsWith('/readme.txt'), `page that goes on to a text file: its address, got ${toText.finalUrl}`);
  assert.equal(toArticle.status, 'ok', `page that goes on to an article: read, got ${toArticle.status}`);
  assert.ok(toArticle.text.replace(/\s+/g, ' ').includes(PARAGRAPH), 'page that goes on to an article: that article');
  assert.ok(toArticle.finalUrl.endsWith('/article'), `page that goes on to an article: its address, got ${toArticle.finalUrl}`);
  // A document the page goes on to is the one checked whatever its address
  // holds: a missing page ends the read, and an address with a fragment (which
  // the browser shows and the response's own address never carries) is still
  // that document.
  const { body: goneOnFurther } = await read(
    ['/goes-to-missing', '/goes-to-text-at-fragment', '/goes-to-big-at-fragment'],
    { maxBytes: MAX_BYTES },
  );
  const [toMissing, toTextAtFragment, toBigAtFragment] = goneOnFurther.pages;
  assert.equal(toMissing.status, 'unreachable', `page that goes on to a missing page: unreachable, got ${toMissing.status}`);
  assert.equal(toTextAtFragment.status, 'ok', `page that goes on to a text file at a fragment: read, got ${toTextAtFragment.status}`);
  assert.equal(toTextAtFragment.text, PLAIN, `page that goes on to a text file at a fragment: the file's text, got ${JSON.stringify(toTextAtFragment.text)}`);
  assert.ok(toTextAtFragment.finalUrl.endsWith('/readme.txt#part'), `page that goes on to a text file at a fragment: its address, got ${toTextAtFragment.finalUrl}`);
  assert.equal(toBigAtFragment.status, 'too_large', `page that goes on to a big page at a fragment: too_large, got ${toBigAtFragment.status}`);
  // Plan section 17 rows 2 and 3: what is read is the last document the page
  // committed, whenever it committed it: a script in the head that replaces
  // the page before it has loaded, and a page gone on to whose answer comes
  // only after the settle wait.
  const { body: replaced } = await read(['/head-replace-to-missing', '/head-replace-to-text']);
  const [replacedByMissing, replacedByText] = replaced.pages;
  assert.equal(replacedByMissing.status, 'unreachable', `page replaced in its head by a missing page: unreachable, got ${replacedByMissing.status}`);
  assert.equal(replacedByText.status, 'ok', `page replaced in its head by a text file: read, got ${replacedByText.status}`);
  assert.equal(replacedByText.text, PLAIN, `page replaced in its head by a text file: the file's text, got ${JSON.stringify(replacedByText.text)}`);
  assert.ok(replacedByText.finalUrl.endsWith('/readme.txt'), `page replaced in its head by a text file: its address, got ${replacedByText.finalUrl}`);
  // Plan section 17 rows 2 and 3: a page its head replaces with a download
  // reads as that file opened directly.
  const { body: replacedByDownload } = await read(['/notes.csv', '/head-replace-to-download']);
  const [notesDirect, notesReplaced] = replacedByDownload.pages;
  assert.equal(notesDirect.status, 'ok', `attachment csv read directly: read, got ${notesDirect.status}`);
  assert.equal(notesDirect.text, NOTES_CSV, `attachment csv read directly: its text, got ${JSON.stringify(notesDirect.text)}`);
  assert.equal(notesReplaced.status, 'ok', `page replaced in its head by a download: read, got ${notesReplaced.status}`);
  assert.equal(notesReplaced.text, NOTES_CSV, `page replaced in its head by a download: the file's text, got ${JSON.stringify(notesReplaced.text)}`);
  // Plan section 18: how a main-frame navigation ends decides the answer. A
  // download another frame starts is not the page's ending; an error page the
  // browser commits ends the read with the status of the last response (or
  // unreachable when there is none to judge).
  // Plan section 19 row 2: a fragment in the address does not change which
  // response is the page's: a PDF and an attachment read at a fragment, and a
  // page replaced by that attachment at a fragment, read as without it.
  const { body: atFragment } = await read(
    ['/report.pdf', '/report.pdf#page=2', '/notes.csv#x', '/head-replace-to-download-at-fragment'],
    { pageTimeoutMs: 8000 },
  );
  const [pdfPlain, pdfAtFragment, notesAtFragment, replacedByNotesAtFragment] = atFragment.pages;
  assert.equal(pdfPlain.status, 'ok', `pdf without a fragment: read, got ${pdfPlain.status}`);
  assert.equal(pdfAtFragment.status, 'ok', `pdf at a fragment: read, got ${pdfAtFragment.status}`);
  assert.equal(pdfAtFragment.kind, 'pdf', `pdf at a fragment: a pdf, got ${pdfAtFragment.kind}`);
  assert.equal(pdfAtFragment.text, pdfPlain.text, `pdf at a fragment: the same text as without it, got ${JSON.stringify(pdfAtFragment.text)}`);
  assert.equal(notesAtFragment.status, 'ok', `attachment at a fragment: read, got ${notesAtFragment.status}`);
  assert.equal(notesAtFragment.text, NOTES_CSV, `attachment at a fragment: the file's text, got ${JSON.stringify(notesAtFragment.text)}`);
  assert.equal(replacedByNotesAtFragment.status, 'ok', `page replaced in its head by an attachment at a fragment: read, got ${replacedByNotesAtFragment.status}`);
  assert.equal(replacedByNotesAtFragment.text, NOTES_CSV, `page replaced in its head by an attachment at a fragment: the file's text, got ${JSON.stringify(replacedByNotesAtFragment.text)}`);

  const { body: endings } = await read(
    ['/download-landing', '/goes-to-loop', '/loop', '/head-replace-to-missing-attachment', '/missing.txt',
      '/goes-to-busy-attachment', '/busy.bin'],
    { pageTimeoutMs: 15000 },
  );
  const [landing, toLoop, loopDirect, toMissingAttachment, missingAttachment, toBusyAttachment, busyAttachment] =
    endings.pages;
  assert.equal(landing.status, 'ok', `download landing page: read, got ${landing.status}`);
  assert.ok((landing.text ?? '').replace(/\s+/g, ' ').includes(LEAVING_PARAGRAPH),
    `download landing page: its own article, got ${JSON.stringify((landing.text ?? '').slice(0, 80))}`);
  assert.ok((landing.finalUrl ?? '').endsWith('/download-landing'), `download landing page: its own address, got ${landing.finalUrl}`);
  assert.equal(loopDirect.status, 'unreachable', `redirect loop read directly: unreachable, got ${loopDirect.status}`);
  assert.equal(toLoop.status, 'unreachable', `page that goes on to a redirect loop: unreachable, got ${toLoop.status}`);
  assert.equal(missingAttachment.status, 'unreachable', `404 attachment read directly: unreachable, got ${missingAttachment.status}`);
  assert.equal(busyAttachment.status, 'busy', `503 attachment read directly: busy, got ${busyAttachment.status}`);
  assert.equal(toMissingAttachment.status, 'unreachable', `page replaced in its head by a 404 attachment: unreachable, got ${toMissingAttachment.status}`);
  assert.equal(toMissingAttachment.httpStatus, 404, `page replaced in its head by a 404 attachment: 404, got ${toMissingAttachment.httpStatus}`);
  assert.ok((toMissingAttachment.finalUrl ?? '').endsWith('/missing.txt'), `page replaced in its head by a 404 attachment: its address, got ${toMissingAttachment.finalUrl}`);
  assert.equal(toBusyAttachment.status, 'busy', `page that goes on to a 503 attachment: busy, got ${toBusyAttachment.status}`);
  assert.equal(toBusyAttachment.httpStatus, 503, `page that goes on to a 503 attachment: 503, got ${toBusyAttachment.httpStatus}`);

  const { body: late } = await read(['/goes-to-late'], { settleMs: 1000, pageTimeoutMs: 10000 });
  const [toLate] = late.pages;
  assert.equal(toLate.status, 'ok', `page that goes on to a page answering late: read, got ${toLate.status}`);
  assert.ok(toLate.text.replace(/\s+/g, ' ').includes(PARAGRAPH), 'page that goes on to a page answering late: that page');
  assert.ok(toLate.finalUrl.endsWith('/late-article'), `page that goes on to a page answering late: its address, got ${toLate.finalUrl}`);
  const { body: slowOnes } = await read(['/slow.html', '/goes-to-slow'], { pageTimeoutMs: 5000 });
  assert.equal(slowOnes.pages[0].status, 'too_slow', `slow page read directly: too_slow, got ${slowOnes.pages[0].status}`);
  assert.equal(slowOnes.pages[1].status, 'too_slow', `page that goes on to a slow page: too_slow, got ${slowOnes.pages[1].status}`);

  // Plan section 9 row O: a page that never stops running ends at its own page
  // timeout, not at the call's deadline a minute away.
  const busy = await read(['/busy'], { pageTimeoutMs: 3000 });
  assert.equal(busy.body.pages[0].status, 'too_slow', `busy page: too_slow, got ${busy.body.pages[0].status}`);
  assert.ok(busy.ms < 6000, `busy page: answered in ${busy.ms} ms`);

  // Plan section 13.1: an image sent with no type is not read; text sent with
  // no charset keeps its UTF-8; a feed is text; a CSV the browser downloads is
  // read as the text it holds.
  const { body: kinds2 } = await read(['/pixel.png', '/utf8.txt', '/feed.rss', '/tides.csv']);
  const [pixel, utf8, feed, csv] = kinds2.pages;
  assert.equal(pixel.status, 'unsupported_type', `png with no type: unsupported_type, got ${pixel.status}`);
  assert.equal(utf8.status, 'ok', `utf-8 text with no charset: read, got ${utf8.status}`);
  assert.equal(utf8.text, UTF8_TEXT, `utf-8 text with no charset: as sent, got ${JSON.stringify(utf8.text)}`);
  assert.equal(feed.status, 'ok', `rss feed: read, got ${feed.status}`);
  assert.ok(feed.text.includes(FEED_ITEM), `rss feed: the item title, got ${JSON.stringify(feed.text)}`);
  assert.equal(csv.status, 'ok', `csv download: read, got ${csv.status}`);
  assert.equal(csv.text, CSV, `csv download: the CSV as sent, got ${JSON.stringify(csv.text)}`);

  // Plan section 13.2 row 1: the service's own failure says what went wrong.
  const broken = await fetch('http://127.0.0.1:8080/read', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(broken.status, 500, `malformed request: 500, got ${broken.status}`);
  const brokenBody = await broken.text();
  assert.ok(brokenBody.trim() !== '', 'malformed request: the 500 carries the error message');

  // Plan section 14 rows 10 and 12: a latin1 CSV with no charset and a script are text.
  const { body: kinds3 } = await read(['/latin1.csv', '/tide.js']);
  const [latin1, script] = kinds3.pages;
  assert.equal(latin1.status, 'ok', `latin1 csv: read, got ${latin1.status}`);
  assert.equal(latin1.text, LATIN1_TEXT, `latin1 csv: decoded as windows-1252, got ${JSON.stringify(latin1.text)}`);
  assert.equal(script.status, 'ok', `javascript: read, got ${script.status}`);
  assert.equal(script.text, SCRIPT, `javascript: its source, got ${JSON.stringify(script.text)}`);

  // Plan section 14 row 9: a failure answer that arrives as a download ends
  // as its status says, without waiting for the page timeout.
  const failedDownloads = await read(['/busy.csv', '/forbidden.bin'], { pageTimeoutMs: 20000 });
  const [busyCsv, forbidden] = failedDownloads.body.pages;
  assert.equal(busyCsv.status, 'busy', `503 csv download: busy, got ${busyCsv.status}`);
  assert.equal(forbidden.status, 'refused', `403 attachment: refused, got ${forbidden.status}`);
  assert.ok(failedDownloads.ms < 10000, `failed downloads: answered in ${failedDownloads.ms} ms, under half the page timeout`);

  // Plan section 14 row 11: an HTML page that declares a length past the limit
  // ends at its headers.
  const bigPage = await read(['/big.html'], { maxBytes: MAX_BYTES });
  assert.equal(bigPage.body.pages[0].status, 'too_large', `big html page: too_large, got ${bigPage.body.pages[0].status}`);
  assert.ok(bigPage.ms < 5000, `big html page: answered in ${bigPage.ms} ms, not after reading it whole`);

  console.log('Web reader smoke passed: article to Markdown, redirect followed, two-page PDF read, 404 unreachable, ' +
    'CSP page, XML page, empty app shell, script-written page, plain text, GBK text, JSON, x-pdf download, ' +
    'PDF sent as text, PNG with no type, UTF-8 text with no charset, RSS feed, CSV download, oversized download, ' +
    'busy page, the service\'s own 500, latin1 CSV, JavaScript, failure downloads, an oversized HTML page and ' +
    'two articles that leave for a download, and articles that go on to a big page, a slow page, a text file and ' +
    'another article, a missing page, a text file and a big page at a fragment, pages their head replaces with a ' +
    'missing page, a text file and a download, a page gone on to that answers late, a download landing page, a ' +
    'redirect loop, 404 and 503 attachments reached from a page, and a PDF and an attachment at a fragment.');
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
