// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
// Run inside the built page reader image (inner#1664), offline: a local origin
// serves an article, a redirect to it, a two-page PDF and a missing page, and
// the service in /app/server.mjs reads them with its own browser.
//   docker run --rm --network none -v "$PWD/scripts/ingest-web-reader-smoke.mjs:/tmp/web-reader-smoke.mjs:ro" \
//     --entrypoint node <image> /tmp/web-reader-smoke.mjs
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

const HEADING = 'Reading inside the container';
const PARAGRAPH = 'The quiet harbour lighthouse guides every fishing boat home before the evening storm arrives.';
const PDF_PAGES = ['Hello page one', 'Second page here'];

/** A minimal valid PDF with one line of Helvetica text per page, its xref offsets exact. */
function pdfOf(lines) {
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
  let out = '%PDF-1.4\n';
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

const origin = createServer((req, res) => {
  if (req.url === '/article') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ARTICLE);
  else if (req.url === '/moved') res.writeHead(302, { location: '/article' }).end();
  else if (req.url === '/report.pdf') res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF.length }).end(PDF);
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

  const urls = ['/article', '/moved', '/report.pdf', '/missing'].map(at);
  const response = await fetch('http://127.0.0.1:8080/read', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls, deadlineAt: Date.now() + 60000, pageTimeoutMs: 20000, settleMs: 1000,
      concurrency: 4, maxBytes: 20971520 }),
    signal: AbortSignal.timeout(90000),
  });
  assert.equal(response.status, 200);
  const answer = await response.json();
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

  console.log('Web reader smoke passed: article to Markdown, redirect followed, two-page PDF read, 404 unreachable.');
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
