// Run inside the built media image; no cloud account or external media needed.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const directory = mkdtempSync(join(tmpdir(), 'media-smoke-'));
const fixture = join(directory, 'video.mp4');
// The upright cases (inner#1367): the photo is served at /photo.jpg, written
// back at /upright/photo.jpg, and served from then on as what was written.
const upright = { photo: null, written: null, answer: 200 };
const origin = createServer(async (req, res) => {
  if (req.url === '/photo.jpg') {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(upright.written ?? upright.photo);
    return;
  }
  if (req.method === 'PUT' && req.url === '/upright/photo.jpg') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (upright.answer === 200) upright.written = Buffer.concat(chunks);
    res.writeHead(upright.answer).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'video/mp4' });
  res.end(readFileSync(fixture));
});

/** A JPEG with an APP1 Exif segment carrying `orientation`, inserted after SOI. */
function withOrientation(jpeg, orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, payload, jpeg.subarray(2)]);
}

/** The red channel at the middle of one side of a picture, read with vips. */
function redAt(file, side) {
  const width = Number(execFileSync('vipsheader', ['-f', 'width', file]).toString());
  const height = Number(execFileSync('vipsheader', ['-f', 'height', file]).toString());
  const point = { top: [width / 2, 2], bottom: [width / 2, height - 3], left: [2, height / 2], right: [width - 3, height / 2] }[side];
  return Number(execFileSync('vips', ['getpoint', file, String(Math.floor(point[0])), String(Math.floor(point[1]))]).toString().trim().split(/\s+/)[0]);
}
let service;
try {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    'color=c=blue:s=64x48:r=10', '-t', '1', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', fixture], { timeout: 30000 });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  service = spawn(process.execPath, ['/app/server.mjs'], { stdio: 'inherit' });
  for (let attempt = 0; ; attempt++) {
    try {
      const ready = await fetch('http://127.0.0.1:8080/', { signal: AbortSignal.timeout(1000) });
      assert.equal(ready.status, 404);
      break;
    } catch (error) {
      if (attempt >= 49 || service.exitCode !== null) throw error;
      await setTimeout(100);
    }
  }
  for (const wantCover of [true, false]) {
    const answer = await fetch('http://127.0.0.1:8080/probe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectUrl: `http://127.0.0.1:${origin.address().port}/video.mp4`,
        wantCover, deadlineAt: Date.now() + 25000 }), signal: AbortSignal.timeout(25000),
    });
    assert.equal(answer.status, 200);
    const form = await answer.formData();
    const report = JSON.parse(form.get('meta'));
    assert.ok(report.streams.some(stream => stream.width === 64 && stream.height === 48));
    assert.ok(report.durationSeconds > 0);
    const cover = form.get('cover');
    if (wantCover) {
      assert.equal(cover.type, 'image/png');
      assert.deepEqual(Buffer.from(await cover.arrayBuffer()).subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    } else assert.equal(cover, null);
  }
  // Stored 64x48 with the top half red. Where that half is shown, per EXIF
  // orientation, is where it has to be once the picture is turned upright.
  const plain = join(directory, 'plain.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x24', '-f', 'lavfi', '-i',
    'color=c=blue:s=64x24', '-filter_complex', '[0][1]vstack', '-frames:v', '1', plain], { timeout: 30000 });
  const shownRed = { 2: 'top', 3: 'bottom', 4: 'bottom', 5: 'left', 6: 'right', 7: 'right', 8: 'left' };
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const photoUrl = `http://127.0.0.1:${origin.address().port}/photo.jpg`;
  const writeUrl = `http://127.0.0.1:${origin.address().port}/upright/photo.jpg`;
  for (const [orientation, side] of Object.entries(shownRed)) {
    upright.photo = withOrientation(readFileSync(plain), Number(orientation));
    upright.written = null;
    upright.answer = 200;
    const answer = await fetch('http://127.0.0.1:8080/probe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectUrl: photoUrl, wantCover: false, wantPreview: true,
        deadlineAt: Date.now() + 25000,
        upright: { writeUrl, contentType: 'image/jpeg', lossless: false, quality: 90 } }),
      signal: AbortSignal.timeout(25000),
    });
    assert.equal(answer.status, 200, `orientation ${orientation}`);
    const out = join(directory, `upright-${orientation}.jpg`);
    execFileSync('sh', ['-c', `cat > ${out}`], { input: upright.written });
    const turned = Number(orientation) >= 5;
    assert.equal(Number(execFileSync('vipsheader', ['-f', 'width', out]).toString()), turned ? 48 : 64);
    assert.throws(() => execFileSync('vipsheader', ['-f', 'orientation', out], { stdio: 'pipe' }));
    assert.ok(redAt(out, side) > 200 && redAt(out, opposite[side]) < 60, `orientation ${orientation}: red on the ${side}`);
    const form = await answer.formData();
    const report = JSON.parse(form.get('meta'));
    assert.ok(report.streams.some(stream => stream.width === (turned ? 48 : 64)), `orientation ${orientation}: probed the written picture`);
    assert.ok(form.get('preview') !== null, `orientation ${orientation}: preview cut`);
  }
  for (const refused of [409, 500]) {
    upright.photo = withOrientation(readFileSync(plain), 6);
    upright.written = null;
    upright.answer = refused;
    const answer = await fetch('http://127.0.0.1:8080/probe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectUrl: photoUrl, wantCover: false, wantPreview: true,
        deadlineAt: Date.now() + 25000,
        upright: { writeUrl, contentType: 'image/jpeg', lossless: false, quality: 90 } }),
      signal: AbortSignal.timeout(25000),
    });
    assert.equal(answer.status, 409, `write-back answered ${refused}`);
  }

  const invalid = await fetch('http://127.0.0.1:8080/probe', {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(1000),
  });
  assert.equal(invalid.status, 400);
  console.log('Media smoke passed: HTTP video probe, PNG cover, no-cover, upright for orientations 2-8, refused write-back and invalid request.');
} finally {
  service?.kill();
  origin.closeAllConnections();
  origin.close();
  rmSync(directory, { recursive: true, force: true });
}
