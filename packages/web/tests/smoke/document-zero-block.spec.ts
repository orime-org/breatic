// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

// Desktop-web is the only supported platform, and below ~1280px the studio
// sidebar collapses to icons whose buttons lose their accessible names.
test.use({ viewport: { width: 1680, height: 950 } });

const createdSpaceIds: string[] = [];

test.afterEach(async ({ page }) => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
});

test('a zero-block document takes typing, survives a confirmed clear, and takes typing again', async ({ page }) => {
  // Sign in.
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });

  // Reuse whichever Project the account already has — this spec is about the
  // document body, and creating one per run both burns the tier's
  // projects-per-studio allowance (measured: the API answers 409 once the
  // ceiling is reached) and leaves a trail in the dev database. The Space
  // created below is what gives each run its fresh zero-block document.
  await page.goto('/studio');
  const firstProject = page.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await page.waitForURL(/\/project\//, { timeout: 15_000 });

  // A fresh Document Space.
  createdSpaceIds.push(
    await createSpace(page, 'document', `zero-block-e2e-${Date.now()}`),
  );

  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 15_000 });

  // C3 proper: focus WITHOUT clicking (a click opens a block by itself and
  // would test a different row of the table), then type into zero blocks.
  // The empty-state marker is the deterministic "document is bound and
  // resting at zero blocks" signal.
  await expect(editor).toHaveClass(/doc-body-empty/);

  // Wait for the new-Space dialog to finish handing focus back to its trigger
  // button before taking it. That hand-back is Radix's own restore and it
  // lands asynchronously, ~100ms after the editor appears; anything this spec
  // does before it happens gets taken back, and the keystrokes then go to the
  // button while the document never changes. Instrumented over twelve runs,
  // that race produced three different-looking failures — no confirmation
  // dialog, a silent tier-one deletion, a keypress with no effect at all —
  // all from the one missed keystroke. A person never meets it: they reach
  // the document by clicking into it, long after the restore is done.
  //
  // Waiting for the restore, rather than re-focusing until one attempt
  // sticks, is what makes the race impossible instead of unlikely: a poll
  // only proves focus was held at the instant it sampled.
  await expect(page.getByTestId('new-space-button')).toBeFocused();
  await editor.evaluate((el) => (el as HTMLElement).focus());
  await expect(editor).toBeFocused();
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
