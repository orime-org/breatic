// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every route entry waits behind the one full-screen loading screen (#142).
 *
 * Each entry now downloads its own chunk, and the wait that creates is covered
 * by a single `Suspense` boundary in `AppRouter`. Unit tests pin the wiring —
 * that every page goes through `lazyRoute`, and that the boundary is the one
 * fallback — but they cannot answer whether a reader opening a given address
 * sees that screen: the fallback lives for a few frames, and a jsdom router
 * never completes a navigation (`AppRouter.test.tsx` says why).
 *
 * So this walks all thirteen addresses in a real browser, one case each rather
 * than a representative sample, and holds each one's page module back long
 * enough to look at the screen. Holding it is what makes the check mean
 * something: seven of the thirteen are behind `ProtectedRoute`, which shows
 * the same screen while `/auth/me` is in flight, so a test that only asks
 * "did that test id ever appear" passes on those seven even with the Suspense
 * fallback deleted (measured).
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

/**
 * How long the page module is held back.
 *
 * Read the screen at the end of it rather than at a chosen moment after the
 * navigation: ProtectedRoute's own wait covers `/auth/me` and the studio
 * decision behind it, and neither is held back, so by the time the module is
 * about to arrive that wait is long over. What is on screen then is the
 * Suspense fallback and nothing else.
 */
const HOLD_MS = 2_000;

interface Landmarks {
  /** A studio the account administers. */
  slug: string;
  /** A project in that studio. */
  projectId: string;
}

interface Entry {
  /** The address a reader opens. */
  address: (ids: Landmarks) => string;
  /** The page module this entry fetches, as `routes.tsx` names it. */
  module: string;
  /** Text or a test id the destination renders, and nothing else does. */
  landed: { testId: string } | { text: string };
}

interface Watched {
  /** How many times the loading screen appeared. */
  seen: number;
  /** Whether it covered the viewport the first time it did. */
  fullScreen: boolean | null;
}

/**
 * The thirteen entries a reader can land on, as `routes.tsx` declares them.
 *
 * Written out rather than derived, because a browser needs concrete ids and a
 * landmark per destination. What keeps it honest is `routes-lazy.test.tsx`:
 * its third case lists every path the table produces, so an entry added
 * without one fails there and sends whoever added it here.
 */
const ENTRIES: Entry[] = [
  {
    address: () => '/studio',
    module: 'StudioRecentPage',
    landed: { testId: 'rail-create-project' },
  },
  {
    address: (ids) => `/studio/${ids.slug}`,
    module: 'StudioContainerPage',
    landed: { testId: 'container-toolbar' },
  },
  {
    address: (ids) => `/studio/${ids.slug}/settings`,
    module: 'StudioContainerPage',
    landed: { testId: 'avatar-upload-open' },
  },
  {
    address: (ids) => `/project/${ids.projectId}`,
    module: 'ProjectPage',
    landed: { testId: 'project-page' },
  },
  {
    address: (ids) => `/project/${ids.projectId}/access`,
    module: 'NoAccessPage',
    landed: { testId: 'no-access-page' },
  },
  {
    address: () => '/decision',
    module: 'DecisionLandingPage',
    landed: { text: 'This link is not valid' },
  },
  {
    address: () => '/choose-slug',
    module: 'SlugSetupPage',
    landed: { text: 'Pick your Slug' },
  },
  { address: () => '/login', module: 'LoginPage', landed: { text: 'Welcome back' } },
  {
    address: () => '/register',
    module: 'RegisterPage',
    landed: { text: 'Create an account' },
  },
  {
    // A direct visit bounces to /login: the one-time code is never in the URL,
    // so there is nothing to show. `routes.tsx` records that as existing
    // behaviour; the chunk is fetched either way.
    address: () => '/recovery-code',
    module: 'RecoveryCodePage',
    landed: { text: 'Welcome back' },
  },
  {
    address: () => '/forgot-password',
    module: 'ForgotPasswordPage',
    landed: { text: 'Forgot your password?' },
  },
  {
    address: () => '/reset-password',
    module: 'ResetPasswordPage',
    landed: { text: 'Reset with recovery code' },
  },
  {
    address: () => '/verify-email',
    module: 'VerifyEmailPage',
    landed: { text: 'Check your inbox' },
  },
];

/**
 * Watch for the loading screen from before the first line of app code runs.
 *
 * An observer installed at document start records the appearance, so the
 * assertion reads a fact about what happened rather than racing it.
 * @param page - The page to install the observer on, before any navigation.
 */
async function watchLoadingScreen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = { seen: 0, fullScreen: null };
    Object.defineProperty(window, '__loadingScreen', { value: record });
    let onScreen = false;
    const check = (): void => {
      // React keeps suspended content mounted and hides it, so ProtectedRoute's
      // own screen sits in the DOM as `display: none` next to the fallback.
      // Only the one the reader can see counts.
      const el = [...document.querySelectorAll('[data-testid="loading-screen"]')].find(
        (node) => (node as HTMLElement).offsetParent !== null,
      );
      if (el === undefined) {
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
// names the entry that broke, and the per-case budget is per entry.
for (const entry of ENTRIES) {
  const name = entry.address({ slug: ':slug', projectId: ':projectId' });
  test(`entry ${name} waits behind the shared loading screen`, async () => {
    const address = entry.address(landmarks);
    // A fresh page per entry is what makes the measurement mean anything:
    // module caching is per document, so a second visit to an already-fetched
    // chunk would not suspend at all.
    const page = await shared.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await watchLoadingScreen(page);

    // Hold the page module back. `/auth/me` is not held, so ProtectedRoute's
    // own wait is over well before the window below — whatever is on screen
    // then is the Suspense fallback.
    let onScreenAtRelease = -1;
    await page.route(`**/${entry.module}.tsx*`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      onScreenAtRelease = await page
        .locator('[data-testid="loading-screen"]:visible')
        .count();
      await route.continue();
    });

    try {
      await page.goto(address);

      // The destination renders, which is what the wait was for. An error
      // screen satisfies "the loading screen left" just as well. Waiting for
      // it also puts the module's arrival in the past, so the reading taken
      // inside the route handler is there to assert on.
      const landmark =
        'testId' in entry.landed
          ? page.getByTestId(entry.landed.testId)
          : page.getByText(entry.landed.text, { exact: false }).first();
      await expect(landmark).toBeVisible({ timeout: 20_000 });

      // Exactly one on screen: the entries share a single boundary, so a
      // second visible waiting screen would mean two of them are waiting.
      expect(
        onScreenAtRelease,
        `${address} had ${onScreenAtRelease} visible loading screens when its page module arrived`,
      ).toBe(1);
      await expect(page.locator('[data-testid="loading-screen"]:visible')).toHaveCount(0);

      const record = await page.evaluate(
        () => (window as unknown as { __loadingScreen: Watched }).__loadingScreen,
      );
      expect(
        record.fullScreen,
        `${address} showed a loading screen that did not cover the viewport`,
      ).toBe(true);
      expect(pageErrors, `${address} threw:\n${pageErrors.join('\n')}`).toEqual([]);
    } finally {
      await page.close();
    }
  });
}
