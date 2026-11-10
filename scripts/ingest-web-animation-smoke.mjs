// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
// Run inside the exact native release image with --network none. No model call
// or generation job is submitted: the runner rejects malformed input, while
// Chromium loads the shipped runtime and a shipped font in a fixed composition.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
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
const major = Number(process.versions.node.split('.')[0]);
assert.equal(major, 24);
const fontsDir = process.env.WEB_ANIMATION_FONTS_DIR;
const runtimeFile = process.env.WEB_ANIMATION_RUNTIME_FILE;
const dshBin = process.env.WEB_ANIMATION_DSH_BIN;
const chromiumBin = process.env.WEB_ANIMATION_CHROMIUM_BIN;
const home = process.env.WEB_ANIMATION_HOME;
const profileName = process.env.WEB_ANIMATION_DSH_PROFILE;
for (const value of [fontsDir, runtimeFile, dshBin, chromiumBin, home, profileName]) assert.equal(typeof value, 'string');
const profileDir = join(home, '.dsh/profiles', profileName);
const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
assert.deepEqual(profile.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']);
const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8');
assert.match(patch, /apiKeyEnv: DEEPSEEK_API_KEY/);
assert.match(patch, /id: tool-web\s+disabled: true/);
assert.match(patch, /id: tool-subagent\s+disabled: true/);
for (const path of ['/usr/share/doc/breatic/THIRD-PARTY.md', '/usr/share/chromium-source/SOURCE', '/usr/share/doc/chromium/copyright', '/app/runtime/LICENSE']) {
  assert.ok((await readFile(path)).length > 0, `${path} must ship with the image`);
}
const harness = spawnSync(dshBin, ['--help'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: home } });
assert.equal(harness.status, 0, harness.stderr);
assert.match(harness.stdout, /dsh|deepseek/i);
const versions = (await readdir(fontsDir)).filter((name) => /^v\d+$/.test(name));
assert.equal(versions.length, 1);
const fontRoot = join(fontsDir, versions[0]);
const faces = JSON.parse(await readFile(join(fontRoot, 'faces.json'), 'utf8'));
assert.deepEqual([...new Set(faces.map((face) => face.family))].sort(), ['Inter', 'Noto Sans JP', 'Noto Sans KR', 'Noto Sans SC', 'Noto Sans TC', 'Noto Serif SC']);
for (const face of faces) {
  const bytes = await readFile(join(fontRoot, `${face.file}.woff2`));
  assert.equal(bytes.subarray(0, 4).toString(), 'wOF2', face.file);
}
assert.equal((await readdir(fontRoot)).filter((name) => name.endsWith('-OFL.txt')).length, 6);
const latin = faces.find((face) => face.family === 'Inter' && face.file.includes('-latin-'));
assert.ok(latin, 'the fixed ASCII composition needs the shipped Inter latin face');
const font = (await readFile(join(fontRoot, `${latin.file}.woff2`))).toString('base64');
const runtime = (await readFile(runtimeFile, 'utf8')).replace(/<\/script/gi, '<\\/script');
assert.ok(runtime.length > 0);
const directory = await mkdtemp(join(tmpdir(), 'animation-image-smoke-'));
let server;
try {
  let logs = '';
  server = spawn(process.execPath, ['/app/server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => { logs += chunk; });
  server.stderr.on('data', (chunk) => { logs += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null) throw new Error(`Animation server exited: ${logs}`);
    try { ready = await localStatus('/') === 404; } catch { /* Wait only for the process to bind its loopback port. */ }
    if (ready) break;
    await setTimeout(100);
  }
  assert.equal(ready, true, logs);
  assert.equal(await localStatus('/run', 'POST', '{'), 400);
  assert.equal(await localStatus('/'), 404, 'malformed input must leave the runner responsive');
  const html = join(directory, 'index.html');
  await writeFile(html, `<!doctype html><html><head></head><body>
<div id="main" data-composition-id="main" data-start="0" data-duration="1" data-width="320" data-height="180">Offline animation</div>
<script>${runtime}</script><script>
const face = new FontFace('ImageSmoke', 'url(data:font/woff2;base64,${font})');
document.fonts.add(face);
face.load().then(() => {
  document.getElementById('main').style.fontFamily = 'ImageSmoke';
  const ready = setInterval(() => {
    if (window.__playerReady === true && typeof window.__player?.renderSeek === 'function') {
      window.__player.renderSeek(0);
      document.body.dataset.imageSmoke = face.status === 'loaded' ? 'runtime-font-ready' : 'font-failed';
      clearInterval(ready);
    }
  }, 50);
});
</script></body></html>`);
  const browser = spawnSync(chromiumBin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    `--user-data-dir=${join(directory, 'chromium')}`, '--virtual-time-budget=5000', '--dump-dom', `file://${html}`],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(browser.status, 0, browser.stderr);
  assert.match(browser.stdout, /data-image-smoke="runtime-font-ready"/);
  console.log(JSON.stringify({ check: 'ingest-web-animation-image', status: 'passed', service: 'malformed-request-rejected',
    chromiumRuntimeAndFont: true, shippedFontFamilies: 6, profile: profileName, modelCalls: 0, network: 'none' }));
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGKILL');
    await once(server, 'close');
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
