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
 * membership is removed again while tearing down. Setup registers that
 * account and records it, so nothing here asks for credentials.
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

import { credentialsFor } from '../helpers/credentials';
import { wavBytes } from '../helpers/media-bytes';
import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR } from '../helpers/space';

/** The second account's address, which is who the invite names. */
const emailB = credentialsFor('B').email;

const ROW = 'a row a viewer may read but not touch';
const CELL = 'a cell a viewer may read';

let ownerContext: BrowserContext;
let viewerContext: BrowserContext;
let owner: Page;
let viewer: Page;
let projectUrl: string;
let spaceId: string | undefined;

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
    .filter({ hasText: emailB })
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

// Both cases work on the same membership, and granting one is a write the
// next case would otherwise find already made.
test.beforeEach(async ({ browser }) => {
  ownerContext = await browser.newContext({
    storageState: STATE_FILE.A,
    viewport: { width: 1680, height: 950 },
  });
  owner = await ownerContext.newPage();
  await openSmokeProject(owner);
  projectUrl = owner.url();

  spaceId = await createSpace(owner, 'document', `viewer-${Date.now()}`);
  const editor = owner.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await owner.keyboard.type(ROW);
  // A table under the row, pasted the way a reader pastes one (inner#1126 A18).
  await owner.keyboard.press('Enter');
  await owner.evaluate(([selector, words]) => {
    const transfer = new DataTransfer();
    transfer.setData('text/html', `<table><tbody><tr><td>${words}</td><td>b1</td></tr></tbody></table>`);
    document.querySelector(selector)!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, [EDITOR, CELL] as const);
  await expect(owner.locator(`${EDITOR} table`)).toHaveCount(1);

  // A fresh membership every run, so the invite is never refused for somebody
  // who is already in.
  await removeTheViewer(owner);

  await owner.getByRole('button', { name: 'Invite' }).click();
  await expect(owner.getByTestId('share-popover')).toBeVisible({
    timeout: 10_000,
  });
  await owner.getByTestId('share-invite-input').fill(emailB);
  await owner.getByTestId('share-send-invite').click();
  // A sent invite closes the popover; the invitee answers it from the bell.
  await expect(owner.getByTestId('share-popover')).toBeHidden({ timeout: 15_000 });

  viewerContext = await browser.newContext({
    storageState: STATE_FILE.B,
    viewport: { width: 1680, height: 950 },
  });
  viewer = await viewerContext.newPage();
  await viewer.goto(new URL('/studio', projectUrl).toString());
  await viewer.getByTestId('bell-trigger').click();
  const openInvite = viewer.locator('[data-testid^="bell-open-decision-"]').first();
  await expect(openInvite).toBeVisible({ timeout: 15_000 });
  await openInvite.click();
  const accept = viewer.getByRole('button', { name: 'Accept' });
  await expect(accept).toBeVisible({ timeout: 15_000 });
  await accept.click();
  await expect(accept).toHaveCount(0, { timeout: 15_000 });

  // The owner's page asks for the roster when it loads and holds the answer,
  // so an acceptance that happened on another page is not on it yet. Measured
  // 2026-09-20: the whole run made one `GET /members`, before the invite went
  // out, and the reading below found a roster of one. A reader in this spot
  // reloads; so does this.
  await owner.reload();

  // The membership that now stands is the viewer's, read off the owner's own
  // roster. Without this the case below could be measuring some other role.
  await expectTheViewerRole(owner);

  await viewer.goto(projectUrl);
  await expect(viewer.getByTestId('space-drawer-trigger')).toBeVisible({
    timeout: 20_000,
  });
});

test.afterEach(async () => {
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

test('a viewer reads a table and gets none of its controls, nor can type in it', async () => {
  await openTheSpace(viewer);
  const cell = viewer.locator(`${EDITOR} td`).filter({ hasText: CELL });
  await expect(cell).toHaveCount(1, { timeout: 20_000 });

  const box = await cell.boundingBox();
  if (box === null) throw new Error('the cell has no box');
  await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await cell.click();
  await viewer.keyboard.type('x');
  // The same wait the strip gets above, for controls that would be coming.
  await viewer.waitForTimeout(500);

  await expect(viewer.getByTestId(/^doc-table-(row|col)-handle$|^doc-table-cell-button$/)).toHaveCount(0);
  await expect(viewer.getByTestId('doc-block-table-handle')).toHaveCount(0);
  await expect(cell).toHaveText(CELL);
});

test('a viewer sees a picture the owner added, and none of its controls (inner#1127 A11, A13)', async () => {
  await openTheSpace(owner);
  await owner.locator(EDITOR).click();
  const png = await owner.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 120;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = `hsl(${Date.now() % 360} 60% 50%)`;
    ctx.fillRect(0, 0, 240, 120);
    const blob = await new Promise<Blob>((done) => {
      canvas.toBlob((b) => done(b!), 'image/png');
    });
    let out = '';
    new Uint8Array(await blob.arrayBuffer()).forEach((byte) => {
      out += String.fromCharCode(byte);
    });
    return btoa(out);
  });
  await owner.locator(EDITOR).evaluate((element, base64) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    transfer.items.add(new File([bytes], 'shared.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, png);
  await expect(owner.locator(`${EDITOR} [data-content-type="image"] img`)).toBeVisible({ timeout: 60_000 });

  await openTheSpace(viewer);
  const img = viewer.locator(`${EDITOR} [data-content-type="image"] img`);
  await expect(img).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => img.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(240);

  await img.hover();
  await viewer.waitForTimeout(500);
  await expect(viewer.getByTestId('doc-media-toolbar')).toBeHidden();
  await expect(viewer.getByTestId('doc-media-resize-se')).toHaveCount(0);
});

test('a viewer plays an audio the owner added, and files pasted or dropped do nothing (inner#1127 A11)', async () => {
  await openTheSpace(owner);
  await owner.locator(EDITOR).click();
  await owner.locator(EDITOR).evaluate((element, b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], 'shared.wav', { type: 'audio/wav' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, wavBytes().toString('base64'));
  await expect(owner.locator(`${EDITOR} [data-content-type="audio"] audio`)).toHaveCount(1, { timeout: 60_000 });

  await openTheSpace(viewer);
  const audio = viewer.locator(`${EDITOR} [data-content-type="audio"]`);
  await expect(audio).toBeVisible({ timeout: 20_000 });
  await audio.getByTestId('play-toggle').click();
  await expect.poll(() => audio.locator('audio').evaluate((element) => (element as HTMLAudioElement).paused)).toBe(false);

  const before = await viewer.locator(`${EDITOR} .bn-block-content`).count();
  await viewer.locator(EDITOR).evaluate((element) => {
    const make = (): DataTransfer => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(8)], 'x.png', { type: 'image/png' }));
      return transfer;
    };
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: make() }));
    const box = element.getBoundingClientRect();
    const at = { clientX: box.left + 20, clientY: box.top + 10 };
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: make(), ...at }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: make(), ...at }));
  });
  await viewer.waitForTimeout(1000);
  await expect(viewer.locator('[data-testid="doc-upload-placeholder"]')).toHaveCount(0);
  await expect(viewer.locator(`${EDITOR} .bn-block-content`)).toHaveCount(before);
});

/**
 * Set the second account's role from the owner's roster.
 * @param page - The owner's page, inside the project.
 * @param role - The role's label as the roster shows it.
 */
async function setTheRole(page: Page, role: 'Editor' | 'Viewer'): Promise<void> {
  const { modal, row } = await openTheRoster(page);
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  const memberId = ((await row.getAttribute('data-testid')) ?? '').replace('members-modal-row-', '');
  await page.getByTestId(`members-modal-role-${memberId}`).click();
  await page.getByRole('option', { name: role }).click();
  await expect(page.getByTestId(`members-modal-role-${memberId}`)).toHaveText(role);
  await closeTheRoster(modal);
}

/**
 * The background the page draws the selection with, on the first row.
 * @param page - The page.
 * @returns The computed colour.
 */
async function selectionColour(page: Page): Promise<string> {
  return page.locator(`${EDITOR} p`).first().evaluate((el) => getComputedStyle(el, '::selection').backgroundColor);
}

test('a viewer selects from blank space beside the column and sees the highlight (inner#1127 A20)', async () => {
  await openTheSpace(viewer);
  const editor = viewer.locator(EDITOR);
  const line = (await viewer.locator(`${EDITOR} p`).first().boundingBox())!;
  const box = (await editor.boundingBox())!;

  await viewer.mouse.move(box.x - 30, line.y + line.height / 2);
  await viewer.mouse.down();
  await viewer.mouse.move(line.x + 80, line.y + line.height / 2, { steps: 6 });
  await viewer.mouse.up();

  expect(await viewer.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  expect(await selectionColour(viewer)).not.toBe('rgba(0, 0, 0, 0)');
  await expect(editor).not.toHaveAttribute('data-body-holds', /.*/);
});

test('a viewer press on blank space beside the column, or between it and the comment rail, clears the highlight (inner#1127 A20)', async () => {
  await openTheSpace(viewer);
  await viewer.getByTestId('doc-doc-menu-trigger').click();
  await viewer.getByTestId('doc-doc-menu-comments').click();
  await expect(viewer.getByTestId('doc-comment-rail')).toBeVisible();
  const editor = viewer.locator(EDITOR);
  const line = (await viewer.locator(`${EDITOR} p`).first().boundingBox())!;
  const box = (await editor.boundingBox())!;
  const rail = (await viewer.getByTestId('doc-comment-rail').boundingBox())!;
  const y = line.y + line.height / 2;

  for (const x of [box.x - 30, (box.x + box.width + rail.x) / 2]) {
    await viewer.mouse.move(line.x + 2, y);
    await viewer.mouse.down();
    await viewer.mouse.move(line.x + 80, y, { steps: 6 });
    await viewer.mouse.up();
    expect(await viewer.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);

    expect(await viewer.evaluate(({ px, py }) => document.elementFromPoint(px, py)?.hasAttribute('data-document-body-blank'), { px: x, py: y })).toBe(true);
    await viewer.mouse.click(x, y);

    expect(await viewer.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
  }
});

test('an editor turned viewer while the body is open still sees the highlight (inner#1127 A20)', async () => {
  await setTheRole(owner, 'Editor');
  await viewer.reload();
  await openTheSpace(viewer);
  const editor = viewer.locator(EDITOR);
  await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
  await viewer.locator(`${EDITOR} p`).first().click();

  await setTheRole(owner, 'Viewer');
  await expect(editor).toHaveAttribute('contenteditable', 'false', { timeout: 20_000 });
  await expect(editor).not.toHaveAttribute('data-body-holds', /.*/);

  const line = (await viewer.locator(`${EDITOR} p`).first().boundingBox())!;
  await viewer.mouse.move(line.x + 2, line.y + line.height / 2);
  await viewer.mouse.down();
  await viewer.mouse.move(line.x + 80, line.y + line.height / 2, { steps: 6 });
  await viewer.mouse.up();
  expect(await viewer.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  expect(await selectionColour(viewer)).not.toBe('rgba(0, 0, 0, 0)');
});
