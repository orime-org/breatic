// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect, type Locator, type Page } from 'playwright/test';

import { visibleSpace } from './space';

/**
 * Whether two elements on screen share any area.
 * @param a - One element.
 * @param b - The other.
 * @returns True when they overlap.
 */
export async function overlapping(a: Locator, b: Locator): Promise<boolean> {
  const [one, two] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (one === null || two === null) return false;
  return one.x < two.x + two.width && two.x < one.x + one.width && one.y < two.y + two.height && two.y < one.y + one.height;
}

/**
 * Wait until the open canvas panel is clear of the viewport toolbar and the
 * minimap floating over the canvas, and inside the canvas pane (inner#1345).
 * @param page - The page.
 */
export async function expectPanelInView(page: Page): Promise<void> {
  const panel = page.locator('[data-canvas-panel]');
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  await expect
    .poll(async () => {
      const box = await panel.boundingBox();
      return (box?.y ?? 0) + (box?.height ?? 0);
    }, { timeout: 5_000 })
    .toBeLessThanOrEqual((pane?.y ?? 0) + (pane?.height ?? 0));
  await expect.poll(() => overlapping(panel, page.getByTestId('viewport-toolbar')), { timeout: 5_000 }).toBe(false);
  await expect.poll(() => overlapping(panel, visibleSpace(page).locator('.react-flow__minimap')), { timeout: 5_000 }).toBe(false);
}

/**
 * Wait until every node on the open canvas, with the name row above it, is
 * inside the canvas pane (inner#1345).
 * @param page - The page.
 * @param count - How many nodes, groups aside, the canvas holds.
 */
export async function expectNodesInView(page: Page, count: number): Promise<void> {
  const nodes = visibleSpace(page).locator('.react-flow__node:not(.react-flow__node-group)');
  await expect(nodes).toHaveCount(count, { timeout: 5_000 });
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  if (!pane) throw new Error('the canvas pane is not on screen');
  await expect
    .poll(async () => {
      const boxes = await Promise.all(
        (await nodes.locator('[data-testid="node-header-anchor"]').all()).map((name) => name.boundingBox()),
      );
      const cards = await Promise.all((await nodes.all()).map((node) => node.boundingBox()));
      return [...boxes, ...cards].every(
        (b) => b !== null && b.x >= pane.x && b.y >= pane.y && b.x + b.width <= pane.x + pane.width && b.y + b.height <= pane.y + pane.height,
      );
    }, { timeout: 5_000 })
    .toBe(true);
}
