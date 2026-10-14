// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccountId } from './analytics-opt-out-user.mjs';

test('takes exactly one account id', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(parseAccountId([id]), id);
  assert.throws(() => parseAccountId([]), /one account id/);
  assert.throws(() => parseAccountId([id, id]), /one account id/);
  assert.throws(() => parseAccountId(['user-1']), /user-1/);
});
