// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent offers a character template (inner#1807): when the reader asks
 * for consistent shots of one character outright, it reads one of the
 * character templates and the proposal built on it lands; when the reader
 * attaches a photo of a character and only asks for several videos of it, the
 * reply or a landed proposal brings up keeping that character the same with
 * one of them, unasked.
 *
 * Real model turns:
 *
 *   pnpm --filter @breatic/web test:smoke tests/smoke/agent-template-offers.spec.ts
 */
import { join } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

/** The character templates, by id and by the name the reader sees. */
const CHARACTER_TEMPLATES: Record<string, string> = {
  'costume-sheet': 'Character turnaround',
  'character-bible': 'Character sheet',
  'expression-sheet': 'Expression sheet',
  'character-design-from-text': 'Character from a description',
  'single-view-refs-scene': 'Character in a video scene',
  'identity-locked-sequence': 'One character, three shots',
  'character-showcase-orbit': 'Character orbit',
};

let page: Page;
let spaceId = '';

/** What the newest stored conversation's turn did and said. */
interface Turn {
  /** Each tool it used, in order. */
  tools: string[];
  /** Each template id its landed proposals named. */
  templates: string[];
  /** Each template id it read in full, counting only reads that answered. */
  read: string[];
  /** Everything it wrote or asked, as one text. */
  said: string;
}

/**
 * Read the newest stored conversation's turn.
 * @param p - The signed-in page.
 * @returns What the turn did and said.
 */
async function lastTurn(p: Page): Promise<Turn> {
  return p.evaluate(async () => {
    const list = await (await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })).json();
    const messages = (read?.data?.messages ?? []) as {
      role?: string;
      parts?: {
        type?: string;
        text?: string;
        output?: unknown;
        input?: { id?: string; nodes?: { template?: { id?: string } }[] } & Record<string, unknown>;
      }[];
    }[];
    const parts = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts ?? []);
    return {
      tools: parts.flatMap((part) => (part.type?.startsWith('tool-') ? [part.type.slice('tool-'.length)] : [])),
      templates: parts
        // A refused proposal answers { placed: false } and never reaches the canvas.
        .filter((part) => part.type === 'tool-propose_canvas_action' && (part.output as { placed?: boolean } | undefined)?.placed === true)
        .flatMap((part) => part.input?.nodes ?? [])
        .flatMap((node) => (node.template?.id ? [node.template.id] : [])),
      read: parts.flatMap((part) =>
        part.type === 'tool-get_generation_template' && typeof part.output === 'string' && part.input?.id ? [part.input.id] : [],
      ),
      said: parts.map((part) => (part.type === 'text' ? (part.text ?? '') : part.type?.startsWith('tool-ask_user') ? JSON.stringify(part.input) : '')).join('\n'),
    };
  });
}

/**
 * The newest turn once its reply is stored: the turn's end on screen can come
 * before the reply's words are saved.
 * @param p - The signed-in page.
 * @returns What the turn did and said.
 */
async function settledTurn(p: Page): Promise<Turn> {
  let turn = await lastTurn(p);
  await expect
    .poll(async () => {
      turn = await lastTurn(p);
      return turn.said.trim().length;
    }, { timeout: 30_000 })
    .toBeGreaterThan(0);
  return turn;
}

/**
 * Send one message in a new conversation and wait for the turn to end.
 * @param message - What the reader writes.
 * @param attach - A fixture file to attach to the message.
 */
async function ask(message: string, attach?: string): Promise<void> {
  const composer = page.getByTestId('chat-composer-box');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  if (attach !== undefined) {
    // Files chosen before the composer can take them are dropped without a word.
    await expect(page.getByTestId('chat-composer-attach')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('chat-composer-file-input').setInputFiles(join(__dirname, '../fixtures', attach));
    await expect(page.getByTestId('chat-composer-chips')).toContainText(attach, { timeout: 30_000 });
  }
  await composer.fill(message);
  // Attachments still uploading hold the send back; a press before then is
  // ignored, so wait for the button the reader would see light up.
  const send = page.getByTestId('chat-composer-send');
  await expect(send).toBeEnabled({ timeout: 60_000 });
  await send.click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(2, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 200_000 });
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await openSmokeProject(page);
  spaceId = await createSpace(page, 'canvas', `template-offer-${String(Date.now())}`);
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page.close();
});

test('asked outright for consistent shots of one character, it reads a character template and lands a proposal built on it @needs-model', async () => {
  test.setTimeout(240_000);
  await ask(
    'I have one photo of my character, a courier in a red coat. Make three shots of her in a row and keep her exactly the same in all of them. Do not ask me anything, just propose it.',
  );
  const turn = await settledTurn(page);
  const proposed = turn.templates.filter((id) => id in CHARACTER_TEMPLATES);
  expect(proposed, `a landed proposal named a character template. Named: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}`).not.toEqual([]);
  // The template it proposed is one it read in full first.
  expect(turn.read, `read: ${turn.read.join(', ')}`).toEqual(expect.arrayContaining(proposed));
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 20_000 });
});

test('given a character photo and asked for several videos of it, it brings up keeping that character the same, unasked @needs-model', async () => {
  test.setTimeout(240_000);
  await ask('This is my character. I want two short videos of her: one walking through a park, one sitting in a café.', 'character.jpg');
  const turn = await settledTurn(page);
  // Offered where the reader sees it: a landed proposal built on it, or its name in the reply or a question.
  const named = Object.entries(CHARACTER_TEMPLATES).filter(
    ([id, name]) => turn.templates.includes(id) || turn.said.includes(id) || turn.said.toLowerCase().includes(name.toLowerCase()),
  );
  expect(
    named,
    `the turn offered a character template. Proposed: ${turn.templates.join(', ')}; read: ${turn.read.join(', ')}; tools: ${turn.tools.join(', ')}; said: ${turn.said.slice(0, 600)}`,
  ).not.toEqual([]);
});
