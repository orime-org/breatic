// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
// Run inside the built page reader image (inner#1664), offline: a local origin
// serves an article, a redirect to it, a two-page PDF, a missing page and the
// pages of plan §9 rows T and W (a CSP page, an XML page, an empty app shell, a
// page its script writes, a download past the size limit, a page that never
// stops running), a plain-text file, a JSON file and a PDF download sent with a
// type other than application/pdf, and the service in /app/server.mjs reads them with its own
// browser.
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
// Its parser never reaches the end of the head.
const BUSY = '<!doctype html><html><head><title>Busy</title><script>for (;;) {}</script></head><body><p>Never shown</p></body></html>';
// Markdown-looking text a plain-text file holds, which must come back unescaped.
const PLAIN_LINES = ['# Install', '* run `pnpm i`', '/\\d+/'];
const PLAIN = `${PLAIN_LINES.join('\n')}\n`;
// Four Chinese characters in GBK, written out because Node's TextEncoder only writes UTF-8.
const GBK_TEXT = '\u4e2d\u6587\u6d4b\u8bd5';
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
const JSON_BODY = '{"name":"harbour","tides":[1,2,3],"note":"# not a heading"}';
const BIG_BYTES = 30 * 1024 * 1024;
const MAX_BYTES = 20 * 1024 * 1024;
const CHUNK = Buffer.alloc(1024 * 1024);

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
  else if (req.url === '/rendered') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(RENDERED);
  else if (req.url === '/busy') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(BUSY);
  else if (req.url === '/big.bin') void sendBigDownload(res);
  else if (req.url === '/readme.txt') res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(PLAIN);
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

  // Plan §9 rows N, F, Q: a page whose policy forbids inline scripts, a
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

  // Plan §9 row K: a download whose declared length is past the limit ends
  // at its headers, long before the 15 s the whole file would take.
  const big = await read(['/big.bin'], { maxBytes: MAX_BYTES });
  assert.equal(big.body.pages[0].status, 'too_large', `big download: too_large, got ${big.body.pages[0].status}`);
  assert.ok(big.ms < 5000, `big download: answered in ${big.ms} ms, not after reading it whole`);

  // Plan §9 row O: a page that never stops running ends at its own page
  // timeout, not at the call's deadline a minute away.
  const busy = await read(['/busy'], { pageTimeoutMs: 3000 });
  assert.equal(busy.body.pages[0].status, 'too_slow', `busy page: too_slow, got ${busy.body.pages[0].status}`);
  assert.ok(busy.ms < 6000, `busy page: answered in ${busy.ms} ms`);

  console.log('Web reader smoke passed: article to Markdown, redirect followed, two-page PDF read, 404 unreachable, ' +
    'CSP page, XML page, empty app shell, script-written page, plain text, GBK text, JSON, x-pdf download, ' +
    'PDF sent as text, oversized download ' +
    'and busy page.');
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
