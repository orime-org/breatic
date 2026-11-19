// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The account scripts, opening a canvas and the cheapest press of Generate,
 * for the smoke cases about tier limits (inner#1034, inner#1968).
 *
 * The suite's shared accounts are on `self_hosted`, whose limits nobody
 * reaches, and other cases rely on that, so a case about a tier's limit makes
 * an account of its own with the scripts setup uses and moves it back to
 * `self_hosted` at the end.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { expect, type Page } from 'playwright/test';

import { visibleSpace } from './space';

/** The repository root, where the account scripts run from. */
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * Run one of the suite's account scripts the way setup runs `seed-smoke-account.ts`.
 * @param script - The file under `scripts/`.
 * @param input - What the script reads from stdin.
 * @returns What the script printed.
 * @throws {Error} When the script fails, with what it printed.
 */
export function runScript(script: string, input: object): string {
  try {
    return execFileSync(
      'pnpm',
      ['exec', 'tsx', '--tsconfig', 'packages/server/tsconfig.json', `scripts/${script}`],
      { cwd: REPO_ROOT, input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const said = (err as { stderr?: string }).stderr?.trim() ?? String(err);
    throw new Error(`scripts/${script} failed: ${said.slice(-400)}`);
  }
}

/**
 * Open a project on its one canvas Space.
 * @param page - A page signed in as someone in the project.
 * @param projectId - The project.
 * @returns The canvas Space's id.
 */
export async function openCanvas(page: Page, projectId: string): Promise<string> {
  await page.goto(`/project/${projectId}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const tab = await page.locator('[data-testid^="space-tab-name-"]').first().getAttribute('data-testid');
  const spaceId = (tab ?? '').replace('space-tab-name-', '');
  expect(spaceId).not.toBe('');
  return spaceId;
}

/**
 * Open a node's generate panel, set the panel's default model to its cheapest
 * settings (low quality, 1K, docs/TEST-MANDATE.md 2.2) and press Generate.
 * @param page - The project page.
 * @param nodeId - The empty image node.
 */
export async function pressGenerate(page: Page, nodeId: string): Promise<void> {
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  const box = await node.boundingBox();
  if (box === null) throw new Error(`node ${nodeId} has no box`);
  await node.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.x + box.width / 2, clientY: box.y + 8 });
  await page.getByTestId('node-menu-generate').click();
  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('A red apple on a white table');
  const ratio = page.getByTestId('generate-ratio-trigger');
  await ratio.click();
  await page.getByTestId('generate-resolution-option-1k').click();
  await page.getByTestId('generate-param-quality-option-low').click();
  await ratio.click();
  await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);
  await expect(ratio).toContainText('Low');
  const execute = page.getByTestId('generate-execute');
  await expect(execute).toBeEnabled({ timeout: 20_000 });
  await execute.click();
}
