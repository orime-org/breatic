// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The accounts a run owns, a pair per worker slot, which it makes for itself.
 *
 * Nothing here is configured and nothing is checked in. Setup generates a
 * pair for each worker slot, registers it against the local stack, and
 * writes it beside the browser state in `playwright/.auth`, which `.gitignore` already covers on
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
import { slot } from './slot';

/** Where the pairs are recorded, beside the browser state files. */
export const ACCOUNTS_FILE = 'playwright/.auth/accounts.json';

/** An account's sign-in pair. */
export interface Credentials {
  email: string;
  password: string;
}

/** What one worker slot holds: whichever of its accounts have been made so far. */
type SlotAccounts = Partial<Record<Account, Credentials>>;

/** What the file holds, by worker slot (`"0"`, `"1"`, …). */
type Recorded = Partial<Record<string, SlotAccounts>>;

/**
 * The pairs recorded so far.
 *
 * The file an earlier suite wrote held one pair at its top level. Read as a
 * slot file it has no slot 0, and setup would register a fresh pair and leave
 * the old accounts behind with their Projects and credits, so that shape is
 * refused rather than read.
 * @param path - The file to read; the default is the one setup writes.
 * @returns What it holds, or nothing when no run has made an account yet.
 * @throws {Error} When the file holds the one-pair shape.
 */
export function readAccounts(path: string = ACCOUNTS_FILE): Recorded {
  if (!existsSync(path)) return {};
  const held = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if ('A' in held || 'B' in held) {
    throw new Error(
      `${path} holds one pair at its top level, the shape written before each worker had its own. Move it under "0" ({ "0": { "A": …, "B": … } }) so slot 0 keeps those accounts. a.json, b.json and upload-tickets.json are no longer read.`,
    );
  }
  return held as Recorded;
}

/**
 * Record one account's pair, keeping everything else in the file.
 * @param at - Which worker slot it belongs to.
 * @param account - Which account of the pair.
 * @param pair - Its address and password.
 * @param path - The file to write; the default is the one setup writes.
 */
export function rememberAccount(
  at: number,
  account: Account,
  pair: Credentials,
  path: string = ACCOUNTS_FILE,
): void {
  const held = readAccounts(path);
  const slotKey = String(at);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...held, [slotKey]: { ...held[slotKey], [account]: pair } }, null, 2),
    'utf8',
  );
}

/**
 * A short random mark, so names made in the same second still differ.
 * @returns Twelve hex digits.
 */
function mark(): string {
  return randomBytes(6).toString('hex');
}

/**
 * A pair no one has used before.
 *
 * The address carries the account letter and the slot so a person reading
 * the dev database can tell the pairs apart, and enough randomness that a run
 * which lost its record does not collide with the account it forgot.
 * @param account - Which account this will be.
 * @param at - Which worker slot it is for.
 * @returns The new pair.
 */
export function newCredentials(account: Account, at: number): Credentials {
  return {
    email: `smoke-${account.toLowerCase()}${String(at)}-${mark()}@breatic.test`,
    // Longer than the eight characters `registerSchema` asks for.
    password: randomBytes(18).toString('base64url'),
  };
}

/**
 * The slug a new account's personal studio is created under.
 *
 * Studio slugs are unique across the whole database, and setup creates the
 * studios of several slots one after another, so a slug made from the second
 * alone would collide between two slots in the same second.
 * @param account - Which account of the pair.
 * @param at - Which worker slot.
 * @returns The slug.
 */
export function personalStudioSlug(account: Account, at: number): string {
  return `smoke-${account.toLowerCase()}${String(at)}-${mark()}`;
}

/**
 * The address and password for one account of the running case's slot.
 * @param account - Which account to read.
 * @returns Both values.
 * @throws {Error} When no run has made this account for this slot yet, or
 *   when called outside a running case.
 */
export function credentialsFor(account: Account): Credentials {
  const at = slot();
  const pair = readAccounts()[String(at)]?.[account];
  if (pair === undefined) {
    throw new Error(
      `No account ${account} has been made for worker slot ${String(at)} yet. Setup makes one pair per slot and records them in ${ACCOUNTS_FILE}; run the suite through \`pnpm --filter @breatic/web test:smoke\` so it runs first.`,
    );
  }
  return pair;
}
