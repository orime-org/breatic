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
import type { DocumentProposal } from '@breatic/shared';
import type { DocumentEditorHandle } from '../../src/spaces/document/document-editor-cache';
import type { Node as PMNode } from '@tiptap/pm/model';
import { test } from '../helpers/slot';
import { pressAndSettle } from '../helpers/editor-keys';
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
  // Keep late document modules in Resource Timing for liveModuleUrl; a cold
  // editor load exceeds the browser's default resource-entry capacity.
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.consoleAPICalled', (event: { type: string; args: Array<{ value?: unknown }>; stackTrace?: unknown }) => {
    if (event.type === 'error' && event.args.some((arg) => String(arg.value).includes('flushSync was called'))) {
      void test.info().attach('table-mount-console-stack', { body: JSON.stringify(event.stackTrace), contentType: 'application/json' });
    }
  });
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

  // Shown the way a comment the reader wrote is: the panel opens on its card.
  await expect(card).toHaveAttribute('data-state', 'applied');
  const rail = visibleSpace(page).getByTestId('doc-comment-rail');
  await expect(rail).toBeVisible();
  await expect(rail.getByTestId('doc-comment-card')).toHaveAttribute('data-selected', 'true');
  await expect(rail.getByTestId('doc-comment-from-agent')).toBeVisible();
  await expect(rail.getByText('Why is she leaving?')).toBeVisible();

  // "View" opens it on the card again once the reader has closed it.
  await rail.getByTestId('doc-comment-rail-close').click();
  await expect(rail).toHaveCount(0);
  await card.getByRole('button').click();
  await expect(rail).toBeVisible();
  await expect(rail.getByTestId('doc-comment-card')).toHaveAttribute('data-selected', 'true');
});

/** A table wider than the body column: its second column holds `MIDCELL`, its last `LASTCELL`. */
const WIDE_TABLE = [
  `| ${Array.from({ length: 8 }, (_, i) => `Column ${String(i + 1)}`).join(' | ')} |`,
  `|${' --- |'.repeat(8)}`,
  `| ${['a'.repeat(30), 'MIDCELL', 'a'.repeat(30), 'a'.repeat(30), 'a'.repeat(30), 'a'.repeat(30), 'a'.repeat(30), 'LASTCELL'].join(' | ')} |`,
].join('\n');

/**
 * Where the commented words in a wide table sit against the table's frame.
 * @param word - The commented word.
 * @returns Whether the frame scrolls sideways, how far it is scrolled, and
 * whether the words are inside it.
 */
async function commentInTable(word = 'LASTCELL'): Promise<{ overflows: boolean; scrolled: number; inside: boolean }> {
  return page.evaluate((w) => {
    const mark = [...document.querySelectorAll<HTMLElement>('.bn-thread-mark')].find((m) => m.textContent?.includes(w));
    const outer = mark?.closest('.doc-table-frame');
    const frame = outer?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
    const cell = mark?.closest('td, th');
    if (outer === null || outer === undefined || frame === null || frame === undefined || cell === null || cell === undefined) {
      return { overflows: false, scrolled: -1, inside: false };
    }
    // The whole cell, clear of a "more to scroll" edge on whichever side
    // still shows one.
    const edge = (side: string): number => {
      const el = outer.querySelector<HTMLElement>(`.doc-table-overflow-edge[data-overflow-edge="${side}"]`);
      return el?.hasAttribute('data-on') === true ? el.offsetWidth : 0;
    };
    const at = cell.getBoundingClientRect();
    const box = frame.getBoundingClientRect();
    return {
      overflows: frame.scrollWidth > frame.clientWidth,
      scrolled: frame.scrollLeft,
      inside: at.left >= box.left + edge('left') - 1 && at.right <= box.right - edge('right') + 1,
    };
  }, word);
}

test('a comment in a column of a wide table scrolled out of view is scrolled into it', async () => {
  await openDocumentWithText();
  await sendTheOpenSpace();
  await answerWith((blocks, spaceId) => ({ ...onSecondBlock({})(blocks, spaceId), kind: 'insert', body: WIDE_TABLE }));
  const insert = await askForTheCard();
  await insert.getByRole('button').last().click();
  await expect(insert).toHaveAttribute('data-state', 'applied');

  await page.unroute('**/chat/message');
  await answerWith((blocks, spaceId) => {
    const table = blocks.find((b) => b.type === 'docTable')!;
    return {
      ...onSecondBlock({})(blocks, spaceId),
      kind: 'comment',
      blockId: table.id,
      original: table.text,
      blockType: 'docTable',
      quote: 'LASTCELL',
      body: 'Is this the last shot?',
    };
  });
  const comment = await askForTheCard();
  await comment.getByRole('button').first().click();

  await expect(comment).toHaveAttribute('data-state', 'applied');
  await expect.poll(commentInTable).toEqual({ overflows: true, scrolled: expect.any(Number), inside: true });
  expect((await commentInTable()).scrolled).toBeGreaterThan(0);

  // A new explicit View reaches the same final consumer while it stays open.
  await page.evaluate(() => {
    for (const frame of document.querySelectorAll<HTMLElement>('.doc-table-scroller [data-radix-scroll-area-viewport]')) frame.scrollLeft = 0;
  });
  await expect.poll(async () => (await commentInTable()).inside).toBe(false);
  await comment.getByRole('button').click();
  await expect.poll(async () => (await commentInTable()).inside).toBe(true);

  // Settled marks remain a valid landing. Explicit View prepares All before
  // membership cleanup, then a later manual filter remains the reader's.
  const selectedRail = visibleSpace(page).getByTestId('doc-comment-rail');
  await selectedRail.getByTestId('doc-comment-resolve').click();
  await selectedRail.getByTestId('doc-comment-rail-filter-open').click();
  await expect(selectedRail.getByTestId('doc-comment-card')).toHaveCount(0);
  await comment.getByRole('button').click();
  await expect(selectedRail.getByTestId('doc-comment-rail-filter-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(selectedRail.getByTestId('doc-comment-card')).toHaveAttribute('data-selected', 'true');
  await expect(selectedRail.getByTestId('doc-comment-reopen')).toBeVisible();
  await selectedRail.getByTestId('doc-comment-reopen').click();

  // Pressing its card in the panel does the same once the table is scrolled back.
  const rail = visibleSpace(page).getByTestId('doc-comment-rail');
  await rail.getByTestId('doc-comment-rail-close').click();
  await page.evaluate(() => {
    for (const frame of document.querySelectorAll<HTMLElement>('.doc-table-scroller [data-radix-scroll-area-viewport]')) frame.scrollLeft = 0;
  });
  await expect.poll(async () => (await commentInTable()).inside).toBe(false);
  await openCommentRail(page);
  await rail.getByTestId('doc-comment-card').click();
  await expect.poll(async () => (await commentInTable()).inside).toBe(true);

  // A cell cut off on the left comes clear of the left edge the same way.
  await rail.getByTestId('doc-comment-rail-close').click();
  await page.unroute('**/chat/message');
  await answerWith((blocks, spaceId) => {
    const table = blocks.find((b) => b.type === 'docTable')!;
    return { ...onSecondBlock({})(blocks, spaceId), kind: 'comment', blockId: table.id, original: table.text, blockType: 'docTable', quote: 'MIDCELL', body: 'Why this shot?' };
  });
  const middle = await askForTheCard();
  await page.evaluate(() => {
    for (const frame of document.querySelectorAll<HTMLElement>('.doc-table-scroller [data-radix-scroll-area-viewport]')) frame.scrollLeft = frame.scrollWidth;
  });
  expect((await commentInTable('MIDCELL')).inside).toBe(false);
  await middle.getByRole('button').first().click();
  await expect(middle).toHaveAttribute('data-state', 'applied');
  await expect.poll(() => commentInTable('MIDCELL')).toEqual({ overflows: true, scrolled: expect.any(Number), inside: true });
  expect(await page.locator('.doc-table-overflow-edge[data-overflow-edge="left"]').first().getAttribute('data-on')).toBe('');
});

/**
 * Seeds a normal table and moves the existing target through the drag command.
 * @param spaceId - The open document.
 * @param targetId - The proposal's unchanged target block.
 * @returns The complete tree immediately before applying the proposal.
 */
async function moveTargetIntoCell(spaceId: string, targetId: string): Promise<unknown> {
  const urls = await Promise.all([
    liveModuleUrl(page, 'spaces/document/document-editor-cache.ts'),
    liveModuleUrl(page, 'spaces/document/document-drag-move.ts'),
    liveModuleUrl(page, 'spaces/document/document-row-by-id.ts'),
  ]);
  const name = `project-${projectIdOf(page.url())}/document-${spaceId}`;
  return page.evaluate(async ({ urls, name, targetId }) => {
    const cache = await import(urls[0]!) as { peekDocumentEditor: (name: string) => DocumentEditorHandle | undefined };
    const move = await import(urls[1]!) as { moveRowTo: (view: DocumentEditorHandle['editor']['prosemirrorView'], id: string, pos: number) => void };
    const rows = await import(urls[2]!) as { rowById: (doc: PMNode, id: string) => { from: number } | undefined };
    const handle = cache.peekDocumentEditor(name);
    if (handle === undefined) throw new Error('The visible document has no live cache handle.');
    const editor = handle.editor;
    const table = await editor.tryParseMarkdownToBlocks('| Host | Other |\n| --- | --- |\n| Anchor | Retained |');
    const last = editor.document[editor.document.length - 1] as { id: string };
    editor.insertBlocks(table, last.id, 'after');
    let anchorId: string | null = null;
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'docTableCell' && anchorId === null) anchorId = String(node.firstChild!.attrs.id);
      return true;
    });
    if (anchorId === null) throw new Error('The seeded table has no cell block.');
    const anchor = rows.rowById(editor.prosemirrorState.doc, anchorId);
    if (anchor === undefined) throw new Error('The seeded cell block has no row.');
    move.moveRowTo(editor.prosemirrorView, targetId, anchor.from);
    handle.undoManager.clear();
    return editor.prosemirrorState.doc.toJSON();
  }, { urls, name, targetId });
}

/**
 * Reads the trace and complete document from the page's live module copies.
 * @param proposal - The proposal whose actual output is being read.
 * @returns The current landing, full tree and undo count.
 */
async function proposalState(proposal: DocumentProposal): Promise<{ at: { how: string; blockId: string } | null; tree: unknown; undo: number }> {
  const urls = await Promise.all([
    liveModuleUrl(page, 'spaces/document/document-editor-cache.ts'),
    liveModuleUrl(page, 'spaces/document/document-proposal-landing.ts'),
  ]);
  const name = `project-${projectIdOf(page.url())}/document-${proposal.spaceId}`;
  return page.evaluate(async ({ urls, name, proposal }) => {
    const cache = await import(urls[0]!) as { peekDocumentEditor: (name: string) => DocumentEditorHandle | undefined };
    const landing = await import(urls[1]!) as { landedAt: (handle: DocumentEditorHandle, proposal: DocumentProposal) => { how: string; blockId: string } | null };
    const handle = cache.peekDocumentEditor(name);
    if (handle === undefined) throw new Error('The document has no live cache handle.');
    return { at: landing.landedAt(handle, proposal), tree: handle.editor.prosemirrorState.doc.toJSON(), undo: handle.undoManager.undoStack.length };
  }, { urls, name, proposal });
}

for (const theme of ['light', 'dark'] as const) {
  for (const kind of ['insert', 'rewrite'] as const) {
    test(`a ${kind} follows its target into a cell and keeps its trace through undo, redo and refresh (${theme})`, async () => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      const spaceId = await openDocumentWithText();
      await sendTheOpenSpace();
      let proposal!: DocumentProposal;
      await answerWith((blocks, id) => {
        const result = onSecondBlock({ kind, body: '| Agent header |\n| --- |\n| AGENT_CELL |' })(blocks, id);
        proposal = result as unknown as DocumentProposal;
        return result;
      });
      const card = await askForTheCard();
      const before = await moveTargetIntoCell(spaceId, proposal.blockId!);
      await page.getByTestId('theme-toggle').click();
      await page.getByTestId(`theme-option-${theme}`).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await card.getByRole('button').last().click();
      await expect(card).toHaveAttribute('data-state', 'applied');
      await expect(page.locator(`${DOCUMENT_EDITOR} table table`)).toHaveCount(0);
      await expect(page.locator(`${DOCUMENT_EDITOR} p`).filter({ hasText: /^AGENT_CELL$/ })).toHaveCount(1);
      const applied = await proposalState(proposal);
      expect(applied.at).toEqual({ how: 'write', blockId: expect.any(String) });
      expect(applied.undo).toBe(1);
      await card.getByRole('button').click();
      expect((await proposalState(proposal)).tree).toEqual(applied.tree);
      await page.locator(`${DOCUMENT_EDITOR} p`).filter({ hasText: /^AGENT_CELL$/ }).click();
      await pressAndSettle(page, 'Meta+z');
      await expect.poll(async () => (await proposalState(proposal)).tree).toEqual(before);
      await expect(card).toHaveAttribute('data-state', 'idle');
      await pressAndSettle(page, 'Meta+Shift+z');
      await expect.poll(async () => (await proposalState(proposal)).tree).toEqual(applied.tree);
      await expect(card).toHaveAttribute('data-state', 'applied');
      await page.screenshot({ path: test.info().outputPath(`cell-${kind}-${theme}.png`) });
      await page.reload();
      await expect(page.locator(DOCUMENT_EDITOR)).toBeVisible();
      await expect.poll(async () => (await proposalState(proposal)).at).toEqual(applied.at);
      await expect(page.locator(`${DOCUMENT_EDITOR} p`).filter({ hasText: /^AGENT_CELL$/ })).toHaveCount(1);
      expect(errors).toEqual([]);
    });
  }
}

test('a comment card brought up from the bottom of the window stops as far above it as the chat composer', async () => {
  const id = await createSpace(page, 'document', `doc-proposal-${String(Date.now())}`);
  created.push(id);
  await page.locator(DOCUMENT_EDITOR).click();
  for (let i = 1; i <= 40; i += 1) {
    await page.keyboard.type(`Line ${String(i)}.`);
    await page.keyboard.press('Enter');
  }
  await page.keyboard.type('The last line of the scene.');
  await sendTheOpenSpace();
  await answerWith((blocks, spaceId) => {
    const last = blocks[blocks.length - 1]!;
    return {
      ...onSecondBlock({})(blocks, spaceId),
      kind: 'comment',
      blockId: last.id,
      original: last.text,
      quote: 'last line',
      body: Array.from({ length: 8 }, (_, i) => `Note ${String(i + 1)} on how the scene should end.`).join('\n'),
    };
  });

  const card = await askForTheCard();
  await page.locator(`${DOCUMENT_EDITOR} p`).last().scrollIntoViewIfNeeded();
  await card.getByRole('button').first().click();

  const shown = visibleSpace(page).getByTestId('doc-comment-rail').getByTestId('doc-comment-card');
  await expect(shown).toHaveAttribute('data-selected', 'true');
  const gaps = async (): Promise<number> =>
    page.evaluate(() => {
      const bottom = (sel: string): number => document.querySelector(sel)!.getBoundingClientRect().bottom;
      const card = [...document.querySelectorAll('[data-testid="doc-comment-card"]')].find((c) => c.getAttribute('data-selected') === 'true')!;
      const fromCard = window.innerHeight - card.getBoundingClientRect().bottom;
      const fromComposer = window.innerHeight - bottom('[data-testid="chat-composer"]');
      return Math.round(Math.abs(fromCard - fromComposer));
    });
  await expect.poll(gaps).toBeLessThanOrEqual(1);
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
  // The mark stands off the rewritten words on every side.
  const mark = await page.getByTestId('document-proposal-landed').boundingBox();
  const words = await page.locator(`${DOCUMENT_EDITOR} p`).last().boundingBox();
  expect(mark !== null && words !== null).toBe(true);
  expect(mark!.x).toBeLessThan(words!.x);
  expect(mark!.y).toBeLessThan(words!.y);
  expect(mark!.x + mark!.width).toBeGreaterThan(words!.x + words!.width);
  expect(mark!.y + mark!.height).toBeGreaterThan(words!.y + words!.height);

  // "View" only shows the change; it writes nothing.
  await card.getByRole('button').click();
  await expect(card.getByRole('button')).not.toHaveAttribute('aria-busy', 'true');
  expect(await undoStack(docId)).toBe(before + 1);

  await undoStack(docId, true);
  await expect.poll(paragraphs).toEqual(['Scene two opens.', 'He pushes the door open and sees her bags packed.']);
  await expect(card).toHaveAttribute('data-state', 'idle');
});

for (const theme of ['light', 'dark']) {
  test(`an insert puts a table after the passage, opening the document when another Space is in front (${theme})`, async () => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
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
    await page.getByTestId('theme-toggle').click();
    await page.getByTestId(`theme-option-${theme}`).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await card.getByRole('button').last().click();

    await expect(card).toHaveAttribute('data-state', 'applied');
    await expect(visibleSpace(page).getByTestId('document-space')).toHaveAttribute('data-space-id', docId);
    const table = page.locator(`${DOCUMENT_EDITOR} table`);
    await expect(table).toBeVisible();
    const box = await table.boundingBox();
    expect(box !== null && box.y >= 0 && box.y + box.height <= 900).toBe(true);
    const mark = visibleSpace(page).getByTestId('document-proposal-landed');
    await expect(mark).toBeVisible();
    const bounds = await mark.evaluate((element) => {
      const space = element.closest('[data-testid="document-space"]')!;
      const frame = space.querySelector('[data-node-type="docTable"]')!;
      const mark = element.getBoundingClientRect();
      const table = frame.getBoundingClientRect();
      const first = frame.querySelector('.bn-block-content')!.getBoundingClientRect();
      return { theme: document.documentElement.getAttribute('data-theme'), mark: mark.toJSON(), table: table.toJSON(), first: first.toJSON() };
    });
    expect(bounds.theme).toBe(theme);
    expect(bounds.mark.left).toBeLessThan(bounds.table.left);
    expect(bounds.mark.top).toBeLessThan(bounds.table.top);
    expect(bounds.mark.right).toBeGreaterThan(bounds.table.right);
    expect(bounds.mark.bottom).toBeGreaterThan(bounds.table.bottom);
    expect(bounds.mark.width).toBeGreaterThan(bounds.first.width);
    await test.info().attach(`table-landing-${theme}`, { body: JSON.stringify(bounds), contentType: 'application/json' });
    const screenshot = test.info().outputPath(`table-landing-${theme}.png`);
    await page.screenshot({ path: screenshot });
    await test.info().attach(`table-landing-${theme}.png`, { path: screenshot, contentType: 'image/png' });
    expect(errors).toEqual([]);
  });
}

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
