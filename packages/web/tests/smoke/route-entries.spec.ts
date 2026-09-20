// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every route entry waits behind the one full-screen loading screen (#142).
 *
 * Each entry now downloads its own chunk, and the wait that creates is covered
 * by a single `Suspense` boundary — `LoadingBoundary`, the pathless layout
 * route every entry sits under. Unit tests pin the wiring — that every page
 * goes through `lazyRoute`, and that the boundary holds the whole table — but
 * they cannot answer whether a reader opening a given address sees that
 * screen: the fallback lives for a few frames, and a jsdom router never
 * completes a navigation (`AppRouter.test.tsx` says why).
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
 * Needs a running dev stack (`pnpm dev`):
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright/test';

import { STATE_FILE, smokeProjectId } from '../helpers/project';


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
  /**
   * Text or a test id the destination renders, which no other page on the way
   * there does. Where an entry redirects, this belongs to where it lands.
   */
  landed: { testId: string } | { text: string };
  /**
   * Set when the entry redirects, which makes a second navigation.
   *
   * Everywhere else the screen appears exactly once: `ProtectedRoute`'s wait
   * and the Suspense fallback are the same component and React hands over
   * between them without a gap, which is the continuity A4 asks for. Across a
   * redirect that count is not pinned — see the assertion.
   */
  redirects?: true;
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
 * landmark per destination. What keeps it honest is the "covers every entry a
 * reader can land on" case in `routes-lazy.test.tsx`: it lists every path the
 * table produces, so an entry added without one fails there and sends whoever
 * added it here. That list holds fourteen items for these thirteen addresses
 * — `/studio` is both the layout route and its index child.
 */
const ENTRIES: Entry[] = [
  {
    address: () => '/studio',
    module: 'StudioRecentPage',
    // The rail and top bar come from StudioLayout, which is not held back, so
    // the landmark has to be something StudioRecentPage itself renders.
    landed: { text: 'you recently edited or joined' },
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
    // behaviour; the chunk is fetched either way, and the landmark is the sign
    // -in page it lands on.
    address: () => '/recovery-code',
    module: 'RecoveryCodePage',
    landed: { text: 'Welcome back' },
    redirects: true,
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
    const record: { seen: number; fullScreen: boolean | null } = {
      seen: 0,
      fullScreen: null,
    };
    Object.defineProperty(window, '__loadingScreen', { value: record });
    let onScreen = false;
    const check = (): void => {
      // React keeps suspended content mounted and hides it, so ProtectedRoute's
      // own screen sits in the DOM as `display: none` next to the fallback.
      // Only the one the reader can see counts, and what separates the two here
      // is the box: a `display: none` node has none. That is narrower than the
      // `:visible` locator the assertions use, which also rules out
      // `visibility: hidden` — nothing in this path uses it, and an observer
      // running on every mutation should not be reading computed styles.
      const el = [...document.querySelectorAll('[data-testid="loading-screen"]')].find(
        (node) => {
          const r = (node as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        },
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
 * The studio and project whose ids the parameterised addresses need.
 *
 * The project is the one setup made for this account. The studio it sits in
 * is read from the API rather than clicked out of the interface: this spec is
 * about what the router does, and a broken studio list would otherwise fail it
 * for an unrelated reason.
 * @param page - A signed-in page.
 * @returns A studio slug and the project id inside it.
 * @throws {Error} When the account administers no studio.
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
  return { slug: studio.slug, projectId: smokeProjectId('A', 0) };
}

let shared: BrowserContext;
let landmarks: Landmarks;

// A context per case: module caching is per document, and a case reading a
// chunk an earlier case already fetched would never suspend at all.
test.beforeEach(async ({ browser }: { browser: Browser }) => {
  shared = await browser.newContext({ storageState: STATE_FILE.A });
  const page = await shared.newPage();
  landmarks = await findLandmarks(page);
  await page.close();
});

test.afterEach(async () => {
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
      // One appearance, not two: ProtectedRoute's wait and the Suspense
      // fallback are the same component and React hands over between them
      // without the screen leaving, which is A4's "continuous".
      //
      // An entry that redirects makes a second navigation, and whether the
      // screen blinks between the two is React's scheduling, not something
      // A4 promises either way. Pinning the number it happens to produce
      // would make this case go red over a frame nobody asked about, so it
      // only has to have appeared — the other four assertions still hold.
      if (entry.redirects === true) {
        expect(record.seen, `${address} never showed the loading screen`).toBeGreaterThan(
          0,
        );
      } else {
        expect(
          record.seen,
          `${address} showed the loading screen ${record.seen} times`,
        ).toBe(1);
      }
      expect(pageErrors, `${address} threw:\n${pageErrors.join('\n')}`).toEqual([]);
    } finally {
      await page.close();
    }
  });
}
