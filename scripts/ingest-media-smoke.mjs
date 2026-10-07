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
const origin = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'video/mp4' });
  res.end(readFileSync(fixture));
});
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
        wantCover, toolTimeoutMs: 10000 }), signal: AbortSignal.timeout(25000),
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
  const invalid = await fetch('http://127.0.0.1:8080/probe', {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(1000),
  });
  assert.equal(invalid.status, 400);
  console.log('Media smoke passed: HTTP video probe, PNG cover, no-cover and invalid request.');
} finally {
  service?.kill();
  origin.closeAllConnections();
  origin.close();
  rmSync(directory, { recursive: true, force: true });
}
