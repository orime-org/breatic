// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Driving a Motion Space (#1490): open a Space by id, make a web animation through the New dialog and wait until it
 * finishes. Specs that make web animations for a Timeline and the Motion Space's own spec share these.
 */
import { expect, type Locator, type Page } from 'playwright/test';

import { visibleSpace } from './space';

/** One real model run, from Execute to a finished result; the design's cap is two hours. */
export const MOTION_RUN_MS = 240_000;

/** What the New dialog is filled with. */
export interface MotionRequest {
  prompt: string;
  /** Whole seconds; the dialog opens on 4. */
  seconds: number;
  /** The dialog opens on 16:9. */
  aspect?: '16:9' | '9:16' | '1:1';
}

/**
 * Bring an existing Space to the front through its tab, or open it from the drawer when it has no tab.
 * @throws {Error} When the Space does not become the one shown.
 */
export async function openSpaceById(page: Page, spaceId: string): Promise<void> {
  const tab = page.getByTestId(`space-tab-name-${spaceId}`);
  if (await tab.count() === 0) {
    await page.getByTestId('space-drawer-trigger').click();
    const drawer = page.getByTestId('space-drawer');
    await expect(drawer).toBeVisible();
    await drawer.getByTestId(`space-drawer-row-${spaceId}`).getByRole('button', { name: /Open/ }).click();
    await expect(drawer).toHaveCount(0);
  } else {
    await tab.click();
  }
  await expect(page.locator(`[data-space-outlet="${spaceId}"]`)).toBeVisible();
}

/**
 * The id of the Space shown in front.
 * @throws {Error} When no Space is shown.
 */
export async function shownSpaceId(page: Page): Promise<string> {
  const id = await visibleSpace(page).getAttribute('data-space-outlet');
  if (id === null || id === '') throw new Error('No Space is shown');
  return id;
}

/**
 * The execution the shown Motion Space previews, or null while it previews none.
 * @throws {Error} When the page cannot be read.
 */
async function previewedId(outlet: Locator): Promise<string | null> {
  const preview = outlet.getByTestId('motion-preview');
  return await preview.count() === 0 ? null : preview.getAttribute('data-execution-id');
}

/**
 * The open popover of the Motion bar's Details button.
 * @throws {never} Never.
 */
export function motionDetails(page: Page): Locator {
  return page.locator('[data-radix-popper-content-wrapper]').filter({ has: page.locator('ol > li[data-mark]') });
}

/**
 * Press New in the shown Motion Space, fill the dialog from its defaults and press Execute.
 * @returns The accepted execution's id, which the preview opens on.
 * @throws {Error} When the dialog, its defaults or the accepted row are not as designed.
 */
export async function executeInMotion(page: Page, request: MotionRequest): Promise<string> {
  const outlet = visibleSpace(page);
  await expect(outlet.getByTestId('motion-space')).toBeVisible();
  const before = await previewedId(outlet);
  await outlet.getByTestId('motion-new').click();
  const dialog = page.getByRole('dialog', { name: 'Create web animation', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('web-animation-engine')).toHaveText('DeepSeek');
  await expect(dialog.getByTestId('web-animation-duration')).toHaveValue('4');
  const aspectField = dialog.getByTestId('web-animation-aspect');
  await expect(aspectField).toHaveText('16:9');
  if (request.aspect !== undefined && request.aspect !== '16:9') {
    await aspectField.click();
    await page.getByRole('option', { name: request.aspect, exact: true }).click();
    await expect(aspectField).toHaveText(request.aspect);
  }
  if (request.seconds !== 4) await dialog.getByTestId('web-animation-duration').fill(String(request.seconds));
  await dialog.getByTestId('web-animation-prompt').fill(request.prompt);
  await dialog.getByTestId('web-animation-execute').click();
  await expect(dialog).toHaveCount(0);
  // The accepted row opens in the preview and the execution list opens on In progress (design §13.2, §13.8).
  await expect.poll(() => previewedId(outlet)).not.toBe(before);
  const id = await previewedId(outlet);
  if (id === null) throw new Error('The accepted execution was not opened');
  const panel = outlet.getByTestId('motion-panel-executions');
  await expect(panel.getByRole('tab', { name: /^In progress/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByTestId(`motion-row-${id}`)).toContainText(request.prompt);
  return id;
}

/**
 * Wait until the shown Motion Space previews an execution that finished and can be played, and for a web-animation
 * source until its page has drawn the frame the bar is on.
 * @param result - Whether the execution yields a web-animation source or an exported video.
 * @throws {Error} When it fails, is cancelled, does not finish within one run, or its page never draws.
 */
export async function waitMotionFinished(page: Page, executionId: string, result: 'source' | 'video' = 'source'): Promise<void> {
  const outlet = visibleSpace(page);
  const preview = outlet.locator(`[data-testid="motion-preview"][data-execution-id="${executionId}"]`);
  await expect(preview).toBeVisible();
  // Play is enabled only on a finished result; Retry shows only on a failed, cancelled or expired one.
  await expect(outlet.locator('[data-testid="motion-retry"], [data-testid="motion-play"]:enabled')).toBeVisible({ timeout: MOTION_RUN_MS });
  await expect(outlet.getByTestId('motion-retry'), `execution ${executionId} did not succeed`).toHaveCount(0);
  if (result === 'source') {
    await expect(preview.locator('hyperframes-player'), `the result of ${executionId} never drew`).toHaveAttribute('data-web-state', 'ready', { timeout: 30_000 });
  } else {
    await expect(preview.locator('video')).toHaveCount(1);
  }
}
