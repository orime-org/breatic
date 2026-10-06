// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const packages = ['server', 'worker', 'collab', 'core', 'domain', 'shared'];

/** Verify emitted code and maps, and optionally their installed workspace copies. */
export function verify(root, installed = false) {
  let count = 0;
  for (const name of packages) {
    const folder = join(root, 'packages', name, 'dist');
    const files = readdirSync(folder, { recursive: true }).filter(file => file.endsWith('.js'));
    assert(files.length > 0, `No JavaScript for ${name}`);
    for (const file of files) {
      const code = readFileSync(join(folder, file), 'utf8');
      const map = JSON.parse(readFileSync(join(folder, `${file}.map`), 'utf8'));
      assert.match(map.debugId ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      assert(code.includes(`//# debugId=${map.debugId}`), `Debug ID mismatch: ${name}/${file}`);
      assert.equal(map.version, 3);
      count++;
    }
  }
  if (installed) {
    for (const name of ['server', 'worker', 'collab']) {
      const require = createRequire(join(root, 'packages', name, 'package.json'));
      for (const dependency of name === 'collab' ? ['shared', 'core'] : ['shared', 'core', 'domain']) {
        const entry = require.resolve(`@breatic/${dependency}`);
        const original = join(root, 'packages', dependency, 'dist');
        for (const file of readdirSync(original, { recursive: true }).filter(file => /\.js(?:\.map)?$/.test(file))) {
          assert.deepEqual(readFileSync(join(dirname(entry), file)), readFileSync(join(original, file)), `${name}/${dependency}/${file}`);
        }
      }
    }
  }
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Verified ${verify(resolve(process.argv[2] ?? '.'), process.argv.includes('--installed'))} mapped backend files`);
}
