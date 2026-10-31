// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Erases what deleted accounts left in product analytics, for an account
 * deletion request (inner#1442 design §4.14). Soft-delete the accounts first,
 * then run it with their ids (`users.id`). It refuses any account that is not
 * soft-deleted and lists them.
 *
 * It first removes, in this database, the accounts' latest reported consent
 * and the consent kept on their orders, upload tickets and ad uploads.
 * Then, on a deployment that sends product analytics (`AMPLITUDE_API_KEY`
 * set), it asks Amplitude to delete their events; otherwise it says so and
 * stops. A failure at Amplitude leaves the database part done; run it again.
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The account ids on the command line.
 * @param {string[]} args - The arguments.
 * @returns {string[]} The ids, lower-cased and without repeats.
 */
export function parseAccountIds(args) {
  if (args.length === 0) throw new Error('Pass at least one account id');
  const bad = args.filter((arg) => !UUID.test(arg));
  if (bad.length > 0) throw new Error(`Not an account id: ${bad.join(', ')}`);
  return [...new Set(args.map((arg) => arg.toLowerCase()))];
}

/**
 * The Amplitude keys to delete with.
 * @param {Record<string, string | undefined>} env - The environment.
 * @returns {{ apiKey: string, secretKey: string } | null} The keys, or null on a deployment that sends no product analytics.
 */
export function amplitudeKeys(env) {
  const apiKey = (env.AMPLITUDE_API_KEY ?? '').trim();
  if (apiKey === '') return null;
  const secretKey = (env.AMPLITUDE_SECRET_KEY ?? '').trim();
  if (secretKey === '') throw new Error('AMPLITUDE_SECRET_KEY is not set');
  return { apiKey, secretKey };
}

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
 * Erase the accounts' consent records, then ask Amplitude to delete their
 * events, one request per second, printing its answers. The database part is
 * done first, so a failure at Amplitude leaves it in place.
 * @param {string[]} userIds - The accounts' `users.id`.
 * @param {{ apiKey: string, secretKey: string } | null} keys - The Amplitude keys, or null without product analytics.
 * @param {{ erase: (ids: string[]) => Promise<{ notDeleted: string[] }>, send: typeof fetch, pauseMs?: number }} deps - The database erase and the HTTP client.
 */
export async function run(userIds, keys, { erase, send, pauseMs = PAUSE_MS }) {
  const { notDeleted } = await erase(userIds);
  if (notDeleted.length > 0) {
    throw new Error(`Soft-delete these accounts first, nothing was changed: ${notDeleted.join(', ')}`);
  }
  console.log(`Erased consent records of ${userIds.length} account(s)`);
  if (keys === null) {
    console.log('AMPLITUDE_API_KEY is not set, so there are no Amplitude events to delete');
    return;
  }
  const requests = deletionRequests(userIds, keys);
  for (const [index, request] of requests.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const response = await send(request.url, request.init);
    const body = await response.text();
    if (!response.ok) throw new Error(`Amplitude answered ${response.status}: ${body}`);
    console.log(body);
  }
}

/**
 * Load the environment and the database, then {@link run}.
 * @param {string[]} args - The command line arguments.
 */
async function main(args) {
  const userIds = parseAccountIds(args);
  const { findRoot, loadEnv } = await import('./load-env.ts');
  loadEnv(findRoot());
  const keys = amplitudeKeys(process.env);
  const core = await import('../packages/core/dist/index.js');
  core.initCore(process.env);
  const erase = async (ids) => {
    try {
      return await core.eraseAccountAnalytics(ids);
    } finally {
      await core.closeDb();
    }
  };
  await run(userIds, keys, { erase, send: fetch });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
