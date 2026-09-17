// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every route entry waits behind the one full-screen loading screen (#142).
 *
 * Each entry now downloads its own chunk, and the wait that creates is covered
 * by a single `Suspense` boundary in `AppRouter`. Unit tests pin the wiring —
 * that every page goes through `lazyRoute`, and that the boundary is the one
 * fallback — but they cannot answer whether a reader opening a given address
 * actually sees that screen: the fallback lives for a few frames, and a
 * jsdom router never completes a navigation (`AppRouter.test.tsx` says why).
 *
 * So this walks all thirteen addresses in a real browser, one case each rather
 * than a representative sample, and records what the screen did during each
 * one. A `MutationObserver` installed before any app code runs catches the
 * fallback even when it is gone in 13ms.
 *
 * What it does NOT cover: that a client-side navigation *replaces* the page
 * being left rather than holding it on screen. That is what
 * `useTransitions={false}` buys, and `AppRouter.test.tsx` pins the prop; the
 * on-screen half was measured by hand (design §8, A3).
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

interface Landmarks {
  /** A studio the account administers. */
  slug: string;
  /** A project in that studio. */
  projectId: string;
}

interface LoadingScreenRecord {
  /** How many times the loading screen appeared during this document. */
  seen: number;
  /** Whether it covered the viewport the first time, or null if never shown. */
  fullScreen: boolean | null;
}

/**
 * Watch for the loading screen from before the first line of app code runs.
 *
 * The fallback is replaced as soon as the chunk evaluates, which is too early
 * for a locator to be waiting on it. An observer installed at document start
 * records the appearance instead, so the assertion reads a fact about what
 * happened rather than racing it.
 * @param page - The page to install the observer on, before any navigation.
 */
async function watchLoadingScreen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = { seen: 0, fullScreen: null };
    Object.defineProperty(window, '__loadingScreen', { value: record });
    let onScreen = false;
    const check = (): void => {
      const el = document.querySelector('[data-testid="loading-screen"]');
      if (el === null) {
        onScreen = false;
        return;
      }
      if (onScreen) {
        return;
      }
      onScreen = true;
      record.seen += 1;
      if (record.fullScreen === null) {
        const box = el.getBoundingClientRect();
        record.fullScreen =
          box.width >= window.innerWidth - 1 &&
          box.height >= window.innerHeight - 1;
      }
    };
    new MutationObserver(check).observe(document, {
      childList: true,
      subtree: true,
    });
    check();
  });
}

/**
 * Sign a page in and leave it wherever the app lands after login.
 * @param page - A fresh page.
 * @throws {Error} When the sign-in never leaves the login route.
 */
async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
}

/**
 * The studio and project whose ids the parameterised addresses need.
 *
 * Read from the API rather than clicked out of the interface: this spec is
 * about what the router does, and a broken studio list would otherwise fail
 * it for an unrelated reason.
 * @param page - A signed-in page.
 * @returns A studio slug and a project id inside it.
 * @throws {Error} When the account administers no studio, or that studio has
 *   no project.
 */
async function findLandmarks(page: Page): Promise<Landmarks> {
  const listed = await page.request.get('/api/v1/studios');
  expect(listed.status()).toBe(200);
  const studios = (
    (await listed.json()) as { data: { slug: string; type: string }[] }
  ).data;
  const studio = studios.find((s) => s.type === 'personal') ?? studios[0];
  if (studio === undefined) {
    throw new Error('the smoke account administers no studio');
  }

  const projects = await page.request.get(
    `/api/v1/studio/${studio.slug}/projects`,
  );
  expect(projects.status()).toBe(200);
  const rows = ((await projects.json()) as { data: { id: string }[] }).data;
  if (rows[0] === undefined) {
    throw new Error(`studio ${studio.slug} holds no project`);
  }
  return { slug: studio.slug, projectId: rows[0].id };
}

/**
 * Open one address in its own document and report what the screen did.
 *
 * A fresh page per entry is what makes the measurement mean anything: module
 * caching is per document, so a second visit to an already-fetched chunk
 * would not suspend at all.
 * @param context - The signed-in browser context.
 * @param address - The address to open.
 * @returns What the observer recorded, plus any uncaught page errors.
 */
async function openEntry(
  context: BrowserContext,
  address: string,
): Promise<{ record: LoadingScreenRecord; pageErrors: string[] }> {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await watchLoadingScreen(page);

  try {
    await page.goto(address);
    await page.waitForFunction(
      () =>
        (window as unknown as { __loadingScreen: LoadingScreenRecord })
          .__loadingScreen.seen > 0,
      undefined,
      { timeout: 20_000 },
    );
    // The screen has to go again: a reader left on it forever is the failure
    // this whole design has to avoid, and it looks identical to a slow chunk
    // until the wait ends.
    await expect(page.getByTestId('loading-screen')).toHaveCount(0, {
      timeout: 20_000,
    });
    const record = await page.evaluate(
      () =>
        (window as unknown as { __loadingScreen: LoadingScreenRecord })
          .__loadingScreen,
    );
    return { record, pageErrors };
  } finally {
    await page.close();
  }
}

/**
 * The thirteen addresses a reader can land on, as `routes.tsx` declares them.
 *
 * Written out rather than derived, because a browser needs concrete ids. What
 * keeps it honest is `routes-lazy.test.tsx`: its third case lists every path
 * the table produces, so an entry added without one fails there and sends
 * whoever added it here.
 * @param ids - The studio and project to build parameterised paths from.
 * @returns One address per production entry.
 */
function addressesOf(ids: Landmarks): string[] {
  return [
    '/studio',
    `/studio/${ids.slug}`,
    `/studio/${ids.slug}/settings`,
    `/project/${ids.projectId}`,
    `/project/${ids.projectId}/access`,
    '/decision',
    '/choose-slug',
    '/login',
    '/register',
    '/recovery-code',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
  ];
}

let shared: BrowserContext;
let landmarks: Landmarks;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  shared = await browser.newContext();
  const page = await shared.newPage();
  await signIn(page);
  landmarks = await findLandmarks(page);
  await page.close();
});

test.afterAll(async () => {
  await shared.close();
});

// One case per address rather than one case looping over them: a failure then
// names the entry that broke, and the 30s per-case budget is per entry.
for (const [index, address] of addressesOf({
  slug: ':slug',
  projectId: ':projectId',
}).entries()) {
  test(`entry ${address} waits behind the shared loading screen`, async () => {
    const real = addressesOf(landmarks)[index] as string;
    const { record, pageErrors } = await openEntry(shared, real);

    expect(record.seen, `${real} never showed the loading screen`).toBeGreaterThan(0);
    expect(record.fullScreen, `${real} showed a loading screen that did not cover the viewport`).toBe(true);
    expect(pageErrors, `${real} threw:\n${pageErrors.join('\n')}`).toEqual([]);
  });
}
