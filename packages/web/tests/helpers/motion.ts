// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
  return page.locator('[data-radix-popper-content-wrapper]').filter({ has: page.locator('ol > li') });
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
  await expect(aspectField.getByRole('tab', { name: '16:9', exact: true })).toHaveAttribute('aria-selected', 'true');
  if (request.aspect !== undefined && request.aspect !== '16:9') {
    const choice = aspectField.getByRole('tab', { name: request.aspect, exact: true });
    await choice.click();
    await expect(choice).toHaveAttribute('aria-selected', 'true');
  }
  if (request.seconds !== 4) await dialog.getByTestId('web-animation-duration').fill(String(request.seconds));
  await dialog.getByTestId('web-animation-prompt').fill(request.prompt);
  await dialog.getByTestId('web-animation-execute').click();
  await expect(dialog).toHaveCount(0);
  const id = await acceptedRowId(page);
  await expect(outlet.getByTestId('motion-panel-executions').getByTestId(`motion-row-${id}`)).toContainText(request.prompt);
  expect(await previewedId(outlet)).toBe(before);
  return id;
}

/**
 * The execution the shown Motion Space just accepted: the preview keeps what it showed, and the execution list opens on
 * In progress with the new row marked (#1490 design §7.3).
 * @returns The accepted execution's id.
 * @throws {Error} When the list does not open on a marked row in progress.
 */
export async function acceptedRowId(page: Page): Promise<string> {
  const panel = visibleSpace(page).getByTestId('motion-panel-executions');
  await expect(panel.getByRole('tab', { name: /^In progress/ })).toHaveAttribute('aria-selected', 'true');
  const marked = panel.locator('[data-marked="true"]');
  await expect(marked).toHaveCount(1);
  const id = ((await marked.getAttribute('data-testid')) ?? '').replace(/^motion-row-/, '');
  if (id === '') throw new Error('The accepted execution was not marked');
  return id;
}

/**
 * Open the shown Motion Space's execution list on one tab.
 * @param tab - The tab's name.
 * @returns The list.
 * @throws {Error} When the list or the tab is missing.
 */
export async function motionListTab(page: Page, tab: 'Completed' | 'In progress' | 'Failed'): Promise<Locator> {
  const outlet = visibleSpace(page);
  const panel = outlet.getByTestId('motion-panel-executions');
  if (await panel.count() === 0) await outlet.getByTestId('motion-open-executions').click();
  const trigger = panel.getByRole('tab', { name: new RegExp(`^${tab}`) });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-selected', 'true');
  return panel;
}

/**
 * Wait until an execution of the shown Motion Space leaves In progress and is listed under Completed, then open it in
 * the preview; for a web-animation source wait until its page has drawn the frame the bar is on.
 * @param result - Whether the execution yields a web-animation source or an exported video.
 * @throws {Error} When it fails, is cancelled, does not finish within one run, or its page never draws.
 */
export async function waitMotionFinished(page: Page, executionId: string, result: 'source' | 'video' = 'source'): Promise<void> {
  const outlet = visibleSpace(page);
  const running = await motionListTab(page, 'In progress');
  await expect(running.getByTestId(`motion-row-${executionId}`)).toHaveCount(0, { timeout: MOTION_RUN_MS });
  const failed = await motionListTab(page, 'Failed');
  await expect(failed.getByTestId(`motion-row-${executionId}`), `execution ${executionId} did not succeed`).toHaveCount(0);
  const completed = await motionListTab(page, 'Completed');
  await completed.getByTestId(`motion-row-${executionId}`).click();
  const preview = outlet.locator(`[data-testid="motion-preview"][data-execution-id="${executionId}"]`);
  await expect(preview).toBeVisible();
  if (result === 'source') {
    await expect(preview.locator('hyperframes-player'), `the result of ${executionId} never drew`).toHaveAttribute('data-web-state', 'ready', { timeout: 30_000 });
  } else {
    await expect(preview.locator('video')).toHaveCount(1);
  }
}
