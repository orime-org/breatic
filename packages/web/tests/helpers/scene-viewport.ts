// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { Locator, Page } from 'playwright/test';

/**
 * The transform handle under a point of a 3D viewport, after moving the pointer there. The viewport reports the hovered
 * handle from its frame loop, so the report is read once two more frames have been drawn.
 * @param page - The page.
 * @param viewport - The viewport (`three-d-viewport`).
 * @param point - The page point.
 * @returns The handle's axis, or null when no handle answers there.
 */
export async function handleUnder(page: Page, viewport: Locator, point: { x: number; y: number }): Promise<string | null> {
  await page.mouse.move(point.x, point.y);
  await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
  return (JSON.parse(await viewport.getAttribute('data-native-controls') ?? '{}') as { axis: string | null }).axis;
}
