// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
// Run inside the exact native release image with --network none. No render job
// is submitted: the service rejects malformed input, while the producer, the
// headless shell and FFmpeg it drives are each checked to be present and runnable.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, constants, readFile, readdir } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

/** Read one response from the local service; no request can leave loopback. */
function localStatus(path, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: 8080, path, method }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.setTimeout(1_000, () => req.destroy(new Error('Local service timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

assert.ok(process.getuid() !== 0, 'the shipped image must run as its unprivileged user');
assert.equal(Number(process.versions.node.split('.')[0]), 24);

// The producer is the version every Manifest's runtime names, and the bundle's bare import resolves from /app.
const producerPackage = JSON.parse(await readFile('/app/node_modules/@hyperframes/producer/package.json', 'utf8'));
assert.equal(producerPackage.version, '0.8.186');
const producer = spawnSync(process.execPath, ['--input-type=module', '-e',
  "const p = await import('@hyperframes/producer'); if (typeof p.createRenderJob !== 'function' || typeof p.executeRenderJob !== 'function') process.exit(3);",
], { cwd: '/app', encoding: 'utf8', timeout: 60_000 });
assert.equal(producer.status, 0, producer.stderr);
// libvips (LGPL-3.0) is not shipped: sharp and its native packages are removed at build time.
for (const path of ['/app/node_modules/sharp', '/app/node_modules/@img']) assert.equal(existsSync(path), false, `${path} must not ship`);

// The headless shell the producer is pointed at, and where its source is recorded.
const shell = (await readFile('/opt/chs/path.txt', 'utf8')).trim();
await access(shell, constants.X_OK);
const shellVersion = spawnSync(shell, ['--version'], { encoding: 'utf8', timeout: 30_000 });
assert.match(`${shellVersion.stdout}${shellVersion.stderr}`, /157\.0\.8103\.78/);
for (const path of ['/opt/chs/SOURCE', '/usr/share/ffmpeg-source/SOURCE', '/usr/share/doc/breatic/THIRD-PARTY.md']) {
  assert.ok((await readFile(path)).length > 0, `${path} must ship with the image`);
}

// FFmpeg and ffprobe run.
for (const bin of [process.env.WEB_ANIMATION_FFMPEG_BIN, process.env.WEB_ANIMATION_FFPROBE_BIN]) {
  assert.equal(typeof bin, 'string');
  const version = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(version.status, 0, version.stderr);
}

// The one font set, laid out as the creation container's.
const fontsDir = process.env.WEB_ANIMATION_FONTS_DIR;
const versions = (await readdir(fontsDir)).filter((name) => /^v\d+$/.test(name));
assert.equal(versions.length, 1);
const faces = JSON.parse(await readFile(join(fontsDir, versions[0], 'faces.json'), 'utf8'));
assert.ok(faces.length > 0);

// The service answers on its port and refuses what is not a run.
const service = spawn(process.execPath, ['/app/server.mjs'], { stdio: 'inherit', env: { ...process.env, PRODUCER_HEADLESS_SHELL_PATH: shell } });
try {
  let status = 0;
  for (let attempt = 0; attempt < 20 && status === 0; attempt += 1) {
    status = await localStatus('/elsewhere').catch(() => 0);
    if (status === 0) await setTimeout(250);
  }
  assert.equal(status, 404);
  assert.equal(await localStatus('/run', 'POST', 'not json'), 400);
} finally {
  service.kill();
}
