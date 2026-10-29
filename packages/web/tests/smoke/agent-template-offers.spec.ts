// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent offers a character template (inner#1807): when the reader asks
 * for consistent shots of one character outright, it reads one of the
 * character templates and the proposal built on it lands; when the reader
 * attaches a photo of a character and only asks for two videos of it, what
 * lands carries that character into both videos, whether through a template
 * or a setup of its own.
 *
 * Real model turns:
 *
 *   pnpm --filter @breatic/web test:smoke tests/smoke/agent-template-offers.spec.ts
 */
import { join } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { GENERATION_TEMPLATES } from '@breatic/shared';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

/** The ids of the templates that serve the character goal. */
const CHARACTER_TEMPLATES = new Set(GENERATION_TEMPLATES.filter((template) => template.goal === 'character').map((template) => template.id));

let page: Page;
let spaceId = '';

/** A proposal as the agent sent it: its nodes and the edges between them, by index. */
interface Proposal {
  nodes: { type?: string; role?: string; material?: string; fills?: Record<string, number[]> }[];
  edges: { fromIndex: number; toIndex: number }[];
}

/**
 * How many generated videos in a proposal draw on the material it carries,
 * through an edge or a filled slot, directly or through generations between.
 * @param proposal - The proposal.
 * @returns The count.
 */
function videosCarryingMaterial(proposal: Proposal): number {
  const fed = new Map<number, number[]>();
  const feed = (to: number, from: number): void => {
    fed.set(to, [...(fed.get(to) ?? []), from]);
  };
  for (const edge of proposal.edges) feed(edge.toIndex, edge.fromIndex);
  proposal.nodes.forEach((node, at) => {
    for (const from of Object.values(node.fills ?? {}).flat()) feed(at, from);
  });
  const carries = (at: number, seen: Set<number>): boolean =>
    proposal.nodes[at]?.material !== undefined ||
    (fed.get(at) ?? []).some((from) => !seen.has(from) && carries(from, new Set([...seen, from])));
  return proposal.nodes.filter((node, at) => node.type === 'video' && node.role === 'generate' && carries(at, new Set([at]))).length;
}

/** What the newest stored conversation's turn did and said. */
interface Turn {
  /** Each tool it used, in order. */
  tools: string[];
  /** Each template id its landed proposals named. */
  templates: string[];
  /** The landed proposals, as sent. */
  landed: Proposal[];
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
        input?: { id?: string; nodes?: ({ template?: { id?: string } } & Proposal['nodes'][number])[]; edges?: Proposal['edges'] } & Record<string, unknown>;
      }[];
    }[];
    const parts = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts ?? []);
    // A refused proposal answers { placed: false } and never reaches the canvas.
    const landed = parts.filter(
      (part) => part.type === 'tool-propose_canvas_action' && (part.output as { placed?: boolean } | undefined)?.placed === true,
    );
    return {
      tools: parts.flatMap((part) => (part.type?.startsWith('tool-') ? [part.type.slice('tool-'.length)] : [])),
      templates: landed.flatMap((part) => part.input?.nodes ?? []).flatMap((node) => (node.template?.id ? [node.template.id] : [])),
      landed: landed.map((part) => ({ nodes: part.input?.nodes ?? [], edges: part.input?.edges ?? [] })),
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
  const proposed = turn.templates.filter((id) => CHARACTER_TEMPLATES.has(id));
  expect(proposed, `a landed proposal named a character template. Named: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}`).not.toEqual([]);
  // The template it proposed is one it read in full first.
  expect(turn.read, `read: ${turn.read.join(', ')}`).toEqual(expect.arrayContaining(proposed));
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 20_000 });
});

test('given a character photo and asked for two videos of her, it lands both videos carrying that character @needs-model', async () => {
  test.setTimeout(240_000);
  await ask('This is my character. I want two short videos of her: one walking through a park, one sitting in a café. Do not ask me anything, just propose it.', 'character.jpg');
  const turn = await settledTurn(page);
  // What the reader asked for is solved when both videos draw on her photo,
  // whether through a template or a setup of the agent's own.
  const carrying = turn.landed.reduce((count, proposal) => count + videosCarryingMaterial(proposal), 0);
  expect(carrying, `videos drawing on the photo in landed proposals. Templates: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}; said: ${turn.said.slice(0, 600)}`).toBeGreaterThanOrEqual(2);
});
