// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Document Space zero-block E2E — the browser-only half of the structure
 * ruling (#123, acceptance C3): typing into a zero-block document creates
 * the paragraph through the browser's own text-input path, which no jsdom
 * test can reach; and the highest-frequency flow of the confirmed clear —
 * wipe, then immediately write again — stays typable end to end.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 *
 * Skips itself when the credentials are absent, so an unconfigured checkout
 * still passes the suite. The account and password live outside the repo on
 * purpose; registration is rate-limited, so reuse the standing smoke account
 * rather than minting one per run.
 */
import { test, expect } from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

// Desktop-web is the only supported platform, and below ~1280px the studio
// sidebar collapses to icons whose buttons lose their accessible names.
test.use({ viewport: { width: 1680, height: 950 } });

test('a zero-block document takes typing, survives a confirmed clear, and takes typing again', async ({ page }) => {
  // Sign in.
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });

  // A fresh Project per run: every step after this starts from the empty
  // seed, whatever earlier runs left behind. By test id — the rail collapses
  // to icons, and a collapsed row's button has no accessible name.
  await page.goto('/studio');
  await page.getByTestId('rail-create-project').click();
  const dialog = page.getByTestId('new-project-dialog');
  const unique = `zero-block-e2e-${Date.now()}`;
  await dialog.getByRole('textbox').nth(0).fill(unique);
  // The slug is required and not derived from the name (#82 tracks the
  // unhelpful message an empty one gets).
  await dialog.getByRole('textbox').nth(1).fill(unique);
  await dialog.locator('button[type="submit"]').click();
  await page.waitForURL(/\/project\//, { timeout: 15_000 });

  // A fresh Document Space.
  await page.getByTestId('new-space-button').click();
  await page.getByTestId('new-space-type-document').click();
  await page.getByTestId('new-space-name').fill('doc');
  await page.getByTestId('new-space-submit').click();

  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 15_000 });

  // C3 proper: focus WITHOUT clicking (a click opens a block by itself and
  // would test a different row of the table), then type into zero blocks.
  // The empty-state marker is the deterministic "document is bound and
  // resting at zero blocks" signal — no bare sleep.
  await expect(editor).toHaveClass(/doc-body-empty/);
  await editor.evaluate((el) => (el as HTMLElement).focus());
  await page.keyboard.type('first words');
  await expect(editor).toHaveText('first words');

  // The confirmed clear, then the immediate rewrite.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press('Backspace');
  const confirm = page.getByTestId('document-clear-confirm');
  await expect(confirm).toBeVisible();
  await page.getByTestId('document-clear-confirm-action').click();
  await expect(confirm).not.toBeVisible();
  await expect(editor).toHaveText('');

  // Straight back to writing — no click in between.
  await page.keyboard.type('reborn');
  await expect(editor).toHaveText('reborn');
});
