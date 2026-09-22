// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The order a drag produced is the order a reload comes back to (#2165).
 *
 * The strip is painted from the meta document and stored per reader, so the
 * question crosses a real drag, the collab document and browser storage, and
 * only a reload of a real page asks it.
 *
 * What a drag does to the strip before any reload is in
 * `tests/visual/space-tab-reorder.spec.ts`; both files take their strip and
 * their two moves from `tests/helpers/tab-strip.ts`.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { expect, test } from 'playwright/test';

import { dragTabOnto, tabOrder } from '../helpers/tab-strip';

test('reopening the project comes back to the order the drag produced', async ({
  page,
}) => {
  // The drag is part of the question rather than a precondition somebody else
  // left: it is the only way to produce an order that is not the landing one,
  // and an order that matches the landing one would pass without the strip
  // having been remembered at all.
  const landed = await tabOrder(page);
  expect(landed.length).toBeGreaterThanOrEqual(3);
  await dragTabOnto(page, landed[1] as string, landed[0] as string);

  const before = await tabOrder(page);
  expect(before).not.toEqual(landed);

  await page.reload();
  await expect(page.locator('[role="tab"]').first()).toBeVisible({
    timeout: 20_000,
  });

  // The same ids in the same places, not just the same count. Polled rather
  // than read once — the strip is painted from the meta document, a moment
  // behind the first tab.
  await expect
    .poll(async () => (await tabOrder(page)).length, { timeout: 10_000 })
    .toBe(before.length);
  expect(await tabOrder(page)).toEqual(before);
});
