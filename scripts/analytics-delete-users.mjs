// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Deletes accounts' product analytics events from Amplitude, for an account
 * deletion request (inner#1442). Run it with the ids of the deleted accounts
 * (`users.id`), on a deployment that sends product analytics.
 *
 * Usage, from the repository root:
 *   AMPLITUDE_SECRET_KEY=... pnpm analytics:delete-users <user id> [<user id> ...]
 *
 * `AMPLITUDE_API_KEY` comes from `.env`; the secret is the project's secret key
 * in Amplitude's project settings, passed only for this run. Amplitude deletes
 * within 30 days of the request and reports the scheduled day.
 */

import { pathToFileURL } from 'node:url';

const ENDPOINT = 'https://amplitude.com/api/2/deletions/users';
// Amplitude takes up to 100 ids per request and one request per second.
const BATCH = 100;
const PAUSE_MS = 1100;

/**
 * The deletion requests for a list of accounts.
 * @param {string[]} userIds - The accounts' `users.id`.
 * @param {{ apiKey: string, secretKey: string }} keys - The Amplitude project's keys.
 * @returns {{ url: string, init: { method: string, headers: Record<string, string>, body: string } }[]} One request per 100 accounts.
 */
export function deletionRequests(userIds, keys) {
  if (!keys.apiKey) throw new Error('AMPLITUDE_API_KEY is not set');
  if (!keys.secretKey) throw new Error('AMPLITUDE_SECRET_KEY is not set');
  if (userIds.length === 0) throw new Error('Pass at least one account id');
  const authorization = `Basic ${Buffer.from(`${keys.apiKey}:${keys.secretKey}`).toString('base64')}`;
  const requests = [];
  for (let i = 0; i < userIds.length; i += BATCH) {
    requests.push({
      url: ENDPOINT,
      init: {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_ids: userIds.slice(i, i + BATCH),
          requester: 'breatic-account-deletion',
          ignore_invalid_id: true,
        }),
      },
    });
  }
  return requests;
}

/**
 * Send the requests one per second and print Amplitude's answers.
 * @param {string[]} userIds - The accounts.
 */
async function main(userIds) {
  const { findRoot, loadEnv } = await import('./load-env.ts');
  loadEnv(findRoot());
  const requests = deletionRequests(userIds, {
    apiKey: (process.env.AMPLITUDE_API_KEY ?? '').trim(),
    secretKey: (process.env.AMPLITUDE_SECRET_KEY ?? '').trim(),
  });
  for (const [index, request] of requests.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    const response = await fetch(request.url, request.init);
    const body = await response.text();
    if (!response.ok) throw new Error(`Amplitude answered ${response.status}: ${body}`);
    console.log(body);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
