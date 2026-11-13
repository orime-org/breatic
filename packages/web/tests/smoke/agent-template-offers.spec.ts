// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The agent offers a character template (inner#1807): when the user asks
 * for consistent shots of one character outright, it reads one of the
 * character templates and the proposal built on it lands; when the user
 * attaches a photo of a character and only asks for two videos of it, what
 * lands for both carries that character, whether through a template
 * or a setup of its own. The same for the pet selfie vlog (inner#1816): asked
 * outright for a pet video it builds on that template; given only a pet photo
 * and a request for a video, what lands carries the pet. And sound (inner#1825):
 * given a video and asked outright for background music, it builds on a music
 * template; given the video and asked only to finish it, what lands offers an
 * audio generation.
 *
 * Each message is what a user would write, with nothing forbidding questions:
 * when the agent first asks what only the user knows, the case answers in the
 * chat the way that user would, and judges what lands after the answer.
 *
 * Real model turns:
 *
 *   pnpm --filter @breatic/web test:smoke tests/smoke/agent-template-offers.spec.ts
 */
import { join } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { ATTACHMENT_DATA_PART, GENERATION_TEMPLATES, feedsOf, proposalMarkSegments, templateAnchor, type CanvasProposal } from '@breatic/shared';
import { test } from '../helpers/slot';
import { askInNewConversation, storedMessages, type StoredPart } from '../helpers/conversation';

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
 * The generations in a proposal that draw on a file the user attached,
 * through an edge or a filled slot, directly or through generations between.
 * @param proposal - The proposal, as the agent sent it.
 * @param counts - Which generations to take.
 * @param attached - The addresses of the files the user attached.
 * @returns The generations.
 */
function generationsCarryingMaterial(
  proposal: CanvasProposal,
  counts: (node: CanvasProposal['nodes'][number]) => boolean,
  attached: ReadonlySet<string>,
): CanvasProposal['nodes'] {
  const fed = new Map<number, number[]>();
  for (const { fromIndex, toIndex } of feedsOf(proposal)) fed.set(toIndex, [...(fed.get(toIndex) ?? []), fromIndex]);
  const carries = (at: number, seen: Set<number>): boolean => {
    const node = proposal.nodes[at];
    return (node?.material !== undefined && attached.has(node.material)) ||
      (fed.get(at) ?? []).some((from) => !seen.has(from) && carries(from, new Set([...seen, from])));
  };
  return proposal.nodes.filter((node, at) => node.role === 'generate' && counts(node) && carries(at, new Set([at])));
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
 * @param attached - The addresses of the files the user attached: the video.
 * @param counts - Which audio generations count, by their model.
 * @returns The count.
 */
function audioForVideo(
  proposal: CanvasProposal,
  takesVideo: ReadonlySet<string>,
  attached: ReadonlySet<string>,
  counts: (model: string) => boolean = () => true,
): number {
  const fits = (node: CanvasProposal['nodes'][number], slotted: boolean): boolean => {
    const model = modelOf(node) ?? '';
    return node.type === 'audio' && counts(model) && takesVideo.has(model) === slotted;
  };
  const drawing = generationsCarryingMaterial(proposal, (node) => fits(node, true), attached).length;
  const carried = proposal.nodes.some((node) => node.material !== undefined && attached.has(node.material));
  const beside = carried ? proposal.nodes.filter((node) => node.role === 'generate' && fits(node, false)).length : 0;
  return drawing + beside;
}

/**
 * The words a generation sends to its model: its text segments in order,
 * notes and slots left out.
 * @param node - The node, as the agent sent it.
 * @returns The words.
 */
function wordsOf(node: CanvasProposal['nodes'][number]): string {
  return proposalMarkSegments(node).map((segment) => segment.text ?? '').join(' ');
}

/**
 * Whether what landed answers a request for a video: a video, or two or more
 * takes of its first frame for the user to pick from, the video following
 * from the picked take.
 * @param made - The generations that landed for it.
 * @returns Whether it answers.
 */
function answersVideoAsk(made: CanvasProposal['nodes']): boolean {
  return made.some((node) => node.type === 'video') || made.filter((node) => node.type === 'image').length >= 2;
}

/** What the newest stored conversation's turns did and said. */
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
  /** The addresses of the files the user attached to the conversation. */
  attached: Set<string>;
}

/**
 * What the newest conversation's agent turns did and said, once the reply to
 * the newest message is stored.
 * @param p - The signed-in page.
 * @returns What the turns did and said.
 */
async function settledTurn(p: Page): Promise<Turn> {
  const messages = await storedMessages(p);
  const parts = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts ?? []);
  const attached = messages.filter((m) => m.role === 'user').flatMap((m) => m.parts ?? [])
    .flatMap((part) => (part.type === ATTACHMENT_DATA_PART && typeof part.data?.data_snapshot?.url === 'string' ? [part.data.data_snapshot.url] : []));
  const input = (part: StoredPart): { id?: string; nodes?: { template?: { id?: string } }[] } => part.input ?? {};
  // A refused proposal answers { placed: false } and never reaches the canvas.
  const landed = parts.filter(
    (part) => part.type === 'tool-propose_canvas_action' && (part.output as { placed?: boolean } | undefined)?.placed === true,
  );
  return {
    tools: parts.flatMap((part) => (part.type?.startsWith('tool-') ? [part.type.slice('tool-'.length)] : [])),
    templates: landed.flatMap((part) => input(part).nodes ?? []).flatMap((node) => (node.template?.id ? [node.template.id] : [])),
    landed: landed.map((part) => part.input as unknown as CanvasProposal),
    read: parts.flatMap((part) =>
      part.type === 'tool-get_generation_template' && typeof part.output === 'string' && input(part).id ? [input(part).id as string] : [],
    ),
    said: parts.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : part.type?.startsWith('tool-ask_user') ? [JSON.stringify(part.input)] : [])).join('\n'),
    attached: new Set(attached),
  };
}

/**
 * Send one message in a new conversation and wait for the turn to end; when
 * the turn asks instead of proposing, answer in the chat and wait again.
 * @param message - What the user writes.
 * @param reply - What the user answers if the agent asks first.
 * @param attach - A fixture file to attach to the message.
 */
async function ask(message: string, reply: string, attach?: string): Promise<void> {
  await askInNewConversation(page, message, { reply, file: attach === undefined ? undefined : join(__dirname, '../fixtures', attach) });
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
  test.setTimeout(480_000);
  await ask(
    'I have one photo of my character, a courier in a red coat. Make three shots of her in a row and keep her exactly the same in all of them.',
    'She is Mika, a 25-year-old bicycle courier, cheerful and stubborn. I will put her photo in myself. The shots are for Instagram, vertical.',
  );
  const turn = await settledTurn(page);
  const proposed = turn.templates.filter((id) => CHARACTER_TEMPLATES.has(id));
  expect(proposed, `a landed proposal named a character template. Named: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}`).not.toEqual([]);
  // The template it proposed is one it also read in full.
  expect(turn.read, `read: ${turn.read.join(', ')}`).toEqual(expect.arrayContaining(proposed));
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 20_000 });
});

test('asked outright for a pet video, it reads the pet selfie vlog and lands a proposal built on it @needs-model', async () => {
  test.setTimeout(480_000);
  await ask('Make a funny vertical pet video of my dog for TikTok.', 'He is Bean, a goofy golden retriever who is always hungry. I will put his photo in myself.');
  const turn = await settledTurn(page);
  expect(turn.templates, `named: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}`).toContain('pet-selfie-vlog');
  expect(turn.read, `read: ${turn.read.join(', ')}`).toContain('pet-selfie-vlog');
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 20_000 });
});

test('asked outright for a cheese pull food video, it reads the food money shot and lands the dish @needs-model', async () => {
  test.setTimeout(480_000);
  await ask('Make a vertical food video of a pizza with a long cheese pull.', 'A margherita pizza from my restaurant, for Instagram Reels. I have no photo of it, so make the pizza too.');
  const turn = await settledTurn(page);
  expect(turn.read, `read: ${turn.read.join(', ')}; tools: ${turn.tools.join(', ')}`).toContain('food-money-shot');
  // Solved when the dish lands as a video or, with no photo of it, as takes of its look made first; built on
  // the template or on the agent's own setup drawing on it.
  const made = turn.landed.flatMap((proposal) => proposal.nodes).filter((node) => node.role === 'generate');
  expect(answersVideoAsk(made), `made: ${made.map((node) => node.type).join(', ')}; named: ${turn.templates.join(', ')}; said: ${turn.said.slice(0, 600)}`).toBe(true);
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 20_000 });
});

test('asked outright for a festival travel poster, it reads the festival poster and lands a picture @needs-model', async () => {
  test.setTimeout(480_000);
  await ask('Make a festival travel poster for Kyoto in the autumn maple season, with the title KYOTO AUTUMN.', 'A vertical poster for Instagram; the title is KYOTO AUTUMN exactly as written.');
  const turn = await settledTurn(page);
  expect(turn.read, `read: ${turn.read.join(', ')}; tools: ${turn.tools.join(', ')}`).toContain('destination-festival-poster');
  // Every brace is answered and the template takes no material, so what lands is built on it.
  expect(turn.templates, `named: ${turn.templates.join(', ')}; said: ${turn.said.slice(0, 600)}`).toContain('destination-festival-poster');
  const pictures = turn.landed.flatMap((proposal) => proposal.nodes).filter((node) => node.role === 'generate' && node.type === 'image');
  expect(pictures.length, `said: ${turn.said.slice(0, 600)}`).toBeGreaterThanOrEqual(1);
  // The title the user gave goes into every version's prompt as written.
  for (const picture of pictures) expect(wordsOf(picture), picture.name).toContain('KYOTO AUTUMN');
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 20_000 });
});

for (const [what, reply, photo] of [
  ['dish', 'It is our margherita pizza, for the restaurant\'s Instagram, vertical.', 'dish.jpg'],
  ['pet', 'He is Bean, my golden retriever; a funny vertical video for TikTok.', 'pet.jpg'],
]) {
  test(`given a ${what} photo and asked only for a video of it, what lands carries that ${what} @needs-model`, async () => {
    test.setTimeout(480_000);
    await ask('Make a video with this.', reply, photo);
    const turn = await settledTurn(page);
    // Solved when what draws on the photo answers the request for a video;
    // through a template or a setup of the agent's own.
    const carrying = turn.landed.flatMap((proposal) => generationsCarryingMaterial(proposal, () => true, turn.attached));
    expect(answersVideoAsk(carrying), `generations drawing on the photo: ${carrying.map((node) => node.type).join(', ')}; templates: ${turn.templates.join(', ')}; said: ${turn.said.slice(0, 600)}`).toBe(true);
  });
}

test('given a character photo and asked for two videos of her, what lands for both carries that character @needs-model', async () => {
  test.setTimeout(480_000);
  await ask('This is my character. I want two short videos of her: one walking through a park, one sitting in a café.', 'She is Mika, a 25-year-old bicycle courier, cheerful and stubborn; both videos are vertical, for Instagram.', 'character.jpg');
  const turn = await settledTurn(page);
  // Solved when what lands for each scene draws on her photo: its video, or
  // takes of its still made first, the video following from the picked take;
  // through a template or a setup of the agent's own.
  // Each scene needs a generation of its own: one naming the park and a
  // different one naming the cafe, the two not naming the same places; either
  // may still mention the other place.
  const words = turn.landed.flatMap((proposal) => generationsCarryingMaterial(proposal, () => true, turn.attached)).map(wordsOf);
  const park = (text: string): boolean => /\bparks?\b/i.test(text);
  const cafe = (text: string): boolean => /\bcaf[eé]|\bcoffee ?(shop|house)/i.test(text);
  const seen = `generations drawing on the photo: ${words.join('\n').slice(0, 600)}; templates: ${turn.templates.join(', ')}; said: ${turn.said.slice(0, 600)}`;
  expect(words.some((one, at) => park(one) && words.some((other, otherAt) => otherAt !== at && cafe(other) && !(cafe(one) && park(other)))), seen).toBe(true);
});

test('given a video and asked outright for background music, it reads a music template and lands music on that template\'s model drawing on the video @needs-model', async () => {
  test.setTimeout(480_000);
  await ask('Add background music to this video.', 'It is a home workout clip for my fitness channel on YouTube; upbeat music with no vocals.', 'mini-tools/driving.mp4');
  const turn = await settledTurn(page);
  const read = turn.read.filter((id) => MUSIC_FOR_VIDEO.includes(id));
  expect(read, `read a music template. Read: ${turn.read.join(', ')}; tools: ${turn.tools.join(', ')}`).not.toEqual([]);
  // Solved when music on a model a read template runs answers for the
  // video, whether the proposal names the template or the agent built it.
  const models = new Set(GENERATION_TEMPLATES.filter((template) => read.includes(template.id)).map((template) => templateAnchor(template).model));
  const takesVideo = await videoTakers(page);
  const scoring = turn.landed.reduce((count, proposal) => count + audioForVideo(proposal, takesVideo, turn.attached, (model) => models.has(model)), 0);
  expect(scoring, `music on ${[...models].join(', ')} for the video. Audio generations: ${String(audioGenerations(turn))}; templates: ${turn.templates.join(', ')}; said: ${turn.said.slice(0, 600)}`).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 20_000 });
});

test('given a video with no sound and asked only to finish it, what lands offers music or foley for it @needs-model', async () => {
  test.setTimeout(480_000);
  // The clip has no audio stream at all, so the missing sound is what is left to finish.
  await ask('Help me finish this.', 'It is a home workout clip for my fitness channel on YouTube, and it has no sound yet.', 'mini-tools/driving-silent.mp4');
  const turn = await settledTurn(page);
  // Solved when a landed proposal offers sound for the video, whether through a sound template or a setup of the agent's own.
  const takesVideo = await videoTakers(page);
  const scoring = turn.landed.reduce((count, proposal) => count + audioForVideo(proposal, takesVideo, turn.attached), 0);
  expect(scoring, `audio generations for the video: ${String(scoring)} of ${String(audioGenerations(turn))}; read: ${turn.read.join(', ')}; templates: ${turn.templates.join(', ')}; tools: ${turn.tools.join(', ')}; said: ${turn.said.slice(0, 600)}`).toBeGreaterThanOrEqual(1);
});
