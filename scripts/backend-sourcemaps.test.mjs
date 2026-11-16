// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verify, backendPackages, services } from './backend-sourcemaps.mjs';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** Each service of the fixture and the workspace libraries its package.json depends on. */
const graph = { server: ['shared', 'core', 'domain', 'provider'], worker: ['shared', 'core', 'domain', 'provider'], collab: ['shared', 'core'] };

/** A backend tree whose services declare `graph`, every package's dist mapped with `id`. */
function fixture(prefix, files = ['index.js']) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [name, deps] of Object.entries(graph)) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    const dependencies = Object.fromEntries(deps.map(dep => [`@breatic/${dep}`, 'workspace:*']));
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ dependencies, devDependencies: { '@breatic/integration-tests': 'workspace:*' } }));
  }
  for (const name of backendPackages(root)) {
    const dir = join(root, 'packages', name, 'dist');
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      writeFileSync(join(dir, file), `export {};\n//# debugId=${id}`);
      writeFileSync(join(dir, `${file}.map`), JSON.stringify({ version: 3, debugId: id }));
    }
  }
  return root;
}

test('the backend packages are the services and the workspace libraries their dependencies name', () => {
  const root = fixture('backend-graph-');
  try {
    assert.deepEqual(services, ['server', 'worker', 'collab']);
    assert.deepEqual(backendPackages(root), ['server', 'worker', 'collab', 'core', 'domain', 'provider', 'shared']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every backend chunk must retain its matching injected map', () => {
  const root = fixture('backend-maps-');
  try {
    assert.equal(verify(root), 7);
    writeFileSync(join(root, 'packages/core/dist/index.js.map'), JSON.stringify({ version: 3, debugId: id.replace('a', 'b') }));
    assert.throws(() => verify(root), /Debug ID mismatch/);
    rmSync(join(root, 'packages/core/dist/index.js.map'));
    assert.throws(() => verify(root), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a library a service depends on must have been built and injected too', () => {
  const root = fixture('backend-missing-lib-');
  try {
    rmSync(join(root, 'packages/provider/dist'), { recursive: true });
    assert.throws(() => verify(root), /ENOENT.*provider/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed workspace chunks must match the injected originals', () => {
  const root = fixture('installed-backend-maps-', ['index.js', 'chunk.js']);
  try {
    for (const [name, deps] of Object.entries(graph)) {
      for (const dependency of deps) {
        const dir = join(root, 'packages', name, 'node_modules', '@breatic', dependency);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': { import: './dist/index.js' } } }));
        cpSync(join(root, 'packages', dependency, 'dist'), join(dir, 'dist'), { recursive: true });
      }
    }
    assert.equal(verify(root, true), 14);
    writeFileSync(join(root, 'packages/worker/node_modules/@breatic/provider/dist/chunk.js'), 'stale code');
    assert.throws(() => verify(root, true), /worker\/provider\/chunk.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
