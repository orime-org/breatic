// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfo, composeImageTags, releaseManifest } from './release.mjs';
const sha = 'a'.repeat(40);
const backend = `ghcr.io/orime-org/breatic@sha256:${'b'.repeat(64)}`;
const web = `ghcr.io/orime-org/breatic-web@sha256:${'c'.repeat(64)}`;
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
test('release manifests pin both images to digest and one source revision', () => {
  const result = releaseManifest('v0.2.0', sha, 'orime-org/breatic', backend, web);
  assert.equal(result.tag, 'v0.2.0');
  assert.equal(result.revision, sha);
  assert.equal(result.images.backend, backend);
  assert.equal(result.platform, 'linux/amd64');
});
test('moving tags, wrong repositories, truncated digests cannot become a release', () => {
  for (const ref of ['ghcr.io/orime-org/breatic:latest', backend.slice(0, -1), web, backend.replace('orime-org', 'other')]) {
    assert.throws(() => releaseManifest('v0.2.0', sha, 'orime-org/breatic', ref, web));
  }
  assert.throws(() => releaseManifest('v0.0.0-dev', sha, 'orime-org/breatic', backend, web));
  assert.throws(() => releaseManifest('0.2.0', sha, 'orime-org/breatic', backend, web));
});

test('CLI emits build metadata and validates tag versus branch identities', () => {
  const script = fileURLToPath(new URL('./release.mjs', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'breatic-release-'));
  try {
    const output = join(directory, 'build-info.json');
    execFileSync(process.execPath, [script, 'build-info', '0.2.0', sha, output]);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), buildInfo('0.2.0', sha));
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
  const tags = composeImageTags(text);
  assert.equal(tags.length, 5);
  assert.equal(new Set(tags).size, 1);
  assert.match(tags[0], /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
});
