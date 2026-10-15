// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Switches ads off for an account whose holder asked us by email or support
 * (inner#1442 design §4.4.6, §4.14). The account's ad switch closes with
 * source `request`, unless it is already closed; it stays closed until the
 * account holder turns ads back on, and stops ad conversions for the account
 * on every browser.
 *
 * Usage, from the repository root:
 *   pnpm analytics:opt-out-user <user id>
 */

import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one account id on the command line.
 * @param {string[]} args - The arguments.
 * @returns {string} The id, lower-cased.
 */
export function parseAccountId(args) {
  if (args.length !== 1) throw new Error('Pass one account id');
  if (!UUID.test(args[0])) throw new Error(`Not an account id: ${args[0]}`);
  return args[0].toLowerCase();
}

/**
 * Switch ads off for the account.
 * @param {string[]} args - The command line arguments.
 */
async function main(args) {
  const userId = parseAccountId(args);
  const { findRoot, loadEnv } = await import('./load-env.ts');
  loadEnv(findRoot());
  const core = await import('../packages/core/dist/index.js');
  core.initCore(process.env);
  try {
    if ((await core.setAdsSharing(userId, { allowed: false, source: 'request' })) === null) {
      throw new Error(`No account ${userId}, or it is deleted`);
    }
  } finally {
    await core.closeDb();
  }
  console.log(`Switched ads off for ${userId}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
