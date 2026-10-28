// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent offers a character template (inner#1807): when the reader asks
 * for consistent shots of one character outright, it proposes one of the
 * character templates after reading it; when the reader only asks for
 * several videos of one character, it brings up keeping that character the
 * same with one of them, unasked.
 *
 * Real model turns:
 *
 *   pnpm --filter @breatic/web test:smoke tests/smoke/agent-template-offers.spec.ts
 */
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
  /** Each template id its proposals named. */
  templates: string[];
  /** Each template id it read in full. */
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
      parts?: { type?: string; text?: string; input?: { id?: string; nodes?: { template?: { id?: string } }[] } & Record<string, unknown> }[];
    }[];
    const parts = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts ?? []);
    return {
      tools: parts.flatMap((part) => (part.type?.startsWith('tool-') ? [part.type.slice('tool-'.length)] : [])),
      templates: parts
        .filter((part) => part.type === 'tool-propose_canvas_action')
        .flatMap((part) => part.input?.nodes ?? [])
        .flatMap((node) => (node.template?.id ? [node.template.id] : [])),
      read: parts.flatMap((part) => (part.type === 'tool-get_generation_template' && part.input?.id ? [part.input.id] : [])),
      said: parts.map((part) => (part.type === 'text' ? (part.text ?? '') : part.type?.startsWith('tool-ask_user') ? JSON.stringify(part.input) : '')).join('\n'),
    };
  });
}

/**
 * Send one message in a new conversation and wait for the turn to end.
 * @param message - What the reader writes.
 */
async function ask(message: string): Promise<void> {
  const composer = page.getByTestId('chat-composer-box');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
  await composer.fill(message);
  await composer.press('Enter');
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

test('asked outright for consistent shots of one character, it reads and proposes a character template @needs-model', async () => {
  test.setTimeout(240_000);
  await ask(
    'I have one photo of my character, a courier in a red coat. Make three shots of her in a row and keep her exactly the same in all of them. Do not ask me anything, just propose it.',
  );
  const turn = await lastTurn(page);
  const proposed = turn.templates.filter((id) => id in CHARACTER_TEMPLATES);
  expect(proposed, `a proposal named a character template. Named: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}`).not.toEqual([]);
  // The template was read in full before it was proposed.
  const read = turn.tools.indexOf('get_generation_template');
  expect(read, `tools: ${turn.tools.join(', ')}`).toBeGreaterThanOrEqual(0);
  expect(read).toBeLessThan(turn.tools.lastIndexOf('propose_canvas_action'));
});

test('asked for several videos of one character, it brings up keeping that character the same, unasked @needs-model', async () => {
  test.setTimeout(240_000);
  await ask(
    'I have a photo of my character, a girl in a yellow raincoat. I want two short videos of her: one walking through a park, one sitting in a café.',
  );
  const turn = await lastTurn(page);
  // Offered by proposing it, by reading it to build its answer on, or by naming it.
  const named = Object.entries(CHARACTER_TEMPLATES).filter(
    ([id, name]) =>
      turn.templates.includes(id) || turn.read.includes(id) || turn.said.includes(id) || turn.said.toLowerCase().includes(name.toLowerCase()),
  );
  expect(
    named,
    `the turn offered a character template. Proposed: ${turn.templates.join(', ')}; read: ${turn.read.join(', ')}; tools: ${turn.tools.join(', ')}; said: ${turn.said.slice(0, 600)}`,
  ).not.toEqual([]);
});
