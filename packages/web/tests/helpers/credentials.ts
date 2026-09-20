// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two accounts a run owns, which it makes for itself.
 *
 * Nothing here is configured and nothing is checked in. Setup generates a
 * pair, registers it against the local stack, and writes it beside the
 * browser state in `playwright/.auth`, which `.gitignore` already covers on
 * the same reasoning Playwright gives for the state files: *We strongly
 * discourage checking them into private or public repositories.*
 *
 * A pair written into the repository would travel with it. Pointed at any
 * other deployment, the same code would then try to register or sign in that
 * account there — which is why the pair is per machine and the addresses are
 * under `.test`, the domain RFC 2606 reserves for exactly this and which can
 * never resolve to a real mailbox.
 *
 * Two accounts, because one case asks what one account's browser storage does
 * to the other's: changing who is signed in is the thing under test there.
 * The cases with two live connections use two contexts of the first account.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Account } from './project';

/** Where the pairs are recorded, beside the browser state files. */
export const ACCOUNTS_FILE = 'playwright/.auth/accounts.json';

/** An account's sign-in pair. */
export interface Credentials {
  email: string;
  password: string;
}

/** What the file holds: whichever accounts have been made so far. */
type Recorded = Partial<Record<Account, Credentials>>;

/**
 * The pairs recorded so far.
 * @param path - The file to read; the default is the one setup writes.
 * @returns What it holds, or nothing when no run has made an account yet.
 */
export function readAccounts(path: string = ACCOUNTS_FILE): Recorded {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Recorded;
}

/**
 * Record one account's pair, keeping whatever the other account has.
 * @param account - Which account this is.
 * @param pair - Its address and password.
 * @param path - The file to write; the default is the one setup writes.
 */
export function rememberAccount(
  account: Account,
  pair: Credentials,
  path: string = ACCOUNTS_FILE,
): void {
  const held = readAccounts(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...held, [account]: pair }, null, 2), 'utf8');
}

/**
 * A pair no one has used before.
 *
 * The address carries the account letter so a person reading the dev database
 * can tell the two apart, and enough randomness that a run which lost its
 * record does not collide with the account it forgot.
 * @param account - Which account this will be.
 * @returns The new pair.
 */
export function newCredentials(account: Account): Credentials {
  const mark = randomBytes(6).toString('hex');
  return {
    email: `smoke-${account.toLowerCase()}-${mark}@breatic.test`,
    // Longer than the eight characters `registerSchema` asks for.
    password: randomBytes(18).toString('base64url'),
  };
}

/**
 * The address and password for one account.
 * @param account - Which account to read.
 * @returns Both values.
 * @throws {Error} When no run has made this account yet.
 */
export function credentialsFor(account: Account): Credentials {
  const pair = readAccounts()[account];
  if (pair === undefined) {
    throw new Error(
      `No account ${account} has been made yet. Setup makes both and records them in ${ACCOUNTS_FILE}; run the suite through \`pnpm --filter @breatic/web test:smoke\` so it runs first.`,
    );
  }
  return pair;
}
