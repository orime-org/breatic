// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Agent asks to look at Spaces, in a browser (inner#1552).
 *
 * The turn requests are answered here with streams written the way the server
 * writes them, so the card is reached without a model: it names each Space
 * asked for and the part asked for, Decline on the left and Allow on the
 * right. Allowing reads each Space -- ones whose tab is closed over a socket
 * of the read's own -- and sends what it read with the answer; declining
 * sends only that. A card still waiting is drawn again after a reload from
 * the stored conversation and can still be answered. That the server takes
 * the answer once and hands the content to the model is checked in its
 * integration tests.
 */
import { expect, type Page, type Route } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';
import { openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, DOCUMENT_EDITOR } from '../helpers/space';
import { projectIdOf } from '../helpers/tab-restore';

/** One request body the panel sent. */
type Sent = Record<string, unknown>;

/** Builds a turn's stream from the request that asked for it. */
type Answer = (sent: Sent) => string;

let page: Page;
const created: string[] = [];

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await openSmokeProject(page);
});

test.afterEach(async () => {
  for (const id of created.splice(0)) await deleteSpace(page, id);
  await page.close();
});

/**
 * Make a Space for this case, removed when it ends.
 * @param kind - Its type.
 * @param label - What its name starts with.
 * @returns Its id and name.
 */
async function makeSpace(kind: 'document' | 'canvas', label: string): Promise<{ id: string; name: string }> {
  const name = `${label}-${String(Date.now())}`;
  const id = await createSpace(page, kind, name);
  created.push(id);
  return { id, name };
}

/**
 * A stream the way the server writes one.
 * @param chunks - What follows the opening.
 * @returns The response body.
 */
function stream(chunks: object[]): string {
  const opening = [
    { type: 'data-heartbeat', transient: true, data: {} },
    { type: 'data-conversation-titled', data: { title: 'space request' } },
  ];
  return [...opening, ...chunks].map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
}

/** The reason the served turn gives. */
const REASON = 'To see what you have written so far.';

/**
 * A turn that stops at a request to look at these Spaces.
 * @param spaces - The Spaces asked for, as the tool names them.
 * @returns The stream.
 */
function asks(spaces: object[]): string {
  return stream([
    { type: 'start', messageId: 'm-reply' },
    { type: 'start-step' },
    { type: 'text-start', id: 't0' },
    { type: 'text-delta', id: 't0', delta: 'Let me look first.' },
    { type: 'text-end', id: 't0' },
    { type: 'tool-input-available', toolCallId: 'req-1', toolName: 'request_space_content', input: { reason: REASON, spaces } },
    { type: 'finish-step' },
    { type: 'data-ask-awaiting', data: { toolCallId: 'req-1' } },
    { type: 'finish' },
  ]);
}

/**
 * The turn going on after the reader answered, as the server sends it: the
 * card's summary of the answer, then a reply of its own.
 * @param output - What the card is settled with.
 * @returns The stream.
 */
function resumes(output: object): string {
  return stream([
    { type: 'tool-output-available', toolCallId: 'req-1', output },
    { type: 'start', messageId: 'm-reply-resumed' },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Thanks, carrying on.' },
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'finish' },
  ]);
}

/**
 * The resumed turn for whatever the reader answered: the summary the server
 * keeps for the card is each shared Space without its content.
 * @param sent - The answer's request.
 * @returns The stream.
 */
const settle: Answer = (sent) => {
  const answer = sent.shared_spaces as { decision: string; spaces?: Array<Record<string, unknown>> };
  if (answer.decision === 'declined') return resumes({ declined: true });
  const spaces = (answer.spaces ?? []).map(({ id, name, kind, part, state }) => ({ id, name, kind, part, state }));
  return resumes({ spaces });
};

/**
 * Serve the turn requests in order, and keep what each one sent.
 * @param answers - The stream for each request, in order.
 * @returns What each request carried.
 */
async function serve(answers: Answer[]): Promise<Sent[]> {
  const sent: Sent[] = [];
  await page.route('**/chat/message', async (route: Route) => {
    const body = route.request().postDataJSON() as Sent;
    sent.push(body);
    const answer = answers[sent.length - 1];
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: answer === undefined ? stream([{ type: 'finish' }]) : answer(body),
    });
  });
  return sent;
}

/** Say something in a new conversation and wait for the card. */
async function askAndWaitForTheCard(): Promise<void> {
  await startNewConversation(page);
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill('What do my other Spaces say?');
  await composer.press('Enter');
  await expect(page.getByTestId('space-request-allow')).toBeVisible({ timeout: 20_000 });
}

/**
 * Close a Space's tab, so this tab holds its document no longer.
 * @param id - The Space.
 */
async function closeTab(id: string): Promise<void> {
  await page.getByTestId(`space-tab-${id}`).hover();
  await page.getByTestId(`space-tab-close-${id}`).click();
  await expect(page.getByTestId(`space-tab-name-${id}`)).toHaveCount(0);
}

test('the card names each Space and the part asked for, Decline left and Allow right', async () => {
  const doc = await makeSpace('document', 'req-card-doc');
  const canvas = await makeSpace('canvas', 'req-card-canvas');
  await serve([() => asks([{ id: doc.id, blocks: { from: 2 } }, { id: canvas.id, node_ids: ['n-a', 'n-b'] }])]);
  await askAndWaitForTheCard();

  const card = page.getByTestId('space-request-card');
  await expect(card).toContainText('Agent wants to look at');
  await expect(card).toContainText(REASON);
  const rows = card.getByTestId('space-request-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-kind', 'document');
  await expect(rows.nth(0)).toContainText(doc.name);
  await expect(rows.nth(0).getByTestId('space-request-part')).toHaveText('From block 2');
  await expect(rows.nth(1)).toHaveAttribute('data-kind', 'canvas');
  await expect(rows.nth(1)).toContainText(canvas.name);
  await expect(rows.nth(1).getByTestId('space-request-part')).toHaveText('2 nodes');
  await expect(card.getByTestId('space-request-state')).toHaveCount(0);

  const decline = await page.getByTestId('space-request-decline').boundingBox();
  const allow = await page.getByTestId('space-request-allow').boundingBox();
  expect(decline!.x + decline!.width).toBeLessThanOrEqual(allow!.x);
  await expect(page.getByTestId('space-request-decline')).toHaveText('Decline');
  await expect(page.getByTestId('space-request-allow')).toHaveText('Allow');
});

test('allowing reads a document and a canvas whose tabs are closed and sends what they hold', async () => {
  const words = `Request smoke words ${String(Date.now())}`;
  const nodeName = `request-smoke-node-${String(Date.now())}`;

  const doc = await makeSpace('document', 'req-allow-doc');
  await page.locator(DOCUMENT_EDITOR).click();
  await page.keyboard.type(words);
  await expect(page.locator(DOCUMENT_EDITOR)).toContainText(words);

  const canvas = await makeSpace('canvas', 'req-allow-canvas');
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, url, name]) => {
      const mod = (await import(/* @vite-ignore */ url)) as { addNode: (p: string, s: string, n: unknown) => void };
      mod.addNode(pid, sid, {
        id: 'request-smoke-node',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { name, createdAt: Date.now(), createdBy: 'smoke', locked: false, attachments: [] },
      });
    },
    [projectIdOf(page.url()), canvas.id, canvasAt, nodeName] as const,
  );
  await expect(page.locator('.react-flow__node[data-id="request-smoke-node"]')).toBeVisible({ timeout: 15_000 });

  // A third Space in front; the two asked for are closed, so the read has to
  // connect to them itself.
  await makeSpace('document', 'req-allow-front');
  await closeTab(doc.id);
  await closeTab(canvas.id);

  const sent = await serve([() => asks([{ id: doc.id }, { id: canvas.id }]), settle]);
  await askAndWaitForTheCard();

  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.getByTestId('space-request-allow').click();

  await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(2);
  const answer = sent[1]!;
  expect(answer.message ?? '').toBe('');
  expect(answer.shared_spaces).toMatchObject({ toolCallId: 'req-1', decision: 'shared' });
  const shared = (answer.shared_spaces as { spaces: Array<Record<string, unknown>> }).spaces;
  expect(shared.map((s) => [s.id, s.kind, s.state])).toEqual([
    [doc.id, 'document', 'read'],
    [canvas.id, 'canvas', 'read'],
  ]);
  expect(shared[0]!.content).toContain(words);
  expect(shared[1]!.content).toContain(nodeName);
  // Neither was held by this tab, so the read opened a connection of its own.
  expect(sockets.length).toBeGreaterThanOrEqual(1);

  const card = page.getByTestId('space-request-card');
  await expect(card).toContainText('Shared with Agent', { timeout: 20_000 });
  await expect(card.getByTestId('space-request-row')).toHaveCount(2);
  await expect(card.getByTestId('space-request-state')).toHaveCount(0);
  await expect(page.getByTestId('space-request-allow')).toHaveCount(0);
  await expect(page.getByText('Thanks, carrying on.')).toBeVisible();
});

test('declining sends only that, and the card says it was not shared', async () => {
  const doc = await makeSpace('document', 'req-decline-doc');
  const sent = await serve([() => asks([{ id: doc.id }]), settle]);
  await askAndWaitForTheCard();

  await page.getByTestId('space-request-decline').click();

  await expect.poll(() => sent.length, { timeout: 20_000 }).toBe(2);
  expect(sent[1]!.shared_spaces).toEqual({ toolCallId: 'req-1', decision: 'declined' });
  const card = page.getByTestId('space-request-card');
  await expect(card).toContainText('Not shared with Agent', { timeout: 20_000 });
  await expect(page.getByTestId('space-request-decline')).toHaveCount(0);
});

test('a card still waiting is drawn again after a reload and can be answered', async () => {
  const doc = await makeSpace('document', 'req-reload-doc');
  const input = { reason: REASON, spaces: [{ id: doc.id }] };
  const sent = await serve([() => asks(input.spaces), settle]);
  await askAndWaitForTheCard();
  const conversationId = sent[0]!.conversation_id as string;

  // The served turn never reached the server, so the stored conversation is
  // given the rows the server keeps for a turn stopped at the card.
  const ts = new Date().toISOString();
  const stored = [
    { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'What do my other Spaces say?' }], metadata: { turnIndex: 0, ts } },
    {
      id: 'm-reply',
      role: 'assistant',
      metadata: { turnIndex: 0, ts },
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'Let me look first.', state: 'done' },
        { type: 'tool-request_space_content', toolCallId: 'req-1', state: 'input-available', input },
        { type: 'data-ask-awaiting', data: { toolCallId: 'req-1' } },
      ],
    },
  ];
  /**
   * Answer with the stored conversation when it is this case's.
   * @param route - The request.
   * @param pick - Where the conversation and its messages are in the answer.
   */
  const withStored = async (route: Route, pick: (json: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
    const real = await route.fetch();
    const json = (await real.json()) as Record<string, unknown>;
    const held = pick(json);
    if ((held.conversation as { id?: string } | undefined)?.id === conversationId) held.messages = stored;
    await route.fulfill({ response: real, json });
  };
  await page.route('**/chat/open', (route) => withStored(route, (json) => (json.data as { current: Record<string, unknown> }).current));
  await page.route(`**/chat/conversations/${conversationId}`, (route) => withStored(route, (json) => json.data as Record<string, unknown>));

  await page.reload();
  await expect(page.getByTestId('space-request-allow')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('space-request-row')).toContainText(doc.name);

  await page.getByTestId('space-request-decline').click();
  await expect.poll(() => sent.length, { timeout: 20_000 }).toBe(2);
  expect(sent[1]).toMatchObject({ conversation_id: conversationId, shared_spaces: { toolCallId: 'req-1', decision: 'declined' } });
  await expect(page.getByTestId('space-request-card')).toContainText('Not shared with Agent', { timeout: 20_000 });
});
