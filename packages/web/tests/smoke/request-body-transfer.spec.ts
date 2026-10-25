// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Bodies over the request limit travel as transfers (inner#1006 SM1–SM3).
 *
 * The API reads at most 1 MiB of any request. Pasting a node, keeping a
 * snapshot and sending a chat message can carry more, so the page uploads
 * such a body to storage first and sends `{"transfer":"<key>"}` in its place;
 * the server reads it back and the route runs on the original. What only a
 * real app shows is that the result is the same as for a small body: the
 * pasted node holds the same words, the snapshot lands in history, the chat
 * reply comes back. The words open with `<svg` because the ingest Worker
 * judges stored bytes by their content, and a transfer must not be taken for
 * a picture.
 *
 * Needs a running dev stack with the ingest Worker that knows the transfer
 * format, storage, and (SM3) a model provider:
 *
 *   pnpm --filter @breatic/web test:smoke:all
 */
import { randomUUID } from 'node:crypto';

import { expect } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import {
  CHAT_MESSAGE,
  PASTE,
  SNAPSHOT,
  TRANSFER_REFERENCE,
  TRANSFER_TICKET,
  addTextNode,
  copyAndPaste,
  historyOf,
  keepSnapshot,
  nodeIds,
  outline,
  recordPage,
  sentTo,
  textOf,
} from '../helpers/request-bodies';
import { DOCUMENT_EDITOR, createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { startNewConversation } from '../helpers/conversation';

test.use({ viewport: { width: 1500, height: 900 } });

/**
 * A text node's words over the limit: about 1.2 MB once encoded, opening with
 * markup the Worker would otherwise read as a picture.
 */
const LARGE_WORDS = `<svg onload=1>&${'中'.repeat(400_000)}`;

/** Error toasts on screen. */
const ERROR_TOAST = '[data-sonner-toast][data-type="error"]';

test('SM1 pasting a 1.2 MB text node that opens with <svg sends a transfer and pastes the same words @needs-ingest @needs-storage', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const record = recordPage(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'canvas', `transfer-paste-${Date.now()}`);
  try {
    await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
    const original = randomUUID();
    await addTextNode(page, { projectId, spaceId, nodeId: original }, LARGE_WORDS);
    expect(Buffer.byteLength(LARGE_WORDS)).toBeGreaterThan(1_048_576);
    const before = await nodeIds(page, projectId, spaceId);

    const pasted = page.waitForResponse((r) => new URL(r.url()).pathname === PASTE && r.request().method() === 'POST', {
      timeout: 120_000,
    });
    await copyAndPaste(page, original);
    const answer = await pasted;

    expect(answer.status()).toBe(200);
    expect(answer.request().postData()).toMatch(TRANSFER_REFERENCE);
    const tickets = sentTo(record, TRANSFER_TICKET);
    expect(tickets.map((r) => [r.method, r.status])).toEqual([['POST', 201]]);

    await expect.poll(async () => (await nodeIds(page, projectId, spaceId)).length, { timeout: 20_000 }).toBe(before.length + 1);
    const copy = (await nodeIds(page, projectId, spaceId)).find((id) => !before.includes(id)) ?? '';
    const want = outline(LARGE_WORDS);
    expect(outline(await textOf(page, { projectId, spaceId, nodeId: original }))).toEqual(want);
    expect(outline(await textOf(page, { projectId, spaceId, nodeId: copy }))).toEqual(want);
    await expect
      .poll(async () => (await historyOf(page, projectId, copy)).map((e) => outline(e.content ?? '')), { timeout: 10_000 })
      .toEqual([want]);

    await expect(page.locator(ERROR_TOAST)).toHaveCount(0);
    expect(record.consoleErrors).toEqual([]);
    expect(record.pageErrors).toEqual([]);
    await test.info().attach('requests.json', {
      body: Buffer.from(JSON.stringify(record.requests, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('SM2 keeping a 1.2 MB snapshot sends a transfer and adds the words to history @needs-ingest @needs-storage', async ({ page }) => {
  const record = recordPage(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'canvas', `transfer-snapshot-${Date.now()}`);
  try {
    await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
    const nodeId = randomUUID();
    await addTextNode(page, { projectId, spaceId, nodeId }, LARGE_WORDS);
    expect(await historyOf(page, projectId, nodeId)).toEqual([]);

    const kept = page.waitForResponse((r) => new URL(r.url()).pathname === SNAPSHOT && r.request().method() === 'POST', {
      timeout: 120_000,
    });
    await keepSnapshot(page, nodeId);
    const answer = await kept;

    expect(answer.status()).toBe(201);
    expect(answer.request().postData()).toMatch(TRANSFER_REFERENCE);
    expect(sentTo(record, TRANSFER_TICKET).map((r) => [r.method, r.status])).toEqual([['POST', 201]]);
    // The same toast a small snapshot gets.
    await expect(page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: 'Snapshot kept' })).toBeVisible();

    const want = outline(LARGE_WORDS);
    expect((await historyOf(page, projectId, nodeId)).map((e) => [e.entryType, outline(e.content ?? '')])).toEqual([
      ['snapshot', want],
    ]);
    await visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`).click({ button: 'right' });
    await page.getByTestId('node-menu-history').click();
    await expect(page.getByTestId('node-history-row')).toHaveCount(1, { timeout: 20_000 });

    await expect(page.locator(ERROR_TOAST)).toHaveCount(0);
    expect(record.consoleErrors).toEqual([]);
    expect(record.pageErrors).toEqual([]);
    await test.info().attach('requests.json', {
      body: Buffer.from(JSON.stringify(record.requests, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('SM3 a chat message with a large attachment and a large open document goes as a transfer and is answered @needs-ingest @needs-storage @needs-model', async ({ page }) => {
  test.setTimeout(300_000); // A transfer upload and a real model reply in one case.
  const record = recordPage(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'document', `transfer-chat-${Date.now()}`);
  try {
    // An open document Space of 90 000 characters, pasted into its body the
    // way a reader pastes a long text.
    const documentWords = '中'.repeat(90_000);
    const editor = page.locator(DOCUMENT_EDITOR);
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('new-space-button')).toBeFocused();
    await editor.click();
    await expect(editor).toBeFocused();
    await page.evaluate(([selector, text]) => {
      const box = document.querySelector(selector);
      if (box === null) throw new Error('no document body');
      const data = new DataTransfer();
      data.setData('text/plain', text);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, [DOCUMENT_EDITOR, documentWords] as const);
    await expect.poll(async () => (await editor.innerText()).replace(/\s/g, '').length, { timeout: 30_000 }).toBe(90_000);

    // A text attachment of 190 000 characters; one alone stays within the
    // attachment cap, the two together pass 1 MiB.
    await startNewConversation(page);
    await page.getByTestId('chat-composer-file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('中'.repeat(190_000), 'utf-8'),
    });
    await expect(page.getByTestId('chat-composer-chips').locator('[data-status]')).toHaveAttribute('data-status', 'ready', {
      timeout: 20_000,
    });

    // Hold the ticket until the composer has been seen waiting, then let it
    // through to the real server.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**${TRANSFER_TICKET}`, async (route) => {
      await held;
      await route.continue();
    });
    const sent = page.waitForResponse((r) => new URL(r.url()).pathname === CHAT_MESSAGE && r.request().method() === 'POST', {
      timeout: 120_000,
    });
    await page.getByTestId('chat-composer-box').fill('Reply with exactly the word OK.');
    await page.getByTestId('chat-composer-box').press('Enter');
    await expect(page.getByTestId('chat-composer-sending')).toBeVisible({ timeout: 20_000 });
    release();
    const answer = await sent;

    expect(answer.status()).toBe(200);
    expect(answer.request().postData()).toMatch(TRANSFER_REFERENCE);
    expect(sentTo(record, TRANSFER_TICKET).map((r) => [r.method, r.status])).toEqual([['POST', 201]]);
    const abort = page.getByTestId('chat-composer-abort');
    await expect(abort).toHaveCount(0, { timeout: 180_000 });
    await expect(page.locator('[data-testid="markdown-body"]').last()).toHaveText(/^OK[.!]?$/i, { timeout: 20_000 });
    await expect(page.getByTestId('message-bubble-error')).toHaveCount(0);

    await expect(page.locator(ERROR_TOAST)).toHaveCount(0);
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Network error' })).toHaveCount(0);
    expect(record.consoleErrors).toEqual([]);
    expect(record.pageErrors).toEqual([]);
    await test.info().attach('requests.json', {
      body: Buffer.from(JSON.stringify(record.requests, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    await page.unroute(`**${TRANSFER_TICKET}`);
    await deleteSpace(page, spaceId);
  }
});
