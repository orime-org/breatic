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
 * Setup creates them instead, writes down what it made, and teardown archives
 * them. A spec asks for the one it was given. Projects are archived because
 * the product has no way to delete one; an archived Project leaves the studio's
 * live list and stops counting against its limit.
 */
import { readFileSync } from 'node:fs';

import type { Page } from 'playwright/test';

import { slot } from './slot';
import { watchUploadTickets } from './upload-budget';

/** Which account a Project belongs to. */
export type Account = 'A' | 'B';

/** The Project ids each account of one worker slot owns for this run, in the order made. */
export type PreparedProjects = Readonly<Record<Account, readonly string[]>>;

/** What setup prepared, by worker slot (`"0"`, `"1"`, …). */
export type PreparedSlots = Readonly<Record<string, PreparedProjects>>;

/** How the slug of every Project setup makes begins, so later runs can recognise them. */
export const MADE_BY_SMOKE = 'smoke-run';

/** Where setup leaves the file, relative to the web package. */
export const PROJECTS_FILE = 'playwright/.auth/projects.json';

/**
 * Answers whether a parsed value is one slot's projects.
 * @param value - One entry of the parsed file.
 * @returns Whether both accounts carry a list of ids.
 */
function isSlot(value: unknown): value is PreparedProjects {
  if (typeof value !== 'object' || value === null) return false;
  const holder = value as Record<string, unknown>;
  return (['A', 'B'] as const).every(
    (account) =>
      Array.isArray(holder[account]) &&
      (holder[account] as unknown[]).every((id) => typeof id === 'string'),
  );
}

/**
 * Answers whether a parsed value has the shape setup writes.
 * @param value - Whatever `JSON.parse` returned.
 * @returns Whether every key is a slot number holding one slot's projects.
 */
function hasTheShape(value: unknown): value is PreparedSlots {
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).every(([key, entry]) => /^\d+$/.test(key) && isSlot(entry));
}

/**
 * Reads what setup prepared.
 *
 * A missing file means setup did not run, and saying so here is the whole
 * point: the alternative is every spec failing at its first navigation with a
 * 404, which reads as a product defect rather than as a run with no opening.
 * @param path - Where the file is, for tests that write their own.
 * @returns The Project ids by slot and account.
 * @throws {Error} When the file is absent, unreadable, or not that shape.
 */
export function readProjects(path: string = PROJECTS_FILE): PreparedSlots {
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
      `${path} is not the shape setup writes ({ "0": { A: string[], B: string[] }, … }). Delete it and run setup again.`,
    );
  }
  return parsed;
}

/**
 * The path a spec navigates to for one of the Projects setup made for the
 * running case's worker slot.
 *
 * This is what a spec calls. The forms below take the parsed file and the
 * slot so they can be tested against one a test wrote itself.
 * @param account - Which account owns it; most specs want 'A'.
 * @param index - Which of that account's Projects. A has two, B has one.
 * @returns A path ready for `page.goto`.
 * @throws {Error} When setup did not run, made no Project there, or this is
 *   called outside a running case.
 */
export function smokeProjectUrl(account: Account = 'A', index = 0): string {
  return projectUrl(readProjects(), slot(), account, index);
}

/**
 * The id of one of the Projects setup made for the running case's worker slot.
 * @param account - Which account owns it; most specs want 'A'.
 * @param index - Which of that account's Projects. A has two, B has one.
 * @returns The Project id.
 * @throws {Error} When setup did not run, made no Project there, or this is
 *   called outside a running case.
 */
export function smokeProjectId(account: Account = 'A', index = 0): string {
  return projectId(readProjects(), slot(), account, index);
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
  page: Page,
  account: Account = 'A',
  index = 0,
): Promise<void> {
  // Pages that upload inside a Project are opened here, so this is where their
  // tickets start being counted (helpers/upload-budget.ts); the few that upload
  // elsewhere fit in its HEADROOM.
  watchUploadTickets(page, account, slot());
  await page.goto(smokeProjectUrl(account, index));
}

/**
 * Takes the id of one prepared Project.
 * @param prepared - What setup made.
 * @param at - Which worker slot.
 * @param account - Which account of that slot owns it.
 * @param index - Which of that account's Projects, in the order made.
 * @returns The Project id.
 * @throws {Error} When setup prepared nothing for that slot, or that account
 *   has no Project at that place.
 */
export function projectId(
  prepared: PreparedSlots,
  at: number,
  account: Account,
  index: number,
): string {
  const ours = prepared[String(at)];
  if (ours === undefined) {
    throw new Error(
      `Setup prepared nothing for worker slot ${String(at)}. It prepares one slot per worker of the run it starts; a run with more workers needs setup to run again.`,
    );
  }
  const found = ours[account][index];
  if (found === undefined) {
    throw new Error(
      `Account ${account} has ${String(ours[account].length)} project(s), so there is none at ${String(index)}. Setup decides how many each account gets.`,
    );
  }
  return found;
}

/**
 * Builds the path a spec navigates to.
 * @param prepared - What setup made.
 * @param at - Which worker slot.
 * @param account - Which account of that slot owns it.
 * @param index - Which of that account's Projects, in the order made.
 * @returns A path ready for `page.goto`.
 * @throws {Error} When there is no Project at that place.
 */
export function projectUrl(
  prepared: PreparedSlots,
  at: number,
  account: Account,
  index: number,
): string {
  return `/project/${projectId(prepared, at, account, index)}`;
}

/** One answer from the API, as much of it as clean-up reads. */
interface ApiAnswer {
  ok: () => boolean;
  status: () => number;
  json: () => Promise<unknown>;
}

/** The least a signed-in request context has to offer to archive Projects. */
export interface ProjectApi {
  get: (url: string) => Promise<ApiAnswer>;
  post: (url: string) => Promise<ApiAnswer>;
}

/**
 * Archives Projects and reports the ones that stayed live.
 * @param api - A request context signed in as the studio's admin.
 * @param ids - The Projects to archive.
 * @returns Each Project that was not archived, with the status that refused it.
 */
export async function archiveProjects(
  api: ProjectApi,
  ids: readonly string[],
): Promise<string[]> {
  const left: string[] = [];
  for (const id of ids) {
    const archived = await api.post(`/api/v1/projects/${id}/archive`);
    if (!archived.ok()) left.push(`${id} (${archived.status()})`);
  }
  return left;
}

/**
 * Archives every live Project in a studio that an earlier run made.
 *
 * Teardown handles the run that finishes; a run that is interrupted leaves its
 * Projects live, and they count against the studio's Project limit until
 * setup can no longer create any.
 *
 * This cannot tell an abandoned Project from one a run is working in right
 * now, so runs take turns on an account: a second run started while the first
 * is going archives the Projects that one is using, and its cases then fail
 * on a read-only Project.
 * @param api - A request context signed in as the studio's admin.
 * @param studioSlug - The studio to clear; its projects are listed by slug.
 * @throws {Error} When the studio's projects cannot be listed, or one of them cannot be archived.
 */
export async function archiveOlderRuns(api: ProjectApi, studioSlug: string): Promise<void> {
  // Paging by creation time is unaffected by the archiving: each cursor carries
  // the last row's own values, not an offset.
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ sort: 'created', limit: '100', ...(cursor ? { cursor } : {}) });
    const listed = await api.get(`/api/v1/studio/${studioSlug}/projects?${query}`);
    if (!listed.ok()) {
      throw new Error(`Could not list the projects of studio ${studioSlug} (${listed.status()}).`);
    }
    const { data } = (await listed.json()) as {
      data: { items: { id: string; slug: string }[]; nextCursor: string | null };
    };
    const ours = data.items.filter((project) => project.slug.startsWith(MADE_BY_SMOKE));
    const left = await archiveProjects(api, ours.map((project) => project.id));
    if (left.length > 0) {
      throw new Error(`Could not archive the projects an earlier run made: ${left.join(', ')}.`);
    }
    cursor = data.nextCursor ?? undefined;
  } while (cursor);
}
