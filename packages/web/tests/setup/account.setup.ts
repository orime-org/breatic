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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  expect,
  request,
  test as setup,
  type APIRequestContext,
  type Browser,
} from 'playwright/test';
import { newCredentials, readAccounts, rememberAccount } from '../helpers/credentials';
import { PROJECTS_FILE, STATE_FILE, type Account } from '../helpers/project';
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

/** Marks the Projects this suite made, so later runs can recognise them. */
const MADE_BY_SMOKE = 'smoke-run';

/**
 * Refuse to run anywhere but this machine.
 *
 * Setup registers accounts and removes Projects, against whatever address the
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
    `This suite registers accounts and removes Projects, so it runs against the local stack only. The config points at ${baseURL}.`,
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
 * while fixing something spends that budget in a couple of minutes — and what
 * the sixth run then reports is an account that can neither sign in nor
 * register, which reads as a broken account rather than as a ceiling. The
 * server is the one that knows whether the old session is still its own, so it
 * is the one asked.
 * @param baseURL - Where the app is being served.
 * @param account - Which account this is.
 * @returns A context carrying a live session, or null when there is none.
 */
async function reuseSession(
  baseURL: string,
  account: Account,
): Promise<APIRequestContext | null> {
  if (!existsSync(STATE_FILE[account])) return null;
  const api = await request.newContext({
    baseURL,
    storageState: STATE_FILE[account],
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
 * limited to five a minute and registering to ten an hour
 * (`config/rate-limits.yaml`), so treating a 429 as a dead account spends the
 * scarcer budget to replace an account that was working, and abandons its
 * Projects on the way. A server that is having trouble says so with a 5xx,
 * which is not an answer about this account either.
 * @param api - A request context with no cookies yet.
 * @param account - Which account this is.
 * @returns Nothing; the context carries the session from here on.
 * @throws {Error} When signing in is refused for a reason other than the
 *   credentials, or when registering a fresh pair is refused.
 */
async function signInOrRegister(
  api: APIRequestContext,
  account: Account,
): Promise<void> {
  const held = readAccounts()[account];
  if (held !== undefined) {
    const signedIn = await api.post('/api/v1/auth/login', { data: held });
    if (signedIn.ok()) return;
    if (signedIn.status() !== 401) {
      throw new Error(
        `Account ${account} could not sign in (${signedIn.status()}: ${(await signedIn.text()).slice(0, 160)}). A 429 is the five-a-minute ceiling on signing in (config/rate-limits.yaml) and clears within the minute; anything else is the server rather than this account. The recorded account is left alone either way.`,
      );
    }
  }

  const made = newCredentials(account);
  const registered = await api.post('/api/v1/auth/register', { data: made });
  if (!registered.ok()) {
    throw new Error(
      `Account ${account} could not be registered (${registered.status()}: ${(await registered.text()).slice(0, 160)}). A 429 is the ten-an-hour ceiling on registration (config/rate-limits.yaml).`,
    );
  }
  rememberAccount(account, made);
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
 * @param account - Which account this is, used to build a slug.
 * @returns The personal studio's id and slug.
 * @throws {Error} When the studio can be neither found nor created.
 */
async function personalStudio(
  api: APIRequestContext,
  account: Account,
): Promise<PersonalStudio> {
  const existing = await findPersonalStudio(api);
  if (existing) return existing;

  const slug = `smoke-${account.toLowerCase()}-${Math.floor(Date.now() / 1000)}`;
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

/**
 * Removes the Projects earlier runs left behind.
 *
 * Teardown handles the run that finishes. A run that is interrupted — and a
 * suite this long gets interrupted — leaves its Projects, and Projects have a
 * ceiling the base tier sets at ten. Without this, a few interruptions are
 * enough that setup can no longer create anything and the whole suite fails
 * for a reason that has nothing to do with the code.
 *
 * The sweep cannot tell an abandoned Project from one a run is working in
 * right now, so the two suites take turns on an account: a second run started
 * while the first is going removes the Projects that one is using, and its
 * cases then fail on a Project that is no longer there. `workers: 1` already
 * says one case at a time; this says one run at a time.
 * @param api - A signed-in request context.
 * @param studioSlug - The studio to sweep; its projects are listed by slug.
 */
async function removeOlderRuns(
  api: APIRequestContext,
  studioSlug: string,
): Promise<void> {
  const listed = await api.get(`/api/v1/studio/${studioSlug}/projects`);
  if (!listed.ok()) return;
  const { data } = (await listed.json()) as { data: { id: string; slug: string }[] };
  for (const project of data) {
    if (!project.slug.startsWith(MADE_BY_SMOKE)) continue;
    await api.delete(`/api/v1/projects/${project.id}`);
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
  await preflight(browser, baseURL as string);

  // Last run's unremoved Spaces are its own verdict, already reported.
  rmSync(REMOVALS_FILE, { force: true });

  const prepared: Record<Account, string[]> = { A: [], B: [] };

  for (const account of ['A', 'B'] as const) {
    // The record is what says an account is ours. A stored session with no
    // record behind it belongs to an account nothing here can sign in as
    // again, and the case that signs the second account in from inside the
    // browser needs the pair, so that session is left alone.
    let api =
      readAccounts()[account] === undefined
        ? null
        : await reuseSession(baseURL as string, account);
    if (api === null) {
      api = await request.newContext({ baseURL });
      await signInOrRegister(api, account);
    }
    const studio = await personalStudio(api, account);
    await removeOlderRuns(api, studio.slug);
    for (let made = 0; made < PROJECTS_PER_ACCOUNT[account]; made += 1) {
      prepared[account].push(await createProject(api, studio.id, made));
    }
    await api.storageState({ path: STATE_FILE[account] });
    await api.dispose();
  }

  write(PROJECTS_FILE, JSON.stringify(prepared, null, 2));
});
