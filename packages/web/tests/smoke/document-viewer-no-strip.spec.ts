// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A3: a viewer gets no block strip.
 *
 * Every command off the strip writes to the document, so a reader who is only
 * allowed to read must not be able to reach it. The gate is one line —
 * `DocumentEditor.tsx` mounts `DocumentBlockControls` only when `readOnly` is
 * false — and a jsdom case already pins that line
 * (`document-block-controls-gate.test.tsx`). What jsdom cannot reach is the
 * chain in front of it: a project role becomes `isViewer` in `ProjectPage`,
 * which becomes `readOnly` on `SpaceOutlet`, which reaches the editor. This
 * case walks that chain with two real accounts.
 *
 * It needs a second account because the role is a real membership: the owner
 * invites the second account as a viewer, the second account accepts, and the
 * membership is removed again while tearing down. `SMOKE_EMAIL_B` /
 * `SMOKE_PASSWORD_B` name that account; without them the case skips.
 *
 * THE POSITIVE CONTROL IS THE POINT. "No handle appeared" is also what a
 * pointer aimed at the wrong pixel produces, so the same gesture at the same
 * coordinates is made on the owner's page, where the handle must appear. One
 * assertion without the other proves nothing.
 *
 * WHAT THIS CANNOT ATTRIBUTE. A real viewer's editor is also not editable, and
 * the library declines to answer a pointer on a non-editable editor
 * (`SideMenu.ts:220`) — so for a viewer there are two independent reasons no
 * handle appears, and taking our gate away would not turn this case red. What
 * is verified here is the outcome for a real viewer role, end to end; that our
 * own gate is the one holding is the jsdom case's job, and it is mutation-
 * proven there. Hence the role check in the fixture: without it this case
 * could pass with the second account holding some other role whose connection
 * happened to be read-only, and the word "viewer" in its name would be false.
 */
import { test, expect, type Page, type BrowserContext } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;
const emailB = process.env.SMOKE_EMAIL_B;
const passwordB = process.env.SMOKE_PASSWORD_B;

test.skip(
  !email || !password || !emailB || !passwordB,
  'SMOKE_EMAIL / SMOKE_PASSWORD / SMOKE_EMAIL_B / SMOKE_PASSWORD_B not set',
);
test.describe.configure({ mode: 'serial' });

const EDITOR = '[data-testid="document-space"] .ProseMirror';
const ROW = 'a row a viewer may read but not touch';

let ownerContext: BrowserContext;
let viewerContext: BrowserContext;
let owner: Page;
let viewer: Page;
let projectUrl: string;
let spaceId: string | undefined;

/**
 * Sign a page in.
 * @param page - The page to sign in.
 * @param who - The address to sign in as.
 * @param secret - That account's password.
 */
async function signIn(page: Page, who: string, secret: string): Promise<void> {
  await page.goto('/login');
  await page.locator('#login-email').fill(who);
  await page.locator('#login-password').fill(secret);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
}

/**
 * Open the member roster and hand back the second account's row.
 * @param page - The owner's page, inside the project.
 * @returns The modal and the row, which may hold nothing.
 */
async function openTheRoster(
  page: Page,
): Promise<{ modal: ReturnType<Page['getByTestId']>; row: ReturnType<Page['getByTestId']> }> {
  await page.getByTestId('members-trigger').click();
  await expect(page.getByTestId('members-popover')).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId('members-manage-trigger').click();
  const modal = page.getByTestId('members-modal');
  await expect(modal).toBeVisible({ timeout: 10_000 });

  const row = modal
    .locator('[data-testid^="members-modal-row-"]')
    .filter({ hasText: emailB as string })
    .first();
  return { modal, row };
}

/**
 * Shut the roster through its own Close control.
 *
 * Not Escape: measured, Escape leaves this dialog standing, and its overlay
 * then swallows every later click on the page — including the Space drawer's
 * trigger, which is how the first run lost its own teardown.
 * @param modal - The roster dialog.
 */
async function closeTheRoster(
  modal: ReturnType<Page['getByTestId']>,
): Promise<void> {
  await modal.getByRole('button', { name: 'Close' }).click();
  await expect(modal).toHaveCount(0, { timeout: 10_000 });
}

/**
 * Remove the second account from the open project, if it is a member.
 *
 * Runs before the invite as well as after the case: an invite is refused for
 * somebody who is already in, and the account is shared with other specs.
 * @param page - The owner's page, inside the project.
 */
async function removeTheViewer(page: Page): Promise<void> {
  const { modal, row } = await openTheRoster(page);
  if ((await row.count()) > 0) {
    const testId = await row.getAttribute('data-testid');
    const memberId = (testId ?? '').replace('members-modal-row-', '');
    await page.getByTestId(`members-modal-remove-${memberId}`).click();
    await expect(page.getByTestId('members-modal-remove-confirm')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('members-modal-remove-confirm-action').click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
  }
  await closeTheRoster(modal);
}

/**
 * Read the second account's role off the roster and insist it is the viewer.
 * @param page - The owner's page, inside the project.
 * @throws {Error} When the roster holds no row for that account.
 */
async function expectTheViewerRole(page: Page): Promise<void> {
  const { modal, row } = await openTheRoster(page);
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  const testId = await row.getAttribute('data-testid');
  if (testId === null) throw new Error('the roster row carries no id');
  const memberId = testId.replace('members-modal-row-', '');
  await expect(page.getByTestId(`members-modal-role-${memberId}`)).toHaveText(
    'Viewer',
  );
  await closeTheRoster(modal);
}

/**
 * Open the Space this case works in, on the page given.
 * @param page - A page already inside the project.
 */
async function openTheSpace(page: Page): Promise<void> {
  await page.getByTestId(`space-tab-name-${String(spaceId)}`).click();
  await expect(page.locator(EDITOR)).toBeVisible({ timeout: 20_000 });
}

/**
 * Hover the middle of the first row and say whether a handle turned up.
 * @param page - The page to make the gesture on.
 * @returns How many handles stand after the gesture.
 */
async function handlesAfterHover(page: Page): Promise<number> {
  const row = await page.locator(`${EDITOR} .bn-block-content`).first().boundingBox();
  if (row === null) throw new Error('the row has no box');
  await page.mouse.move(row.x + 40, row.y + row.height / 2);
  // Give the strip the same chance to appear in both readings: the library
  // answers a pointer move synchronously, and the owner's case below proves
  // this wait is long enough for a handle that is coming.
  await page.waitForTimeout(500);
  return page.getByTestId('doc-block-handle').count();
}

test.beforeAll(async ({ browser }) => {
  ownerContext = await browser.newContext({
    viewport: { width: 1680, height: 950 },
  });
  owner = await ownerContext.newPage();
  await signIn(owner, email as string, password as string);

  await owner.goto('/studio');
  const firstProject = owner.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await owner.waitForURL(/\/project\//, { timeout: 15_000 });
  projectUrl = owner.url();

  spaceId = await createSpace(owner, 'document', `viewer-${Date.now()}`);
  const editor = owner.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await owner.keyboard.type(ROW);

  // A fresh membership every run, so the invite is never refused for somebody
  // who is already in.
  await removeTheViewer(owner);

  await owner.getByRole('button', { name: 'Invite' }).click();
  await expect(owner.getByTestId('share-popover')).toBeVisible({
    timeout: 10_000,
  });
  await owner.getByTestId('share-invite-input').fill(emailB as string);
  await owner.getByTestId('share-send-invite').click();
  const inviteUrl = await owner
    .getByTestId('share-invite-url')
    .inputValue({ timeout: 15_000 });
  await owner.keyboard.press('Escape');

  viewerContext = await browser.newContext({
    viewport: { width: 1680, height: 950 },
  });
  viewer = await viewerContext.newPage();
  await signIn(viewer, emailB as string, passwordB as string);
  await viewer.goto(inviteUrl);
  const accept = viewer.getByRole('button', { name: 'Accept' });
  await expect(accept).toBeVisible({ timeout: 15_000 });
  await accept.click();
  await expect(accept).toHaveCount(0, { timeout: 15_000 });

  // The membership that now stands is the viewer's, read off the owner's own
  // roster. Without this the case below could be measuring some other role.
  await expectTheViewerRole(owner);

  await viewer.goto(projectUrl);
  await expect(viewer.getByTestId('space-drawer-trigger')).toBeVisible({
    timeout: 20_000,
  });
});

test.afterAll(async () => {
  if (spaceId !== undefined) await deleteSpace(owner, spaceId);
  try {
    await removeTheViewer(owner);
  } catch (err) {
    console.warn('[smoke] could not remove the viewer membership:', err);
  }
  await ownerContext?.close();
  await viewerContext?.close();
});

test('a viewer reads the row and gets no strip beside it', async () => {
  await openTheSpace(viewer);

  // We really are in the body the owner typed into, not a placeholder or an
  // error card — without this the count below could be zero for the wrong
  // reason.
  await expect(viewer.locator(EDITOR)).toContainText(ROW, { timeout: 20_000 });

  expect(await handlesAfterHover(viewer)).toBe(0);
});

test('the same gesture on the owner page does bring a handle', async () => {
  await openTheSpace(owner);
  await expect(owner.locator(EDITOR)).toContainText(ROW, { timeout: 20_000 });

  expect(await handlesAfterHover(owner)).toBe(1);
});
