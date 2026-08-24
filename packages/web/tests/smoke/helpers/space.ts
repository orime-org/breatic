// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Creating and removing the Space a smoke run works in.
 *
 * Every spec below `tests/smoke/` that needs a document or a canvas makes its
 * own Space, because a run must not depend on what an earlier run left behind.
 * That leaves the account's project holding one more Space per test: a full
 * suite adds thirty, and a tier caps how many a project may have
 * (`config/membership.yaml`). So a spec that creates one also removes it, and
 * both halves live here rather than being written out four times.
 *
 * Removal goes through the Space drawer, the same path a person uses. The
 * `space:delete` RPC underneath is authorized and audited server-side, and an
 * ADR (2026-05-23 yjs-collab-only-write-authz) forbids clients from writing
 * `meta.spaces` directly — so reaching into the Yjs document to drop the entry
 * is not an option, however much shorter it would look here.
 */
import { expect, type Page } from 'playwright/test';

export type SpaceKind = 'canvas' | 'document';

/**
 * Create a Space in the open project and return its id.
 *
 * The id comes from the tab the new Space gets: the tab strip renders
 * `space-tab-name-<id>` for each one, and the timestamped name the caller
 * passes in identifies exactly one of them.
 * @param page - A page already inside a project.
 * @param kind - Which Space type to create.
 * @param name - The name to give it; must be unique within the project.
 * @returns The id of the created Space.
 * @throws {Error} When the new Space's tab never appears.
 */
export async function createSpace(
  page: Page,
  kind: SpaceKind,
  name: string,
): Promise<string> {
  await page.getByTestId('new-space-button').click();
  await page.getByTestId(`new-space-type-${kind}`).click();
  await page.getByTestId('new-space-name').fill(name);
  await page.getByTestId('new-space-submit').click();

  const tabName = page
    .locator('[data-testid^="space-tab-name-"]')
    .filter({ hasText: name })
    .first();
  await expect(tabName).toBeVisible({ timeout: 15_000 });
  const testId = await tabName.getAttribute('data-testid');
  if (testId === null) throw new Error(`no id on the tab for "${name}"`);
  return testId.replace('space-tab-name-', '');
}

/**
 * Remove a Space through the drawer.
 *
 * Never throws. A spec calls this while tearing down, often after it has
 * already failed for its own reasons, and a teardown that throws replaces the
 * real failure with its own — leaving a stray Space is the smaller harm. What
 * went wrong is written to the console so a run that quietly stops cleaning up
 * still says so.
 * @param page - A page inside the project that holds the Space.
 * @param spaceId - The id returned by `createSpace`.
 */
export async function deleteSpace(page: Page, spaceId: string): Promise<void> {
  try {
    // Open the drawer only when it is shut. The trigger toggles, so calling
    // this twice in a row on one page — which is what a case creating two
    // Spaces does — would close the drawer the second time and then wait out
    // the timeout looking for it. Measured: 84 removals in a row came out 42
    // done, 42 timed out, strictly alternating.
    const drawer = page.getByTestId('space-drawer');
    if ((await drawer.count()) === 0) {
      await page.getByTestId('space-drawer-trigger').click();
      await expect(drawer).toBeVisible({ timeout: 10_000 });
    }

    // The row's action group is `opacity-0` until the row is hovered, which
    // leaves it visible to Playwright and hoverable by the click itself.
    await page.getByTestId(`space-drawer-delete-${spaceId}`).click();
    await expect(
      page.getByTestId(`space-drawer-delete-confirm-${spaceId}`),
    ).toBeVisible({ timeout: 10_000 });
    await page
      .getByTestId(`space-drawer-delete-confirm-action-${spaceId}`)
      .click();

    // The row goes when the collab process broadcasts the deletion back, so
    // its absence is the one signal that the Space is really gone rather than
    // that a button was pressed.
    await expect(page.getByTestId(`space-drawer-row-${spaceId}`)).toHaveCount(
      0,
      { timeout: 15_000 },
    );
    // Shut the drawer through its own Close control, and wait for it to go.
    // Escape does not reliably reach it from here — the row that held focus
    // has just been removed — and a drawer still standing when the next case
    // starts is not inert: leaving it open cost `selection-bubble-bar`'s
    // hover case its background-colour assertion, twice out of two runs,
    // where the same case passes on main.
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toHaveCount(0, { timeout: 10_000 });
  } catch (err) {
    console.warn(`[smoke] could not delete Space ${spaceId}:`, err);
  }
}
