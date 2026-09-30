// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInfo, releaseManifest } from './release.mjs';
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
  assert.throws(() => releaseManifest('0.2.0', sha, 'orime-org/breatic', backend, web));
});
