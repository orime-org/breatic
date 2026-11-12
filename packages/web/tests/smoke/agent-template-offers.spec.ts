// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The agent offers a character template (inner#1807): when the user asks
 * for consistent shots of one character outright, it reads one of the
 * character templates and the proposal built on it lands; when the user
 * attaches a photo of a character and only asks for two videos of it, what
 * lands carries that character into both videos, whether through a template
 * or a setup of its own. The same for the pet selfie vlog (inner#1816): asked
 * outright for a pet video it builds on that template; given only a pet photo
 * and a request for a video, what lands carries the pet. And sound (inner#1825):
 * given a video and asked outright for background music, it builds on a music
 * template; given the video and asked only to finish it, what lands offers an
 * audio generation.
 *
 * Real model turns:
 *
 *   pnpm --filter @breatic/web test:smoke tests/smoke/agent-template-offers.spec.ts
 */
import { basename, join } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { GENERATION_TEMPLATES, feedsOf, templateAnchor, type CanvasProposal } from '@breatic/shared';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

/** The ids of the templates that serve the character goal. */
const CHARACTER_TEMPLATES = new Set(GENERATION_TEMPLATES.filter((template) => template.goal === 'character').map((template) => template.id));

/** The music templates a video's background music is built on. */
const MUSIC_FOR_VIDEO = ['underscore-bgm', 'score-for-my-video'];

/**
 * How many audio generations the landed proposals offer.
 * @param turn - The turn.
 * @returns The count.
 */
function audioGenerations(turn: Turn): number {
  return turn.landed.reduce((count, proposal) => count + proposal.nodes.filter((node) => node.type === 'audio' && node.role === 'generate').length, 0);
}

let page: Page;
let spaceId = '';

/**
 * How many generations in a proposal draw on the material it carries,
 * through an edge or a filled slot, directly or through generations between.
 * @param proposal - The proposal, as the agent sent it.
 * @param counts - Which generations to count.
 * @param kind - The kind of material they must draw on; any when left out.
 * @returns The count.
 */
function generationsCarryingMaterial(
  proposal: CanvasProposal,
  counts: (node: CanvasProposal['nodes'][number]) => boolean,
  kind?: CanvasProposal['nodes'][number]['type'],
): number {
  const fed = new Map<number, number[]>();
  for (const { fromIndex, toIndex } of feedsOf(proposal)) fed.set(toIndex, [...(fed.get(toIndex) ?? []), fromIndex]);
  const carries = (at: number, seen: Set<number>): boolean => {
    const node = proposal.nodes[at];
    return (node?.material !== undefined && (kind === undefined || node.type === kind)) ||
      (fed.get(at) ?? []).some((from) => !seen.has(from) && carries(from, new Set([...seen, from])));
  };
  return proposal.nodes.filter((node, at) => node.role === 'generate' && counts(node) && carries(at, new Set([at]))).length;
}

/**
 * The model a proposed generation runs on: its own, or, sent with a template
 * and no model of its own, the one its template node keeps (the anchor's
 * without a key).
 * @param node - The node, as the agent sent it.
 * @returns The model, or undefined when neither names one.
 */
function modelOf(node: CanvasProposal['nodes'][number]): string | undefined {
  if (node.model !== undefined) return node.model;
  const tag = (node as { template?: { id?: string; key?: string } }).template;
  const template = GENERATION_TEMPLATES.find((one) => one.id === tag?.id);
  if (template === undefined) return undefined;
  const own = template.nodes.find((one) => one.key === (tag?.key ?? template.anchor));
  return own?.role === 'generate' ? own.model : undefined;
}

/**
 * The models whose params declare a slot taking a video, read off the
 * catalog the page is served.
 * @param p - The signed-in page.
 * @returns Their names.
 */
async function videoTakers(p: Page): Promise<Set<string>> {
  const names = await p.evaluate(async () => {
    const answer = await (await fetch('/api/v1/models', { credentials: 'include' })).json();
    const catalog = (answer?.data ?? answer) as Record<string, unknown>;
    return Object.values(catalog).flatMap((bucket) =>
      Array.isArray(bucket)
        ? (bucket as { name: string; params?: Record<string, { accepts?: string }> }[])
          .filter((model) => Object.values(model.params ?? {}).some((param) => param.accepts === 'video'))
          .map((model) => model.name)
        : [],
    );
  });
  return new Set(names);
}

/**
 * How many audio generations in a proposal answer for the user's video: on a
 * model with a slot taking a video, one that draws on the video; on a model
 * with none (a background-music model), one standing in a proposal that
 * carries the video.
 * @param proposal - The proposal, as the agent sent it.
 * @param takesVideo - The models with a slot taking a video.
 * @param counts - Which audio generations count, by their model.
 * @returns The count.
 */
function audioForVideo(proposal: CanvasProposal, takesVideo: ReadonlySet<string>, counts: (model: string) => boolean = () => true): number {
  const fits = (node: CanvasProposal['nodes'][number], slotted: boolean): boolean => {
    const model = modelOf(node) ?? '';
    return node.type === 'audio' && counts(model) && takesVideo.has(model) === slotted;
  };
  const drawing = generationsCarryingMaterial(proposal, (node) => fits(node, true), 'video');
  const carried = proposal.nodes.some((node) => node.type === 'video' && node.material !== undefined);
  const beside = carried ? proposal.nodes.filter((node) => node.role === 'generate' && fits(node, false)).length : 0;
  return drawing + beside;
}

/**
 * How many generated videos in a proposal draw on the material it carries.
 * @param proposal - The proposal, as the agent sent it.
 * @returns The count.
 */
function videosCarryingMaterial(proposal: CanvasProposal): number {
  return generationsCarryingMaterial(proposal, (node) => node.type === 'video');
}

/** What the newest stored conversation's turn did and said. */
interface Turn {
  /** Each tool it used, in order. */
  tools: string[];
  /** Each template id its landed proposals named. */
  templates: string[];
  /** The landed proposals, as sent. */
  landed: CanvasProposal[];
  /** Each template id it read in full, counting only reads that answered. */
  read: string[];
  /** Everything it wrote or asked, as one text. */
  said: string;
  /** Whether its reply is stored yet. */
  stored: boolean;
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
    // A refused proposal answers { placed: false } and never reaches the canvas.
    const landed = parts.filter(
      (part) => part.type === 'tool-propose_canvas_action' && (part.output as { placed?: boolean } | undefined)?.placed === true,
    );
    return {
      tools: parts.flatMap((part) => (part.type?.startsWith('tool-') ? [part.type.slice('tool-'.length)] : [])),
      templates: landed.flatMap((part) => part.input?.nodes ?? []).flatMap((node) => (node.template?.id ? [node.template.id] : [])),
      landed: landed.map((part) => part.input as unknown as CanvasProposal),
      read: parts.flatMap((part) =>
        part.type === 'tool-get_generation_template' && typeof part.output === 'string' && part.input?.id ? [part.input.id] : [],
      ),
      said: parts.map((part) => (part.type === 'text' ? (part.text ?? '') : part.type?.startsWith('tool-ask_user') ? JSON.stringify(part.input) : '')).join('\n'),
      stored: messages.some((m) => m.role === 'assistant'),
    };
  });
}

/**
 * The newest turn once its reply is stored: the turn's end on screen can come
 * before the server writes the reply, which it writes whole.
 * @param p - The signed-in page.
 * @returns What the turn did and said.
 */
async function settledTurn(p: Page): Promise<Turn> {
  let turn = await lastTurn(p);
  await expect
    .poll(async () => {
      turn = await lastTurn(p);
      return turn.stored;
    }, { timeout: 30_000 })
    .toBe(true);
  return turn;
}

/**
 * Send one message in a new conversation and wait for the turn to end.
 * @param message - What the user writes.
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
    await expect(page.getByTestId('chat-composer-chips')).toContainText(basename(attach), { timeout: 30_000 });
  }
  await composer.fill(message);
  // Attachments still uploading hold the send back; a press before then is
  // ignored, so wait for the button the user would see light up.
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
  // The template it proposed is one it also read in full.
  expect(turn.read, `read: ${turn.read.join(', ')}`).toEqual(expect.arrayContaining(proposed));
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 20_000 });
});

test('asked outright for a pet video, it reads the pet selfie vlog and lands a proposal built on it @needs-model', async () => {
  test.setTimeout(240_000);
  await ask('Make a funny vertical pet video of my dog for TikTok. Do not ask me anything, just propose it.');
  const turn = await settledTurn(page);
  expect(turn.templates, `named: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}`).toContain('pet-selfie-vlog');
  expect(turn.read, `read: ${turn.read.join(', ')}`).toContain('pet-selfie-vlog');
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 20_000 });
});

test('asked outright for a cheese pull food video, it reads the food money shot and lands a video @needs-model', async () => {
  test.setTimeout(240_000);
  await ask('Make a vertical food video of a pizza with a long cheese pull. Do not ask me anything, just propose it.');
  const turn = await settledTurn(page);
  expect(turn.read, `read: ${turn.read.join(', ')}; tools: ${turn.tools.join(', ')}`).toContain('food-money-shot');
  // Solved when a video lands, whether built on the template or on the agent's own setup drawing on it: with no
  // photo of the dish, the agent may write the template's craft into a setup of its own.
  const videos = turn.landed.flatMap((proposal) => proposal.nodes).filter((node) => node.role === 'generate' && node.type === 'video');
  expect(videos.length, `named: ${turn.templates.join(', ')}; said: ${turn.said.slice(0, 600)}`).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 20_000 });
});

test('given a dish photo and asked only for a video of it, it lands a video carrying that dish @needs-model', async () => {
  test.setTimeout(240_000);
  await ask('Make a video with this. Do not ask me anything, just propose it.', 'dish.jpg');
  const turn = await settledTurn(page);
  // Solved when a video draws on the photo, whether through a food template or a setup of the agent's own.
  const carrying = turn.landed.reduce((count, proposal) => count + videosCarryingMaterial(proposal), 0);
  expect(carrying, `videos drawing on the photo. Templates: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}; said: ${turn.said.slice(0, 600)}`).toBeGreaterThanOrEqual(1);
});

test('given a pet photo and asked only for a video of it, it lands a video carrying that pet @needs-model', async () => {
  test.setTimeout(240_000);
  await ask('Make a video with this. Do not ask me anything, just propose it.', 'pet.jpg');
  const turn = await settledTurn(page);
  // Solved when a video draws on the photo, whether through the pet template or a setup of the agent's own.
  const carrying = turn.landed.reduce((count, proposal) => count + videosCarryingMaterial(proposal), 0);
  expect(carrying, `videos drawing on the photo. Templates: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}; said: ${turn.said.slice(0, 600)}`).toBeGreaterThanOrEqual(1);
});

test('given a character photo and asked for two videos of her, it lands both videos carrying that character @needs-model', async () => {
  test.setTimeout(240_000);
  await ask('This is my character. I want two short videos of her: one walking through a park, one sitting in a café. Do not ask me anything, just propose it.', 'character.jpg');
  const turn = await settledTurn(page);
  // What the user asked for is solved when both videos draw on her photo,
  // whether through a template or a setup of the agent's own.
  const carrying = turn.landed.reduce((count, proposal) => count + videosCarryingMaterial(proposal), 0);
  expect(carrying, `videos drawing on the photo in landed proposals. Templates: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}; said: ${turn.said.slice(0, 600)}`).toBeGreaterThanOrEqual(2);
});

test('given a video and asked outright for background music, it reads a music template and lands music on that template\'s model drawing on the video @needs-model', async () => {
  test.setTimeout(240_000);
  await ask('Add background music to this video. Do not ask me anything, just propose it.', 'mini-tools/driving.mp4');
  const turn = await settledTurn(page);
  const read = turn.read.filter((id) => MUSIC_FOR_VIDEO.includes(id));
  expect(read, `read a music template. Read: ${turn.read.join(', ')}; tools: ${turn.tools.join(', ')}`).not.toEqual([]);
  // Solved when music on a model a read template runs answers for the
  // video, whether the proposal names the template or the agent built it.
  const models = new Set(GENERATION_TEMPLATES.filter((template) => read.includes(template.id)).map((template) => templateAnchor(template).model));
  const takesVideo = await videoTakers(page);
  const scoring = turn.landed.reduce((count, proposal) => count + audioForVideo(proposal, takesVideo, (model) => models.has(model)), 0);
  expect(scoring, `music on ${[...models].join(', ')} for the video. Audio generations: ${String(audioGenerations(turn))}; templates: ${turn.templates.join(', ')}; said: ${turn.said.slice(0, 600)}`).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 20_000 });
});

test('given a video with no sound and asked only to finish it, what lands offers music or foley for it @needs-model', async () => {
  test.setTimeout(240_000);
  // The clip has no audio stream at all, so the missing sound is what is left to finish.
  await ask('Help me finish this. Do not ask me anything, just propose it.', 'mini-tools/driving-silent.mp4');
  const turn = await settledTurn(page);
  // Solved when a landed proposal offers sound for the video, whether through a sound template or a setup of the agent's own.
  const takesVideo = await videoTakers(page);
  const scoring = turn.landed.reduce((count, proposal) => count + audioForVideo(proposal, takesVideo), 0);
  expect(scoring, `audio generations for the video: ${String(scoring)} of ${String(audioGenerations(turn))}; read: ${turn.read.join(', ')}; templates: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}; said: ${turn.said.slice(0, 600)}`).toBeGreaterThanOrEqual(1);
});
