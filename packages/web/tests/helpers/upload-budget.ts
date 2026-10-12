// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many upload tickets each smoke account has asked for lately, so a case
 * that hands the canvas a batch of files waits for room rather than running
 * into the per-account limit.
 *
 * The server mints one ticket per file and allows `upload-ticket` in
 * config/rate-limits.yaml per account per window; a case over the limit gets a
 * 429 for the files past it, and those nodes never fill. The record is a file,
 * because Playwright replaces its worker process after a failing case and the
 * server's window outlives it. Each worker slot has a file of its own: its
 * accounts are its own, and no other process writes there.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Page } from 'playwright/test';
import { parse } from 'yaml';

import type { Account } from './project';
import { slot } from './slot';

/** Tickets left for the cases that upload a file or two without asking first. */
const HEADROOM = 5;

/** The per-account limit and its window, as the server reads them. */
const LIMIT = ((): { max: number; windowMs: number } => {
  const file = resolve(__dirname, '../../../../config/rate-limits.yaml');
  const entry = (parse(readFileSync(file, 'utf8')) as Record<string, { max: number; window_seconds: number }>)[
    'upload-ticket'
  ];
  if (entry === undefined) throw new Error('config/rate-limits.yaml has no upload-ticket entry');
  return { max: entry.max, windowMs: entry.window_seconds * 1000 };
})();

/**
 * Where one worker slot's tickets are recorded, beside the suite's sign-ins.
 * @param at - Which worker slot.
 * @returns The path, relative to the web package.
 */
function ticketsFile(at: number): string {
  return `playwright/.auth/upload-tickets-${String(at)}.json`;
}

/**
 * When each account of a slot asked for its tickets inside the window, oldest first.
 * @param at - Which worker slot.
 * @returns The record, empty when there is none yet.
 * @throws {Error} When the file is there and cannot be read as a record.
 */
function readAsked(at: number): Record<Account, number[]> {
  const since = Date.now() - LIMIT.windowMs;
  let stored: Partial<Record<Account, number[]>> = {};
  try {
    stored = JSON.parse(readFileSync(ticketsFile(at), 'utf8')) as Partial<Record<Account, number[]>>;
  } catch (err) {
    // No file yet means no ticket has been recorded.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return {
    A: (stored.A ?? []).filter((at) => at > since),
    B: (stored.B ?? []).filter((at) => at > since),
  };
}

/**
 * Write a slot's record back.
 * @param at - Which worker slot.
 * @param asked - Each account's ticket times.
 */
function writeAsked(at: number, asked: Record<Account, number[]>): void {
  const file = ticketsFile(at);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(asked), 'utf8');
}

/** The pages already being watched. */
const watched = new WeakSet<Page>();

/**
 * Record every upload ticket a page asks for, against the account it is
 * signed in as.
 * The slot is read when watching starts: the request listener can also fire
 * between cases (on a page opened in `beforeAll`), when there is no running
 * case to read it from.
 * @param page - A page opened on the account's Project.
 * @param account - The account it is signed in as.
 * @param at - Which worker slot; the running case's when omitted.
 */
export function watchUploadTickets(page: Page, account: Account, at: number = slot()): void {
  if (watched.has(page)) return;
  watched.add(page);
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/v1/assets/upload-ticket')) {
      const asked = readAsked(at);
      writeAsked(at, { ...asked, [account]: [...asked[account], Date.now()] });
    }
  });
}

/**
 * Wait until the account can ask for `files` more tickets inside the window.
 * @param files - How many files are about to be handed over.
 * @param account - Whose tickets they will be.
 * @param at - Which worker slot; the running case's when omitted.
 * @throws {Error} When the batch alone is over the limit.
 */
export async function roomForUploads(
  files: number,
  account: Account = 'A',
  at: number = slot(),
): Promise<void> {
  const room = LIMIT.max - HEADROOM;
  if (files > room) throw new Error(`${String(files)} files is over the ${String(room)} a window allows`);
  for (;;) {
    const recent = readAsked(at)[account];
    if (recent.length + files <= room) return;
    const freesAt = (recent[recent.length + files - room - 1] ?? Date.now()) + LIMIT.windowMs;
    await new Promise((resolve) => setTimeout(resolve, Math.max(freesAt - Date.now(), 50)));
  }
}
