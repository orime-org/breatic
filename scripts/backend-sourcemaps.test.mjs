// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verify, packages } from './backend-sourcemaps.mjs';

test('every backend chunk must retain its matching injected map', () => {
  const root = mkdtempSync(join(tmpdir(), 'backend-maps-'));
  const id = 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12);
  try {
    for (const name of packages) {
      const dir = join(root, 'packages', name, 'dist');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.js'), `export {};\n//# debugId=${id}`);
      writeFileSync(join(dir, 'index.js.map'), JSON.stringify({ version: 3, debugId: id }));
    }
    assert.equal(verify(root), 6);
    writeFileSync(join(root, 'packages/core/dist/index.js.map'), JSON.stringify({ version: 3, debugId: id.replace('a', 'b') }));
    assert.throws(() => verify(root), /Debug ID mismatch/);
    rmSync(join(root, 'packages/core/dist/index.js.map'));
    assert.throws(() => verify(root), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed workspace chunks must match the injected originals', () => {
  const root = mkdtempSync(join(tmpdir(), 'installed-backend-maps-'));
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  try {
    for (const name of packages) {
      const dir = join(root, 'packages', name, 'dist');
      mkdirSync(dir, { recursive: true });
      for (const file of ['index.js', 'chunk.js']) {
        writeFileSync(join(dir, file), `export {};\n//# debugId=${id}`);
        writeFileSync(join(dir, `${file}.map`), JSON.stringify({ version: 3, debugId: id }));
      }
    }
    for (const name of ['server', 'worker', 'collab']) {
      writeFileSync(join(root, 'packages', name, 'package.json'), '{}');
      for (const dependency of name === 'collab' ? ['shared', 'core'] : ['shared', 'core', 'domain']) {
        const dir = join(root, 'packages', name, 'node_modules', '@breatic', dependency);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': { import: './dist/index.js' } } }));
        cpSync(join(root, 'packages', dependency, 'dist'), join(dir, 'dist'), { recursive: true });
      }
    }
    assert.equal(verify(root, true), 12);
    writeFileSync(join(root, 'packages/server/node_modules/@breatic/core/dist/chunk.js'), 'stale code');
    assert.throws(() => verify(root, true), /server\/core\/chunk.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
