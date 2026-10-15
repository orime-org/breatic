// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Everything a run needs before a single case opens a page.
 *
 * What this replaces is a suite that assumed: that the machine had
 * credentials, that the account had a studio, that the studio had a Project,
 * and that somebody had cleaned up after the last run. Each assumption held
 * on the machine it was written on and nowhere else, and when one did not
 * hold the report blamed the product — twenty-seven specs went red for want
 * of a Project, and a whole run reported a zero exit code with 289 cases
 * skipped.
 *
 * Playwright runs this before the suites that depend on it, and stops them if
 * it fails: *If the tests from a dependency fails then the tests that rely on
 * this project will not be run.* That is the opposite of the silent skip.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  expect,
  request,
  test as setup,
  type APIRequestContext,
  type Browser,
} from 'playwright/test';
import {
  newCredentials,
  personalStudioSlug,
  readAccounts,
  rememberAccount,
} from '../helpers/credentials';
import {
  archiveOlderRuns,
  MADE_BY_SMOKE,
  PROJECTS_FILE,
  type Account,
} from '../helpers/project';
import { whileRateLimited } from '../helpers/rate-limit';
import { stateFile } from '../helpers/slot';
import { REMOVALS_FILE } from '../helpers/space';

/** How many Projects each account gets, and why it needs that many. */
const PROJECTS_PER_ACCOUNT: Readonly<Record<Account, number>> = {
  // `space-tab-restore` walks between two Projects on the first account.
  A: 2,
  // The second account walks its OWN Project: opening one it is not a member
  // of answers "Your session is invalid" with an empty strip, which would
  // make that case ask a membership question instead of the one it is for.
  B: 1,
};

/**
 * Refuse to run anywhere but this machine.
 *
 * Setup creates accounts and removes Projects, against whatever address the
 * config points at. Those are writes, and the only place they belong is the
 * developer's own stack — a suite aimed at a shared deployment would be
 * making accounts and deleting other people's Projects there.
 * @param baseURL - Where the app is being served.
 * @throws {Error} When that is not this machine.
 */
function onlyLocal(baseURL: string): void {
  const { hostname } = new URL(baseURL);
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return;
  throw new Error(
    `This suite creates accounts and removes Projects, so it runs against the local stack only. The config points at ${baseURL}.`,
  );
}

/**
 * Confirms the browser is being served the code this checkout holds.
 *
 * A dev server that has been up a while serves what it built when it started.
 * The page renders, the console is clean, every request answers 200, and this
 * round's changes are simply absent — so a case that goes red reads as a
 * defect in code that was never loaded. Switching branches does the same
 * through a dependency's stale `dist`, and there the console says so.
 *
 * All three shapes only appear once a browser runs the modules: a module
 * request answering 504 while the document answers 200, a page that renders
 * perfectly from code built before this change, and a `SyntaxError` about an
 * export a stale `dist` does not carry. So this opens a page, collects what
 * the page throws, and asks whether the app painted anything.
 * @param browser - The browser the run is using.
 * @param baseURL - Where the app is being served.
 * @throws {Error} When the app paints nothing, or the page throws.
 */
async function preflight(browser: Browser, baseURL: string): Promise<void> {
  const page = await browser.newPage();
  const threw: string[] = [];
  page.on('pageerror', (err) => threw.push(err.message));
  let painted = 0;
  try {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    // The app's own root, not `body`: the shell around it is in the HTML the
    // server sends, and it is there whether or not a single module ran.
    painted = await page
      .locator('#root')
      .innerHTML({ timeout: 15_000 })
      .then((html) => html.length)
      .catch(() => 0);
  } finally {
    await page.close();
  }
  if (painted > 0 && threw.length === 0) return;
  throw new Error(
    `The app painted nothing at ${baseURL}/login${threw.length > 0 ? `, and the page threw: ${threw[0]}` : ''}. This is the environment, not the code: restart \`pnpm dev\`, and build the dependency packages again if you have switched branches since it started.`,
  );
}

/**
 * Opens a request context on the session the last run left, when there is one.
 *
 * Signing in is rate limited to five a minute (`config/rate-limits.yaml`) and
 * the limiter keys on the caller's address, so a developer running the suite
 * while fixing something spends that budget in a couple of minutes, and each
 * sign-in past it waits out a whole window. The
 * server is the one that knows whether the old session is still its own, so it
 * is the one asked.
 * @param baseURL - Where the app is being served.
 * @param at - Which worker slot.
 * @param account - Which account of that slot.
 * @returns A context carrying a live session, or null when there is none.
 */
async function reuseSession(
  baseURL: string,
  at: number,
  account: Account,
): Promise<APIRequestContext | null> {
  if (!existsSync(stateFile(account, at))) return null;
  const api = await request.newContext({
    baseURL,
    storageState: stateFile(account, at),
  });
  const live = await api
    .get('/api/v1/auth/me')
    .then((r) => r.ok())
    .catch(() => false);
  if (live) return api;
  await api.dispose();
  return null;
}

/**
 * Signs the account in, making it the first time and again if it is gone.
 *
 * The recorded pair is tried first, so a machine that has run before keeps
 * its account and its data. A pair that no longer signs in — a database that
 * was reset, a record that was deleted — is replaced by a new one, which is
 * what makes a first run and a wiped run the same path.
 *
 * Only a refusal of the credentials themselves means that. Signing in is
 * limited to five a minute (`config/rate-limits.yaml`), so a 429 is waited
 * out rather than taken for a dead account, which would abandon a working
 * account and its Projects. A server that is having trouble says so with a
 * 5xx, which is not an answer about this account either.
 *
 * A new account is created by `seedAccount` and then signed in like any other.
 * @param api - A request context with no cookies yet.
 * @param at - Which worker slot.
 * @param account - Which account of that slot.
 * @returns Nothing; the context carries the session from here on.
 * @throws {Error} When signing in is refused for a reason other than the
 *   credentials, or when creating a fresh account fails.
 */
async function signInOrRegister(
  api: APIRequestContext,
  at: number,
  account: Account,
): Promise<void> {
  const held = readAccounts()[String(at)]?.[account];
  if (held !== undefined) {
    const signedIn = await whileRateLimited(() => api.post('/api/v1/auth/login', { data: held }));
    if (signedIn.ok()) return;
    if (signedIn.status() !== 401) {
      throw new Error(
        `Account ${account} of slot ${String(at)} could not sign in (${signedIn.status()}: ${(await signedIn.text()).slice(0, 160)}). This is the server rather than this account; the recorded account is left alone.`,
      );
    }
  }

  const made = newCredentials(account, at);
  seedAccount(made);
  rememberAccount(at, account, made);
  const signedIn = await whileRateLimited(() => api.post('/api/v1/auth/login', { data: made }));
  if (!signedIn.ok()) {
    throw new Error(
      `Account ${account} of slot ${String(at)} was created but could not sign in (${signedIn.status()}: ${(await signedIn.text()).slice(0, 160)}).`,
    );
  }
}

/** The repository root, where the account script runs from. */
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * Create an account directly, through the server's own `register`.
 *
 * The suites need accounts to run their flows with, not to test signing up,
 * and `POST /auth/register` is limited to ten an hour per address — the
 * budget the specs that do test signing up run on. So the account is made by
 * `scripts/seed-smoke-account.ts`, which calls the function that route calls
 * when email is off.
 * @param made - The address and password to create it with.
 * @throws {Error} When the script fails, with what it printed.
 */
function seedAccount(made: { email: string; password: string }): void {
  try {
    execFileSync(
      'pnpm',
      ['exec', 'tsx', '--tsconfig', 'packages/server/tsconfig.json', 'scripts/seed-smoke-account.ts'],
      { cwd: REPO_ROOT, input: JSON.stringify(made), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const said = (err as { stderr?: string }).stderr?.trim() ?? String(err);
    throw new Error(`Could not create ${made.email} with scripts/seed-smoke-account.ts: ${said.slice(-400)}`);
  }
}

/** A studio as the switcher list reports it. */
interface PersonalStudio {
  id: string;
  slug: string;
}

/**
 * Reads the account's personal studio out of the switcher list.
 * @param api - A signed-in request context.
 * @returns The studio, or null when the account has none yet.
 */
async function findPersonalStudio(
  api: APIRequestContext,
): Promise<PersonalStudio | null> {
  const listed = await api.get('/api/v1/studios');
  if (!listed.ok()) return null;
  const { data } = (await listed.json()) as {
    data: { id: string; slug: string; type: string }[];
  };
  const personal = data.find((studio) => studio.type === 'personal');
  return personal ? { id: personal.id, slug: personal.slug } : null;
}

/**
 * Gives the account a personal studio when it has none, and reports it.
 *
 * Registering creates the account and nothing else — `/auth/me` answers
 * `personalStudio: null` until the second step names a slug, and neither
 * answer carries the studio's id. Both the id and the slug are needed later:
 * creating a Project takes the id, listing them takes the slug.
 * @param api - A signed-in request context.
 * @param at - Which worker slot, used to build a slug.
 * @param account - Which account of that slot, used to build a slug.
 * @returns The personal studio's id and slug.
 * @throws {Error} When the studio can be neither found nor created.
 */
async function personalStudio(
  api: APIRequestContext,
  at: number,
  account: Account,
): Promise<PersonalStudio> {
  const existing = await findPersonalStudio(api);
  if (existing) return existing;

  const slug = personalStudioSlug(account, at);
  const made = await api.post('/api/v1/auth/setup-studio', { data: { slug } });
  if (!made.ok()) {
    throw new Error(
      `Account ${account} has no personal studio and one could not be created (${made.status()}: ${(await made.text()).slice(0, 200)}).`,
    );
  }
  const now = await findPersonalStudio(api);
  if (!now) {
    throw new Error(
      `Account ${account} still lists no personal studio after creating one.`,
    );
  }
  return now;
}

/** What the preflight page load may take (see `preflight`). */
const PREFLIGHT_MS = 20_000;

/**
 * What preparing one slot's pair may take: signing in or creating each
 * account, its studio, archiving last run's Projects and making three new ones.
 */
const PER_SLOT_MS = 60_000;

/** One wait on the sign-in limit; the server's Retry-After is the whole window. */
const ONE_LOGIN_WAIT_MS = 60_000;

/** The interface language every case expects to read; the specs assert English text. */
const SUITE_LOCALE = 'en';

/**
 * Puts the account's stored language back to the one the suite reads in.
 *
 * The language lives on the account and every fresh page adopts it on load,
 * so a case that switches it and does not switch it back -- or a run stopped
 * part way through one -- leaves every later case reading another language.
 * @param api - A signed-in request context.
 * @param account - Which account it is, for the message.
 * @throws {Error} When the language is not stored.
 */
async function resetLocale(api: APIRequestContext, account: Account): Promise<void> {
  const set = await api.patch('/api/v1/users/me/locale', { data: { locale: SUITE_LOCALE } });
  if (!set.ok()) {
    throw new Error(`Could not set account ${account}'s language to ${SUITE_LOCALE} (${set.status()}).`);
  }
}

/**
 * Creates one Project and reports its id.
 * @param api - A signed-in request context.
 * @param studioId - The studio to create it in.
 * @param ordinal - Which of this account's Projects it is.
 * @returns The new Project's id.
 * @throws {Error} When the Project is not created.
 */
async function createProject(
  api: APIRequestContext,
  studioId: string,
  ordinal: number,
): Promise<string> {
  const slug = `${MADE_BY_SMOKE}-${Date.now()}-${ordinal}`;
  const made = await api.post('/api/v1/projects', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: { studioId, name: `Smoke run ${ordinal}`, slug, spaceType: 'canvas' },
  });
  if (!made.ok()) {
    throw new Error(
      `Could not create a Project (${made.status()}: ${(await made.text()).slice(0, 200)}). The base tier allows ten per studio; setup sweeps its own leftovers, but Projects made by hand count too.`,
    );
  }
  const { data } = (await made.json()) as { data: { id: string } };
  return data.id;
}

/**
 * Writes a file, creating the directory it lives in.
 * @param path - Where to write.
 * @param content - What to write.
 */
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

setup('prepare the accounts and their projects', async ({ browser, baseURL }) => {
  expect(baseURL, 'the config must give the suite a baseURL').toBeTruthy();
  onlyLocal(baseURL as string);
  // One pair per worker the run starts: each worker reads its own by
  // `parallelIndex` (helpers/slot.ts), and every index is below this.
  const slots = setup.info().config.workers;
  setup.setTimeout(PREFLIGHT_MS + slots * PER_SLOT_MS + ONE_LOGIN_WAIT_MS);
  await preflight(browser, baseURL as string);

  // Last run's unremoved Spaces are its own verdict, already reported.
  rmSync(REMOVALS_FILE, { force: true });
  const prepared: Record<string, Record<Account, string[]>> = {};

  for (let at = 0; at < slots; at += 1) {
    prepared[String(at)] = { A: [], B: [] };
    for (const account of ['A', 'B'] as const) {
      // The record is what says an account is ours. A stored session with no
      // record behind it belongs to an account nothing here can sign in as
      // again, and the case that signs the second account in from inside the
      // browser needs the pair, so that session is left alone.
      let api =
        readAccounts()[String(at)]?.[account] === undefined
          ? null
          : await reuseSession(baseURL as string, at, account);
      if (api === null) {
        api = await request.newContext({ baseURL });
        await signInOrRegister(api, at, account);
      }
      await resetLocale(api, account);
      const studio = await personalStudio(api, at, account);
      await archiveOlderRuns(api, studio.slug);
      for (let made = 0; made < PROJECTS_PER_ACCOUNT[account]; made += 1) {
        prepared[String(at)][account].push(await createProject(api, studio.id, made));
      }
      await api.storageState({ path: stateFile(account, at) });
      await api.dispose();
    }
  }

  write(PROJECTS_FILE, JSON.stringify(prepared, null, 2));
});
