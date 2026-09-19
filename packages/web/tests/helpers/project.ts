// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The Projects setup built for this run.
 *
 * Every spec used to find a Project by clicking the first `/project/` link on
 * the studio page, or by reading a URL somebody had written into the
 * environment. Both take whatever happens to be there, so a run on a fresh
 * account reports a product defect when what it actually met was an account
 * with nothing in it. Worse, everything landed in the same long-lived
 * Project: one measured account had 826 Spaces in it.
 *
 * Setup creates them instead, writes down what it made, and teardown removes
 * them. A spec asks for the one it was given.
 */
import { readFileSync } from 'node:fs';

/** Which account a Project belongs to. */
export type Account = 'A' | 'B';

/** The Project ids each account owns for this run, in the order made. */
export type PreparedProjects = Readonly<Record<Account, readonly string[]>>;

/** Where setup leaves the file, relative to the web package. */
export const PROJECTS_FILE = 'playwright/.auth/projects.json';

/**
 * Where each account's signed-in browser state is kept.
 *
 * The config hands account A's to every project, so a spec that takes its
 * page from the fixtures is signed in already. A spec that builds its own
 * context with `browser.newContext()` gets none of that — the option is
 * applied to the fixture, not to the browser — so it passes one of these.
 */
export const STATE_FILE: Readonly<Record<Account, string>> = {
  A: 'playwright/.auth/a.json',
  B: 'playwright/.auth/b.json',
};

/**
 * Answers whether a parsed value has the shape setup writes.
 * @param value - Whatever `JSON.parse` returned.
 * @returns Whether both accounts carry a list of ids.
 */
function hasTheShape(value: unknown): value is PreparedProjects {
  if (typeof value !== 'object' || value === null) return false;
  const holder = value as Record<string, unknown>;
  return (['A', 'B'] as const).every(
    (account) =>
      Array.isArray(holder[account]) &&
      (holder[account] as unknown[]).every((id) => typeof id === 'string'),
  );
}

/** What the last read produced, so dozens of specs share one file read. */
let held: PreparedProjects | null = null;

/**
 * Drops the held copy, so the next read goes back to the file.
 *
 * Only this module's own tests need it: a run reads one file that setup
 * wrote before any spec started, and it does not change under them.
 */
export function forgetProjects(): void {
  held = null;
}

/**
 * Reads what setup prepared.
 *
 * A missing file means setup did not run, and saying so here is the whole
 * point: the alternative is every spec failing at its first navigation with a
 * 404, which reads as a product defect rather than as a run with no opening.
 * @param path - Where the file is, for tests that write their own.
 * @returns The Project ids by account.
 * @throws {Error} When the file is absent, unreadable, or not that shape.
 */
export function readProjects(path: string = PROJECTS_FILE): PreparedProjects {
  if (held !== null) return held;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `No Projects at ${path}: setup did not run, or did not finish. Run the suite through its own command so the setup project goes first.`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (!hasTheShape(parsed)) {
    throw new Error(
      `${path} is not the shape setup writes ({ A: string[], B: string[] }). Delete it and run setup again.`,
    );
  }
  held = parsed;
  return parsed;
}

/**
 * The path a spec navigates to for one of the Projects setup made.
 *
 * This is what a spec calls. The two-argument forms above take the parsed
 * file so they can be tested against one a test wrote itself.
 * @param account - Which account owns it; most specs want 'A'.
 * @param index - Which of that account's Projects. A has two, B has one.
 * @returns A path ready for `page.goto`.
 * @throws {Error} When setup did not run, or made no Project there.
 */
export function smokeProjectUrl(account: Account = 'A', index = 0): string {
  return projectUrl(readProjects(), account, index);
}

/**
 * The id of one of the Projects setup made.
 * @param account - Which account owns it; most specs want 'A'.
 * @param index - Which of that account's Projects. A has two, B has one.
 * @returns The Project id.
 * @throws {Error} When setup did not run, or made no Project there.
 */
export function smokeProjectId(account: Account = 'A', index = 0): string {
  return projectId(readProjects(), account, index);
}

/** The least a page has to offer for this module to navigate it. */
interface Navigable {
  goto: (url: string) => Promise<unknown>;
}

/**
 * Opens one of the Projects setup made.
 *
 * Specs used to reach one of two ways, and both took whatever happened to be
 * there: clicking the first link on the studio page, or reading a URL out of
 * the environment. This goes straight to a Project this run created, which is
 * one navigation instead of a page load, a locator, a click and a wait.
 * @param page - The page to navigate.
 * @param account - Which account owns it; most specs want 'A'.
 * @param index - Which of that account's Projects. A has two, B has one.
 * @throws {Error} When setup did not run, or made no Project there.
 */
export async function openSmokeProject(
  page: Navigable,
  account: Account = 'A',
  index = 0,
): Promise<void> {
  await page.goto(smokeProjectUrl(account, index));
}

/**
 * Takes the id of one prepared Project.
 * @param prepared - What setup made.
 * @param account - Which account owns it.
 * @param index - Which of that account's Projects, in the order made.
 * @returns The Project id.
 * @throws {Error} When that account has no Project at that place.
 */
export function projectId(
  prepared: PreparedProjects,
  account: Account,
  index: number,
): string {
  const found = prepared[account][index];
  if (found === undefined) {
    throw new Error(
      `Account ${account} has ${prepared[account].length} project(s), so there is none at ${index}. Setup decides how many each account gets.`,
    );
  }
  return found;
}

/**
 * Builds the path a spec navigates to.
 * @param prepared - What setup made.
 * @param account - Which account owns it.
 * @param index - Which of that account's Projects, in the order made.
 * @returns A path ready for `page.goto`.
 * @throws {Error} When that account has no Project at that place.
 */
export function projectUrl(
  prepared: PreparedProjects,
  account: Account,
  index: number,
): string {
  return `/project/${projectId(prepared, account, index)}`;
}
