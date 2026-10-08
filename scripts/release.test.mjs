// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfo, checkComposeTag, composeImageTags, releaseManifest, checkImageIndex } from './release.mjs';
const sha = 'a'.repeat(40);
const backend = `ghcr.io/orime-org/breatic@sha256:${'b'.repeat(64)}`;
const web = `ghcr.io/orime-org/breatic-web@sha256:${'c'.repeat(64)}`;
const media = `ghcr.io/orime-org/breatic-ingest-media@sha256:${'d'.repeat(64)}`;
test('stable and candidate releases preserve full source identity', () => {
  for (const version of ['0.2.0', '1.0.0-rc.1']) {
    assert.deepEqual(buildInfo(version, sha), { releaseVersion: version, revision: sha });
  }
  assert.equal(buildInfo().releaseVersion, '0.0.0-dev');
});
test('invalid or incomplete release identities fail closed', () => {
  for (const version of ['v0.2.0', '01.2.0', '0.2', 'latest', '1.2.3-rc.01', '1.2.3+build']) {
    assert.throws(() => buildInfo(version, sha));
  }
  assert.throws(() => buildInfo('0.2.0', 'unknown'));
  assert.throws(() => buildInfo('0.2.0', sha.slice(0, 7)));
});
test('release manifests pin all three images to digest and one source revision', () => {
  const result = releaseManifest('v0.2.0', sha, 'orime-org/breatic', backend, web, media);
  assert.equal(result.tag, 'v0.2.0');
  assert.equal(result.revision, sha);
  assert.equal(result.images.backend, backend);
  assert.equal(result.images.ingestMedia, media);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.platform, undefined);
  assert.deepEqual(result.imagePlatforms, { backend: ['linux/amd64', 'linux/arm64'], web: ['linux/amd64', 'linux/arm64'], ingestMedia: ['linux/amd64'] });
});
test('moving tags, wrong repositories, truncated digests cannot become a release', () => {
  for (const ref of ['ghcr.io/orime-org/breatic:latest', backend.slice(0, -1), web, backend.replace('orime-org', 'other')]) {
    assert.throws(() => releaseManifest('v0.2.0', sha, 'orime-org/breatic', ref, web, media));
  }
  for (const ref of [undefined, media.replace('@sha256:', ':v'), media.slice(0, -1), backend, media.replace('orime-org', 'other')]) {
    assert.throws(() => releaseManifest('v0.2.0', sha, 'orime-org/breatic', backend, web, ref));
  }
  assert.throws(() => releaseManifest('v0.0.0-dev', sha, 'orime-org/breatic', backend, web, media));
  assert.throws(() => releaseManifest('0.2.0', sha, 'orime-org/breatic', backend, web, media));
});

test('CLI emits build metadata and validates tag versus branch identities', () => {
  const script = fileURLToPath(new URL('./release.mjs', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'breatic-release-'));
  try {
    const output = join(directory, 'build-info.json');
    execFileSync(process.execPath, [script, 'build-info', '0.2.0', sha, output]);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), buildInfo('0.2.0', sha));
    execFileSync(process.execPath, [script, 'manifest', 'v0.2.0', sha, 'orime-org/breatic', backend, web, media, output]);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).images.ingestMedia, media);
    assert.notEqual(spawnSync(process.execPath, [script, 'manifest', 'v0.2.0', sha, 'orime-org/breatic', backend, web, output]).status, 0);
    assert.match(execFileSync(process.execPath, [script, 'ci', 'refs/tags/v0.2.0', sha], { encoding: 'utf8' }), /version=0.2.0\nimage_tag=v0.2.0/);
    assert.match(execFileSync(process.execPath, [script, 'ci', 'refs/heads/main', sha], { encoding: 'utf8' }), /version=0.0.0-dev\nimage_tag=ci/);
    assert.notEqual(spawnSync(process.execPath, [script, 'ci', 'refs/tags/vlatest', sha]).status, 0);
    assert.notEqual(spawnSync(process.execPath, [script, 'build-info', '0.2.0', 'unknown', output]).status, 0);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

const composeWith = (backendTag, webTag = backendTag) => [
  'services:',
  '  web:',
  `    image: ghcr.io/orime-org/breatic-web:${webTag}`,
  ...['migrate', 'server', 'collab', 'worker'].flatMap((name) => [`  ${name}:`, `    image: ghcr.io/orime-org/breatic:${backendTag}`]),
  '  postgres:',
  '    image: postgres:16-alpine',
].join('\n');

test('compose image tags are read from every product image line', () => {
  assert.deepEqual(composeImageTags(composeWith('v0.2.0')), ['v0.2.0', 'v0.2.0', 'v0.2.0', 'v0.2.0', 'v0.2.0']);
  assert.deepEqual(composeImageTags(composeWith('v0.2.0', 'v0.1.0')), ['v0.1.0', 'v0.2.0', 'v0.2.0', 'v0.2.0', 'v0.2.0']);
  const quoted = composeWith('v0.2.0')
    .replace('image: ghcr.io/orime-org/breatic-web:v0.2.0', 'image: "ghcr.io/orime-org/breatic-web:v0.2.0"')
    .replace('image: ghcr.io/orime-org/breatic:v0.2.0', "image: 'ghcr.io/orime-org/breatic:v0.2.0'  # pinned");
  assert.deepEqual(composeImageTags(quoted), ['v0.2.0', 'v0.2.0', 'v0.2.0', 'v0.2.0', 'v0.2.0']);
});

test('a missing product image line is reported as a line count, not as a wrong tag', () => {
  const missing = composeWith('v0.2.0').replace(/\n  worker:\n.*/, '');
  assert.throws(() => checkComposeTag('v0.2.0', missing), /found 4 product image lines, expected 5/);
});

test('a stable tag must match all five compose images; candidates are not checked', () => {
  const script = fileURLToPath(new URL('./release.mjs', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'breatic-compose-'));
  try {
    const run = (tag, text) => {
      const file = join(directory, 'docker-compose.yml');
      writeFileSync(file, text);
      return spawnSync(process.execPath, [script, 'compose-tag', tag, file], { encoding: 'utf8' });
    };
    assert.equal(run('v0.2.0', composeWith('v0.2.0')).status, 0);
    const stale = run('v0.2.0', composeWith('v0.1.0'));
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /v0\.1\.0/);
    assert.notEqual(run('v0.2.0', composeWith('v0.2.0', 'v0.1.0')).status, 0);
    assert.notEqual(run('v0.2.0', composeWith('v0.2.0').replace(/\n  worker:\n.*/, '')).status, 0);
    assert.equal(run('v0.2.0-rc.1', composeWith('v0.1.0')).status, 0);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('the repository compose file pins one stable release for every product image', () => {
  const text = readFileSync(fileURLToPath(new URL('../docker-compose.yml', import.meta.url)), 'utf8');
  const [tag] = composeImageTags(text);
  assert.doesNotMatch(tag, /-rc\./);
  checkComposeTag(tag, text);
});

const descriptor = (arch, hash) => ({ digest: 'sha256:' + hash.repeat(64), platform: { os: 'linux', architecture: arch } });
test('indexes must contain exactly the two tested native image digests', () => {
  const amd = descriptor('amd64', 'b'); const arm = descriptor('arm64', 'c');
  const index = { manifests: [amd, arm] };
  assert.doesNotThrow(() => checkImageIndex(index, amd.digest, arm.digest));
  for (const manifests of [[amd], [arm], [amd, amd], [amd, descriptor('arm64', 'd')], [amd, arm, descriptor('s390x', 'e')]]) {
    assert.throws(() => checkImageIndex({ manifests }, amd.digest, arm.digest));
  }
  assert.throws(() => checkImageIndex({ ...index, manifests: [amd, { ...arm, platform: { os: 'windows', architecture: 'arm64' } }] }, amd.digest, arm.digest));
});
