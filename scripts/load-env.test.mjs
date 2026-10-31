// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './load-env.ts';

test('reads an empty value followed by a comment as empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'load-env-'));
  writeFileSync(join(root, '.env'), 'LOAD_ENV_EMPTY=        # explained here\nLOAD_ENV_SET=value # explained\n');
  delete process.env.LOAD_ENV_EMPTY;
  delete process.env.LOAD_ENV_SET;
  loadEnv(root);
  assert.equal(process.env.LOAD_ENV_EMPTY, '');
  assert.equal(process.env.LOAD_ENV_SET, 'value');
});
