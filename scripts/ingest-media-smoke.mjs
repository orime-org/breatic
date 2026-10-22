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
// The upright cases (inner#1367): the photo is served at /photo, and the
// container writes the upright picture back to /upright with its pixel size.
const upright = { photo: null, written: null, headers: null, answer: 200 };
// The peaks cases (inner#1305): each file at its own path under /media/.
const served = new Map();
const origin = createServer(async (req, res) => {
  if (req.url?.startsWith('/media/') && served.has(req.url)) {
    // Ranged like the Worker's own object route (src/media-object-route.ts):
    // an m4a whose index sits at its end is read by seeking there.
    const bytes = readFileSync(served.get(req.url));
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range === null) {
      res.writeHead(200, { 'accept-ranges': 'bytes', 'content-length': bytes.length });
      res.end(bytes);
      return;
    }
    const start = Number(range[1]);
    const end = range[2] === '' ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
    res.writeHead(206, { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${bytes.length}`,
      'content-length': end - start + 1 });
    res.end(bytes.subarray(start, end + 1));
    return;
  }
  if (req.url === '/photo') {
    res.writeHead(200);
    res.end(upright.photo);
    return;
  }
  if (req.method === 'PUT' && req.url === '/upright') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (upright.answer === 200) {
      upright.written = Buffer.concat(chunks);
      upright.headers = req.headers;
    }
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
  // inner#1305 §4.4: audio answers a peaks file, a video with sound does not.
  // The long one runs past 131 s, so ffmpeg writes more than the 4 MiB a
  // buffering runner would hold; the mp3 carries album art, which is not a
  // picture of its own.
  const art = join(directory, 'art.png');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', art], { timeout: 30000 });
  const sounds = {
    'long.m4a': ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=140', '-c:a', 'aac'],
    'art.mp3': ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=5', '-i', art, '-map', '0', '-map', '1',
      '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic'],
    'clip.mp4': ['-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=10:d=2', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
  };
  for (const [name, args] of Object.entries(sounds)) {
    const file = join(directory, name);
    execFileSync('ffmpeg', ['-v', 'error', ...args, file], { timeout: 60000 });
    served.set(`/media/${name}`, file);
  }
  for (const [name, wantsPeaks, count] of [['long.m4a', true, 1000], ['art.mp3', true, 1000], ['clip.mp4', false, 0]]) {
    const answer = await fetch('http://127.0.0.1:8080/probe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectUrl: `http://127.0.0.1:${origin.address().port}/media/${name}`,
        wantCover: false, wantPeaks: true, deadlineAt: Date.now() + 25000 }), signal: AbortSignal.timeout(25000),
    });
    assert.equal(answer.status, 200, `${name}: answered`);
    const peaks = (await answer.formData()).get('peaks');
    if (!wantsPeaks) {
      assert.equal(peaks, null, `${name}: no peaks for a video`);
      continue;
    }
    assert.ok(peaks !== null, `${name}: peaks answered`);
    assert.equal(peaks.type, 'application/json', `${name}: peaks typed`);
    const file = JSON.parse(await peaks.text());
    assert.equal(file.version, 1, `${name}: version`);
    assert.equal(file.peaks.length, count, `${name}: one value per stretch`);
    assert.ok(file.peaks.every(value => Number.isInteger(value) && value >= 0 && value <= 255), `${name}: values in range`);
    // lavfi's sine plays at an eighth of full scale, which reads as 32; the
    // encoders overshoot near the edges, so the middle value is what is held.
    const middle = [...file.peaks].sort((a, b) => a - b)[file.peaks.length >> 1];
    assert.ok(middle >= 28 && middle <= 40, `${name}: the tone reads at its level, got ${middle}`);
  }
  // Stored 64x48 with the top half red. Where that half is shown, per EXIF
  // orientation, is where it has to be once the picture is turned upright.
  const plain = join(directory, 'plain.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x24', '-f', 'lavfi', '-i',
    'color=c=blue:s=64x24', '-filter_complex', '[0][1]vstack', '-frames:v', '1', plain], { timeout: 30000 });
  const shownRed = { 1: 'top', 2: 'top', 3: 'bottom', 4: 'bottom', 5: 'left', 6: 'right', 7: 'right', 8: 'left' };
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const photoUrl = `http://127.0.0.1:${origin.address().port}/photo`;
  const writeUrl = `http://127.0.0.1:${origin.address().port}/upright`;
  /** Ask the container to turn the served photo upright; answers the parsed form. */
  async function turn(contentType, lossless = false) {
    upright.written = null;
    upright.headers = null;
    const answer = await fetch('http://127.0.0.1:8080/probe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectUrl: photoUrl, wantCover: false, wantPreview: true,
        deadlineAt: Date.now() + 25000,
        upright: { writeUrl, contentType, lossless, quality: 90, maxBytes: 16 * 1024 * 1024 } }),
      signal: AbortSignal.timeout(25000),
    });
    assert.equal(answer.status, 200, `${contentType}: answered`);
    const form = await answer.formData();
    return { report: JSON.parse(form.get('meta')), outcome: JSON.parse(form.get('upright')), preview: form.get('preview') };
  }
  /** Check what was written: turned, its tag gone, red where it is shown. */
  function checkWritten(label, extension, turned, side, blueRed = 60) {
    const out = join(directory, `upright-${label}.${extension}`);
    execFileSync('sh', ['-c', `cat > ${out}`], { input: upright.written });
    assert.equal(Number(execFileSync('vipsheader', ['-f', 'width', out]).toString()), turned ? 48 : 64, `${label}: width`);
    assert.throws(() => execFileSync('vipsheader', ['-f', 'orientation', out], { stdio: 'pipe' }), `${label}: tag dropped`);
    assert.ok(redAt(out, side) > 200 && redAt(out, opposite[side]) < blueRed, `${label}: red on the ${side}`);
    assert.equal(upright.headers['x-upright-width'], String(turned ? 48 : 64), `${label}: width header`);
    assert.equal(upright.headers['x-upright-height'], String(turned ? 64 : 48), `${label}: height header`);
    return out;
  }
  upright.answer = 200;
  for (const [orientation, side] of Object.entries(shownRed)) {
    upright.photo = withOrientation(readFileSync(plain), Number(orientation));
    const turned = Number(orientation) >= 5;
    const ran = await turn('image/jpeg');
    assert.deepEqual(ran.outcome, { state: 'written' }, `orientation ${orientation}: written`);
    checkWritten(`jpeg-${orientation}`, 'jpg', turned, side);
    assert.ok(ran.report.streams.some(stream => stream.width === (turned ? 48 : 64)), `orientation ${orientation}: probed the turned picture`);
    assert.ok(ran.preview !== null, `orientation ${orientation}: preview cut`);
  }
  // A PNG (eXIf chunk) and a WebP (EXIF chunk) at orientation 6, and a JPEG
  // carrying an ICC profile: vips keeps the profile through the turn.
  const tagged6 = join(directory, 'tagged6.jpg');
  execFileSync('sh', ['-c', `cat > ${tagged6}`], { input: withOrientation(readFileSync(plain), 6) });
  for (const [format, contentType] of [['png', 'image/png'], ['webp', 'image/webp']]) {
    const source = join(directory, `tagged6.${format}`);
    execFileSync('vips', ['copy', tagged6, source]);
    assert.equal(execFileSync('vipsheader', ['-f', 'orientation', source]).toString().trim(), '6', `${format}: tagged`);
    upright.photo = readFileSync(source);
    const ran = await turn(contentType);
    assert.deepEqual(ran.outcome, { state: 'written' }, `${format}: written`);
    checkWritten(format, format, true, 'right');
  }
  const withIcc = join(directory, 'icc6.jpg');
  // At Q95: the default Q75 re-encode bleeds enough red into the blue half to
  // read as red where the check samples.
  execFileSync('vips', ['icc_export', tagged6, `${withIcc}[Q=95]`, '--output-profile', 'srgb']);
  assert.equal(execFileSync('vipsheader', ['-f', 'orientation', withIcc]).toString().trim(), '6', 'icc: tagged');
  upright.photo = readFileSync(withIcc);
  assert.deepEqual((await turn('image/jpeg')).outcome, { state: 'written' }, 'icc: written');
  // Converted to the sRGB profile, the blue half reads red 90 already in the
  // sample, so the turned picture is held to the sample's own blue.
  const iccOut = checkWritten('icc', 'jpg', true, 'right', redAt(withIcc, 'bottom') + 20);
  assert.ok(execFileSync('vipsheader', ['-a', iccOut]).toString().includes('icc-profile-data'), 'icc: profile kept');

  for (const refused of [409, 500]) {
    upright.photo = withOrientation(readFileSync(plain), 6);
    upright.answer = refused;
    assert.deepEqual((await turn('image/jpeg')).outcome, { state: 'failed', step: 'write' }, `write-back answered ${refused}`);
  }

  const invalid = await fetch('http://127.0.0.1:8080/probe', {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(1000),
  });
  assert.equal(invalid.status, 400);
  console.log('Media smoke passed: HTTP video probe, PNG cover, no-cover, audio peaks (long m4a, mp3 with art, none for video), upright JPEG for orientations 1-8, PNG and WebP at 6, ICC kept, refused write-back and invalid request.');
} finally {
  service?.kill();
  origin.closeAllConnections();
  origin.close();
  rmSync(directory, { recursive: true, force: true });
}
