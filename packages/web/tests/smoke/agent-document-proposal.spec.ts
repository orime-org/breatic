// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The Agent's comment, rewrite and insert for a document land when the reader
 * presses their card (inner#1509).
 *
 * The chat answer is served here, so no model is involved. It is built from
 * the message the browser actually sends: the open document's blocks, with
 * their ids and plain text, are read off that request and the proposal names
 * one of them -- so what is under test is the whole path from the document
 * read at the press to the card and back into the document.
 */

import { expect, type Page, type Route } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { openCommentRail } from '../helpers/document-body';
import { openSmokeProject } from '../helpers/project';
import { liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, DOCUMENT_EDITOR, visibleSpace } from '../helpers/space';
import { projectIdOf } from '../helpers/tab-restore';

/** One block of the open document as the message carries it. */
interface SentBlock {
  id: string;
  type: string;
  text: string;
}

/** What the served answer proposes, given the blocks the message carried. */
type Propose = (blocks: SentBlock[], spaceId: string) => Record<string, unknown>;

let page: Page;
const created: string[] = [];

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await openSmokeProject(page);
});

test.afterEach(async () => {
  for (const id of created.splice(0)) await deleteSpace(page, id);
  await page.close();
});

/**
 * A document holding two paragraphs, open and in front.
 * @returns Its Space id.
 */
async function openDocumentWithText(): Promise<string> {
  const id = await createSpace(page, 'document', `doc-proposal-${String(Date.now())}`);
  created.push(id);
  await page.locator(DOCUMENT_EDITOR).click();
  await page.keyboard.type('Scene two opens.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('He pushes the door open and sees her bags packed.');
  return id;
}

/**
 * Turns the open Space on for the Agent, so the message carries the document.
 */
async function sendTheOpenSpace(): Promise<void> {
  const chip = page.getByTestId('chat-composer-space');
  if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
}

/**
 * Answers the next message with a turn proposing what `propose` builds from
 * the blocks that message carried.
 * @param propose - Builds the proposal.
 */
async function answerWith(propose: Propose): Promise<void> {
  await page.route('**/chat/message', async (route: Route) => {
    const sent = route.request().postDataJSON() as { current_space?: { id: string; blocks?: SentBlock[] } };
    const blocks = sent.current_space?.blocks ?? [];
    const output = { placed: true, ...propose(blocks, sent.current_space?.id ?? '') };
    const chunks = [
      { type: 'data-heartbeat', transient: true, data: {} },
      { type: 'data-conversation-titled', data: { title: 'document proposal' } },
      { type: 'start', messageId: 'm-reply' },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'propose_document_edit', input: {} },
      { type: 'tool-output-available', toolCallId: 'call-1', output },
      { type: 'finish-step' },
      { type: 'finish' },
    ];
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''),
    });
  });
}

/**
 * Asks in chat and waits for the card.
 * @returns The card.
 */
async function askForTheCard(): Promise<ReturnType<Page['getByTestId']>> {
  await startNewConversation(page);
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill('Look at the second paragraph.');
  await composer.press('Enter');
  const card = page.getByTestId('document-proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}

/**
 * A proposal on the second block.
 * @param fields - What it says beyond the target.
 * @returns The builder.
 */
function onSecondBlock(fields: Record<string, unknown>): Propose {
  return (blocks, spaceId) => ({
    proposalId: crypto.randomUUID(),
    spaceId,
    spaceName: 'Doc',
    blockId: blocks[1]!.id,
    title: 'Second paragraph',
    heading: '',
    original: blocks[1]!.text,
    blockType: 'paragraph',
    lossy: false,
    ...fields,
  });
}

/**
 * Works the undo stack of a document's editor: how many steps it holds, and
 * optionally takes the last one back first.
 * @param spaceId - The document.
 * @param undo - Whether to take one step back first.
 * @returns How many steps the stack holds afterwards.
 */
async function undoStack(spaceId: string, undo = false): Promise<number> {
  const url = await liveModuleUrl(page, 'spaces/document/document-editor-cache.ts');
  const name = `project-${projectIdOf(page.url())}/document-${spaceId}`;
  return page.evaluate(
    async ([u, n, back]) => {
      type Handle = { undoManager: { undoStack: unknown[]; undo: () => void } };
      const mod = (await import(u)) as { peekDocumentEditor: (key: string) => Handle | undefined };
      const handle = mod.peekDocumentEditor(n);
      if (handle === undefined) return -1;
      if (back) handle.undoManager.undo();
      return handle.undoManager.undoStack.length;
    },
    [url, name, undo] as const,
  );
}

/** The paragraphs of the document in front. */
async function paragraphs(): Promise<string[]> {
  return page.locator(`${DOCUMENT_EDITOR} p`).allTextContents();
}

test('a comment lands on the quoted words, marked as from the Agent', async () => {
  await openDocumentWithText();
  await sendTheOpenSpace();
  await answerWith(onSecondBlock({ kind: 'comment', quote: 'her bags packed', body: 'Why is she leaving?' }));

  const card = await askForTheCard();
  await card.getByRole('button').first().click();

  await expect(card).toHaveAttribute('data-state', 'applied');
  await openCommentRail(page);
  await expect(visibleSpace(page).getByTestId('doc-comment-from-agent')).toBeVisible();
  await expect(visibleSpace(page).getByText('Why is she leaving?')).toBeVisible();
});

test('a rewrite replaces the passage as one undo step', async () => {
  const docId = await openDocumentWithText();
  await sendTheOpenSpace();
  await answerWith(onSecondBlock({ kind: 'rewrite', body: 'He opens the door. Her bags are packed.' }));

  const card = await askForTheCard();
  await expect(card.getByTestId('document-proposal-added').first()).toBeVisible();
  const before = await undoStack(docId);
  await card.getByRole('button').last().click();

  await expect(card).toHaveAttribute('data-state', 'applied');
  await expect.poll(paragraphs).toEqual(['Scene two opens.', 'He opens the door. Her bags are packed.']);
  expect(await undoStack(docId)).toBe(before + 1);

  // "View" only shows the change; it writes nothing.
  await card.getByRole('button').click();
  await expect(card.getByRole('button')).not.toHaveAttribute('aria-busy', 'true');
  expect(await undoStack(docId)).toBe(before + 1);

  await undoStack(docId, true);
  await expect.poll(paragraphs).toEqual(['Scene two opens.', 'He pushes the door open and sees her bags packed.']);
  await expect(card).toHaveAttribute('data-state', 'idle');
});

test('an insert puts a table after the passage, opening the document when another Space is in front', async () => {
  const docId = await openDocumentWithText();
  await sendTheOpenSpace();
  await answerWith((blocks, spaceId) => ({
    ...onSecondBlock({})(blocks, spaceId),
    kind: 'insert',
    body: '| Shot | Size |\n|---|---|\n| 1 | Wide |',
  }));

  const card = await askForTheCard();
  await expect(card.getByTestId('document-proposal-anchor')).toHaveText('He pushes the door open and sees her bags packed.');
  created.push(await createSpace(page, 'canvas', `doc-proposal-canvas-${String(Date.now())}`));
  await expect(visibleSpace(page).getByTestId('document-space')).toHaveCount(0);
  await card.getByRole('button').last().click();

  await expect(card).toHaveAttribute('data-state', 'applied');
  await expect(visibleSpace(page).getByTestId('document-space')).toHaveAttribute('data-space-id', docId);
  const table = page.locator(`${DOCUMENT_EDITOR} table`);
  await expect(table).toBeVisible();
  const box = await table.boundingBox();
  expect(box !== null && box.y >= 0 && box.y + box.height <= 900).toBe(true);
});

test('a passage changed after the proposal is left alone, and a toast says so', async () => {
  await openDocumentWithText();
  await sendTheOpenSpace();
  await answerWith(onSecondBlock({ kind: 'rewrite', body: 'Something else.' }));

  const card = await askForTheCard();
  await page.locator(`${DOCUMENT_EDITOR} p`).last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Then silence.');
  await card.getByRole('button').last().click();

  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'This passage has changed since the proposal.' })).toBeVisible();
  await expect(card).toHaveAttribute('data-state', 'idle');
  await expect.poll(paragraphs).toEqual(['Scene two opens.', 'He pushes the door open and sees her bags packed. Then silence.']);
});

test('a card whose document was deleted says so in a toast and writes nothing', async () => {
  const docId = await openDocumentWithText();
  await sendTheOpenSpace();
  await answerWith(onSecondBlock({ kind: 'rewrite', body: 'Something else.' }));

  const card = await askForTheCard();
  await deleteSpace(page, docId);
  created.splice(created.indexOf(docId), 1);
  await card.getByRole('button').last().click();

  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'This Document has been deleted.' })).toBeVisible();
  await expect(card).toHaveAttribute('data-state', 'idle');
});
