// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amplitudeKeys, deletionRequests, parseAccountIds } from './analytics-delete-users.mjs';

test('asks Amplitude to delete the accounts with the project key and secret', () => {
  const [request] = deletionRequests(['user-1', 'user-2'], { apiKey: 'key', secretKey: 'secret' });
  assert.equal(request.url, 'https://amplitude.com/api/2/deletions/users');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, `Basic ${Buffer.from('key:secret').toString('base64')}`);
  assert.deepEqual(JSON.parse(request.init.body), {
    user_ids: ['user-1', 'user-2'],
    requester: 'breatic-account-deletion',
    ignore_invalid_id: true,
  });
});

test('splits more than 100 accounts into requests of 100', () => {
  const ids = Array.from({ length: 205 }, (_, i) => `user-${i}`);
  const sizes = deletionRequests(ids, { apiKey: 'key', secretKey: 'secret' }).map(
    (request) => JSON.parse(request.init.body).user_ids.length,
  );
  assert.deepEqual(sizes, [100, 100, 5]);
});

test('refuses to run without both keys or without an account', () => {
  assert.throws(() => deletionRequests(['user-1'], { apiKey: '', secretKey: 'secret' }), /AMPLITUDE_API_KEY/);
  assert.throws(() => deletionRequests(['user-1'], { apiKey: 'key', secretKey: '' }), /AMPLITUDE_SECRET_KEY/);
  assert.throws(() => deletionRequests([], { apiKey: 'key', secretKey: 'secret' }), /account id/);
});

test('takes account ids and refuses anything that is not one', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(parseAccountIds([id, id.toUpperCase()]), [id]);
  assert.throws(() => parseAccountIds([]), /account id/);
  assert.throws(() => parseAccountIds([id, 'user-1']), /user-1/);
});

test('skips Amplitude when the deployment sends no product analytics, and needs the secret when it does', () => {
  assert.equal(amplitudeKeys({ AMPLITUDE_API_KEY: '' }), null);
  assert.equal(amplitudeKeys({}), null);
  assert.deepEqual(amplitudeKeys({ AMPLITUDE_API_KEY: ' key ', AMPLITUDE_SECRET_KEY: 'secret' }), {
    apiKey: 'key',
    secretKey: 'secret',
  });
  assert.throws(() => amplitudeKeys({ AMPLITUDE_API_KEY: 'key' }), /AMPLITUDE_SECRET_KEY/);
});
