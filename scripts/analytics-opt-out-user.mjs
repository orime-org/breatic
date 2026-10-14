// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Records an ads opt-out a person asked us for by email or support, on their
 * account (inner#1442 design §4.4.6, §4.14). The receipt is an ads refusal
 * with source `request`, timed now and under the current policy revision; it
 * never lapses, and it stops ad conversions for the account on every browser.
 *
 * Usage, from the repository root:
 *   pnpm analytics:opt-out-user <user id>
 */

import { randomUUID } from 'node:crypto';
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
 * Record the opt-out.
 * @param {string[]} args - The command line arguments.
 */
async function main(args) {
  const userId = parseAccountId(args);
  const { findRoot, loadEnv } = await import('./load-env.ts');
  loadEnv(findRoot());
  const core = await import('../packages/core/dist/index.js');
  const { CONSENT_REVISION } = await import('../packages/shared/dist/index.js');
  core.initCore(process.env);
  try {
    if (!(await core.recordOptOutRequest(userId, randomUUID(), CONSENT_REVISION))) {
      throw new Error(`No account ${userId}, or it is deleted`);
    }
  } finally {
    await core.closeDb();
  }
  console.log(`Recorded the ads opt-out for ${userId}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
