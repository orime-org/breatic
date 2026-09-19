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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, request, test as setup, type APIRequestContext } from 'playwright/test';
import { credentialsFor } from '../helpers/credentials';
import { PROJECTS_FILE, STATE_FILE, type Account } from '../helpers/project';

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
 * Confirms the browser is being served the code this checkout holds.
 *
 * A dev server that has been up a while serves what it built when it
 * started. The page renders, the console is clean, every request answers
 * 200, and this round's changes are simply absent — so a case that goes red
 * reads as a defect in code that was never loaded. Switching branches does
 * the same through a dependency's stale `dist`, and there the console does
 * say something, which is why it is collected.
 * @param baseURL - Where the app is being served.
 * @throws {Error} When the login page does not render.
 */
async function preflight(baseURL: string): Promise<void> {
  const browser = await request.newContext({ baseURL });
  const answer = await browser.get('/login');
  const body = await answer.text();
  await browser.dispose();
  if (!answer.ok() || body.length === 0) {
    throw new Error(
      `The app did not answer /login (${answer.status()}). This is the environment, not the code: check the dev server is up at ${baseURL}, and restart it if it has been running since before your last change.`,
    );
  }
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
 * Signs an account in, registering it the first time.
 * @param api - A request context with no cookies yet.
 * @param account - Which account this is.
 * @returns Nothing; the context carries the session from here on.
 * @throws {Error} When neither signing in nor registering is accepted.
 */
async function signInOrRegister(
  api: APIRequestContext,
  account: Account,
): Promise<void> {
  const { email, password } = credentialsFor(account);

  const signedIn = await api.post('/api/v1/auth/login', {
    data: { email, password },
  });
  if (signedIn.ok()) return;

  const registered = await api.post('/api/v1/auth/register', {
    data: { email, password },
  });
  if (!registered.ok()) {
    throw new Error(
      `Account ${account} could neither sign in (${signedIn.status()}: ${(await signedIn.text()).slice(0, 120)}) nor register (${registered.status()}: ${(await registered.text()).slice(0, 120)}). A 429 on the sign-in is the five-a-minute ceiling, not a broken account: wait a minute and run it again.`,
    );
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

setup('prepare the accounts and their projects', async ({ baseURL }) => {
  expect(baseURL, 'the config must give the suite a baseURL').toBeTruthy();
  await preflight(baseURL as string);

  const prepared: Record<Account, string[]> = { A: [], B: [] };

  for (const account of ['A', 'B'] as const) {
    let api = await reuseSession(baseURL as string, account);
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
