// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Real runs of the generation templates, for judging a prompt by the pictures it gets (inner#1846, inner#1816).
 * Each run applies the template from the panel, fills the braces, checks that the editor shows the
 * prompt the locale file holds, presses Generate and saves the picture with its prompt. It spends
 * credits, so it carries @needs-model and the default smoke run leaves it out; each generate node runs at
 * its model's lowest resolution, keeping the template's duration and ratio.
 *
 * Environment: TEMPLATE_RUN_ONLY picks one template, TEMPLATE_RUN_REPEAT runs each that many times,
 * TEMPLATE_RUN_LABEL tags the files of one round, TEMPLATE_RUN_OUT is where they go (default
 * test-results/template-runs), TEMPLATE_RUN_IMAGE is the character picture (default the fixture),
 * TEMPLATE_RUN_LOCALE switches the interface language for the run; the sound templates' words are Chinese, written for
 * TEMPLATE_RUN_LOCALE=zh-CN (their braces come in the same order in every locale). TEMPLATE_RUN_ASK instead sends that request to the
 * Agent with the picture attached (TEMPLATE_RUN_ASK_IMAGE names another fixture, empty for none) and generates the node
 * its proposal places; TEMPLATE_RUN_ASK_ONLY stops once the turn is recorded.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { expect, type Locator, type Page } from 'playwright/test';
import { GENERATION_TEMPLATES, markedSegments } from '@breatic/shared';
import { test } from '../helpers/slot';
import { switchLanguage } from '../helpers/language';

import { openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { dropFile } from '../helpers/upload';
import { startNewConversation } from '../helpers/conversation';
import { seedNode, wire } from '../helpers/mini-tool';

const OUT = process.env.TEMPLATE_RUN_OUT ?? join(__dirname, '../../test-results/template-runs');
const FIXTURES = join(__dirname, '../fixtures');
const CHARACTER = process.env.TEMPLATE_RUN_IMAGE ?? join(FIXTURES, 'character.jpg');
const LABEL = process.env.TEMPLATE_RUN_LABEL ?? 'run';
const REPEAT = Number(process.env.TEMPLATE_RUN_REPEAT ?? '1');
const LOCALE = process.env.TEMPLATE_RUN_LOCALE;
const LOCALE_FILE = join(__dirname, `../../../../locales/${LOCALE ?? 'en'}.json`);
mkdirSync(OUT, { recursive: true });

/**
 * A string as the locale file on disk holds it. A dev server started before a locale edit serves the old one.
 * @param key - The message key, e.g. `canvas.template.character-bible.prompt`.
 * @returns The string.
 */
function fromLocale(key: string): string {
  let at: unknown = JSON.parse(readFileSync(LOCALE_FILE, 'utf8'));
  for (const part of key.split('.')) at = at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[part] : undefined;
  if (typeof at !== 'string') throw new Error(`no string at ${key} in the locale file`);
  return at;
}

/**
 * A prompt cut at every chip and brace into the literal pieces the editor must show in order.
 * @param key - The prompt's key.
 * @returns The pieces.
 */
function draftPieces(key: string): string[] {
  return markedSegments(fromLocale(key)).flatMap((segment) => (segment.text?.trim() ? [segment.text.trim()] : []));
}

/**
 * Fail unless every literal piece of the on-disk draft appears in order in the editor's text.
 * @param key - The prompt's key.
 * @param shown - The editor's text.
 */
function assertDraftSent(key: string, shown: string): void {
  let from = 0;
  for (const piece of draftPieces(key)) {
    const at = shown.indexOf(piece, from);
    if (at < 0) throw new Error(`the editor does not show the draft piece: ${piece.slice(0, 120)}`);
    from = at + piece.length;
  }
}

test.use({ viewport: { width: 1600, height: 1000 } });

/** A generate node's type. */
type Kind = 'image' | 'video' | 'audio';

let page: Page;
let projectId = '';
let spaceId = '';

interface NodeView {
  id: string;
  type: string;
  data: { name?: string; content?: string; templateNode?: { key: string }; taskCounts?: { running: number; done: number; failed: number } };
}

/** The open Space's nodes and edges. */
async function graph(): Promise<{ nodes: NodeView[]; edges: { source: string; target: string }[] }> {
  const at = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, url]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as { readCanvasGraph: (p: string, s: string) => unknown };
      return JSON.parse(JSON.stringify(canvas.readCanvasGraph(pid, sid)));
    },
    [projectId, spaceId, at] as [string, string, string],
  );
}

/** Fit every node into view. */
async function fit(): Promise<void> {
  await page.keyboard.press('Escape');
  await page.getByTestId('viewport-toolbar').getByRole('button', { name: fromLocale('viewportToolbar.fitAria'), exact: true }).click();
  await page.waitForTimeout(600);
}

/** Open the generate panel of a node. */
async function openPanel(nodeId: string): Promise<void> {
  await fit();
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  // A result taller than the empty card grows its node over the one below, so the menu is opened on
  // the node itself rather than by a click at its point on screen.
  const box = await node.boundingBox();
  if (!box) throw new Error(`node ${nodeId} has no box`);
  await node.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.x + box.width / 2, clientY: box.y + 8 });
  await page.getByTestId('node-menu-generate').click();
  // A node in multi-shot mode shows its shots in place of the prompt.
  await expect(page.getByTestId('generate-prompt-editor').or(page.getByTestId('generate-storyboard-shot-1-editor'))).toBeVisible({ timeout: 15_000 });
}

/** Pick a template from the open panel, under its own goal. */
async function applyTemplate(id: string): Promise<void> {
  const goal = GENERATION_TEMPLATES.find((template) => template.id === id)?.goal;
  if (goal === undefined) throw new Error(`no template ${id}`);
  await page.getByTestId('generate-template-trigger').click();
  const box = await page.getByTestId(`generate-template-goal-${goal}`).boundingBox();
  if (!box) throw new Error(`no ${goal} goal row`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.getByTestId(`generate-template-${id}`).click();
  await page.waitForTimeout(1500);
}

/**
 * Replace each brace span in one editor of the open panel, in order, the way a user selects and types.
 * @param values - What each brace span becomes.
 * @param editorId - The editor's test id: the prompt, or one shot's.
 */
async function fillBraces(values: string[], editorId = 'generate-prompt-editor'): Promise<void> {
  const editor = page.getByTestId(editorId);
  for (const value of values) {
    const found = await editor.evaluate((root) => {
      const ce = (root.matches('[contenteditable="true"]') ? root : root.querySelector('[contenteditable="true"]')) as HTMLElement | null;
      if (ce === null) return false;
      ce.focus();
      const walker = document.createTreeWalker(ce, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        const s = n.textContent ?? '';
        const a = s.indexOf('{');
        const b = a < 0 ? -1 : s.indexOf('}', a);
        if (b < 0) continue;
        const range = document.createRange();
        range.setStart(n, a);
        range.setEnd(n, b + 1);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return true;
      }
      return false;
    });
    if (!found) throw new Error(`no braces left for "${value}"`);
    await page.waitForTimeout(150);
    await page.keyboard.type(value);
  }
  await expect(editor).not.toContainText('{');
}

/**
 * Open one shot of the open multi-shot panel through its row, the way a user does, unless it is open already:
 * only one shot is open at a time, and a folded shot takes no typing.
 * @param n - The shot's number, from 1.
 */
async function openShot(n: number): Promise<void> {
  const toggle = page.getByTestId(`generate-storyboard-shot-${String(n)}-toggle`);
  if ((await toggle.getAttribute('aria-expanded')) === 'true') return;
  await bringIntoView(toggle);
  await toggle.click();
  await expect(page.getByTestId(`generate-storyboard-shot-${String(n)}-editor`).locator('.ProseMirror')).toBeFocused();
}

/**
 * Scroll the canvas up over an empty spot until a control of the open panel clears the viewport toolbar, the way
 * a user does when a tall panel (five shots) runs off the bottom of the screen; a plain wheel pans the canvas.
 * @param control - The control to reach.
 */
async function bringIntoView(control: Locator): Promise<void> {
  /**
   * How far the control still reaches past the top of the viewport toolbar.
   * @returns The overlap in pixels; zero or less once it is clear.
   */
  const overlap = async (): Promise<number> => {
    const box = await control.boundingBox();
    const toolbar = await page.getByTestId('viewport-toolbar').boundingBox();
    return box && toolbar ? box.y + box.height - toolbar.y + 8 : 0;
  };
  if ((await overlap()) <= 0) return;
  const spot = await visibleSpace(page).evaluate((root) => {
    const pane = root.querySelector('.react-flow__pane')?.getBoundingClientRect();
    if (!pane) return null;
    for (let y = pane.top + 20; y < pane.bottom - 20; y += 20) {
      for (let x = pane.left + 80; x < pane.right - 80; x += 40) {
        if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
      }
    }
    return null;
  });
  if (spot === null) throw new Error('no empty spot to scroll the canvas over');
  await page.mouse.move(spot.x, spot.y);
  // The canvas pans by a fraction of each wheel step, so it scrolls until the control is clear.
  for (let step = 0; step < 10 && (await overlap()) > 0; step += 1) {
    await page.mouse.wheel(0, (await overlap()) + 100);
    await page.waitForTimeout(400);
  }
  expect(await overlap()).toBeLessThanOrEqual(0);
}

/**
 * Pick the open panel's lowest resolution, the way a user does. A run judges a template's words against its
 * duration and ratio, which it keeps; resolution changes neither, so the run pays for the cheapest tier.
 */
async function lowestResolution(): Promise<void> {
  const trigger = page.getByTestId('generate-ratio-trigger');
  if ((await trigger.count()) === 0) return;
  await trigger.click();
  const prefix = 'generate-resolution-option-';
  const values = (await page.locator(`[data-testid^="${prefix}"]`).evaluateAll((all) => all.map((one) => one.getAttribute('data-testid') ?? '')))
    .map((id) => id.slice(prefix.length));
  const size = (value: string): number => Number.parseFloat(value) * (/k$/i.test(value) ? 1000 : 1);
  const lowest = [...values].sort((a, b) => size(a) - size(b))[0];
  if (lowest !== undefined) await page.getByTestId(`${prefix}${lowest}`).click();
  await trigger.click();
}

/** Each node type's Generate button. */
const EXECUTE: Record<Kind, string> = { image: 'generate-execute', video: 'generate-video-execute', audio: 'generate-audio-execute' };

/** Each node type's file extension for a saved result. */
const EXTENSION: Record<Kind, string> = { image: 'png', video: 'mp4', audio: 'mp3' };

/** Press Generate on the open panel and wait until the node holds a new result. */
async function generate(nodeId: string, kind: Kind): Promise<string> {
  const before = (await graph()).nodes.find((n) => n.id === nodeId)?.data.content ?? '';
  await lowestResolution();
  const button = page.getByTestId(EXECUTE[kind]);
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await bringIntoView(button);
  await button.click();
  let content = '';
  let state = '';
  // Stops on the first answer, done or failed, so a failed task does not wait out the whole timeout.
  await expect
    .poll(
      async () => {
        const node = (await graph()).nodes.find((n) => n.id === nodeId);
        content = node?.data.content ?? '';
        state = (node?.data.taskCounts?.failed ?? 0) > 0
          ? 'failed'
          : content !== '' && content !== before && (node?.data.taskCounts?.running ?? 0) === 0 ? 'done' : 'waiting';
        return state;
      },
      { timeout: 1_500_000, intervals: [5_000] },
    )
    .not.toBe('waiting');
  expect(state).toBe('done');
  return content;
}

/**
 * The text one editor of the open panel shows.
 * @param editorId - The editor's test id: the prompt, or one shot's.
 * @returns Its text.
 */
async function promptText(editorId = 'generate-prompt-editor'): Promise<string> {
  return (await page.getByTestId(editorId).innerText()).trim();
}

/**
 * Pick a node into one frame of the open video panel, the way a user does: the frame, then the
 * part of the node still showing, since a tall result next to it can cover its centre.
 * @param slot - The frame.
 * @param nodeId - The node.
 * @throws {Error} When no part of the node is showing.
 */
async function pickIntoFrame(slot: 'first-frame' | 'end-frame', nodeId: string): Promise<void> {
  await page.getByTestId(`generate-video-tool-${slot}`).click();
  const point = await visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`).evaluate((node) => {
    const box = node.getBoundingClientRect();
    for (let y = 0.1; y < 1; y += 0.1) {
      for (let x = 0.1; x < 1; x += 0.1) {
        const at = { x: box.left + box.width * x, y: box.top + box.height * y };
        if (document.elementFromPoint(at.x, at.y)?.closest('.react-flow__node') === node) return at;
      }
    }
    return null;
  });
  if (point === null) throw new Error(`no part of node ${nodeId} is showing`);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId(`generate-video-${slot}-thumbnail`)).toBeVisible({ timeout: 30_000 });
}

/**
 * Save a result under the run's output folder. The test's own time limit bounds the download, since a sheet can be 15 MB and a fixed request limit fails a run that already generated.
 * @param url - The result's URL.
 * @param file - The file name to save it as.
 */
async function save(url: string, file: string): Promise<void> {
  writeFileSync(`${OUT}/${file}`, Buffer.from(await (await page.request.get(url, { timeout: 0, failOnStatusCode: true })).body()));
}

/** Append one record line. */
function record(entry: Record<string, unknown>): void {
  appendFileSync(`${OUT}/runs.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/**
 * The id of the node a template placed under a key.
 * @param key - The template node's key.
 * @returns Its id.
 */
async function keyed(key: string): Promise<string> {
  const node = (await graph()).nodes.find((n) => n.data.templateNode?.key === key);
  if (!node) throw new Error(`no node placed as ${key}`);
  return node.id;
}

/** Each dropped file's type and node type, by extension. */
const DROPPED: Record<string, { mime: string; kind: Kind }> = {
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.mp4': { mime: 'video/mp4', kind: 'video' },
  '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
};

/**
 * Drop a file onto the canvas and return its node once it holds the upload.
 * @param file - The file's path.
 * @param bytes - Its bytes, when they are not the file's own.
 * @returns The node's id.
 */
async function dropMedia(file: string, bytes: Buffer = readFileSync(file)): Promise<string> {
  const before = new Set((await graph()).nodes.map((n) => n.id));
  const ext = extname(file).toLowerCase();
  const dropped = DROPPED[ext];
  if (dropped === undefined) throw new Error(`no file type for ${ext}`);
  await dropFile(page, `${dropped.kind}-${Date.now()}${ext}`, dropped.mime, bytes);
  let id = '';
  await expect
    .poll(
      async () => {
        const node = (await graph()).nodes.find((n) => !before.has(n.id) && n.type === dropped.kind);
        id = node?.id ?? '';
        return node?.data.content ?? '';
      },
      { timeout: 120_000 },
    )
    .toMatch(/^https?:/);
  return id;
}

const STYLE = '3D cartoon';

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage();
  await openSmokeProject(page);
  if (LOCALE) await switchLanguage(page, LOCALE);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  spaceId = await createSpace(page, 'canvas', `template-run-${Date.now()}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const hide = page.getByTestId('viewport-toolbar').getByRole('button', { name: fromLocale('viewportToolbar.minimap.hide'), exact: true });
  if ((await hide.count()) > 0) await hide.click();
});

test.afterEach(async () => {
  try {
    await fit();
    await page.screenshot({ path: `${OUT}/${test.info().title.replace(/\s*@needs-model/, '').replace(/\s+/g, '-')}-${LABEL}-canvas.png` });
    await deleteSpace(page, spaceId);
  } finally {
    // The smoke account is shared, so its language goes back to English.
    if (LOCALE) await switchLanguage(page, 'en');
    await page.close();
  }
});

const INFO = 'Mika, bicycle courier, 25, cheerful, stubborn, curious, quick; racing the rain to deliver on time';

const AGENT_ASK = process.env.TEMPLATE_RUN_ASK;
const ASK_IMAGE = process.env.TEMPLATE_RUN_ASK_IMAGE === undefined ? CHARACTER : process.env.TEMPLATE_RUN_ASK_IMAGE === '' ? undefined : join(FIXTURES, process.env.TEMPLATE_RUN_ASK_IMAGE);

if (AGENT_ASK !== undefined) test('agent @needs-model', async () => {
  test.setTimeout(1_800_000);
  const composer = page.getByTestId('chat-composer-box');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await startNewConversation(page);
  if (ASK_IMAGE !== undefined) {
    await expect(page.getByTestId('chat-composer-attach')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('chat-composer-file-input').setInputFiles(ASK_IMAGE);
    await expect(page.getByTestId('chat-composer-chips')).toContainText(basename(ASK_IMAGE, extname(ASK_IMAGE)), { timeout: 30_000 });
  }
  await composer.fill(AGENT_ASK);
  const send = page.getByTestId('chat-composer-send');
  await expect(send).toBeEnabled({ timeout: 60_000 });
  await send.click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(2, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 600_000 });
  const turn = await page.evaluate(async () => {
    const list = await (await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })).json();
    return JSON.stringify((read?.data?.messages ?? []).filter((m: { role?: string }) => m.role === 'assistant').flatMap((m: { parts?: unknown[] }) => m.parts ?? []));
  });
  record({ template: 'agent', label: LABEL, ask: AGENT_ASK, parts: JSON.parse(turn) as unknown });
  // Recorded first, so a turn that ends without a proposal still shows what it did.
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 30_000 });
  if (process.env.TEMPLATE_RUN_ASK_ONLY !== undefined) return;
  const before = new Set((await graph()).nodes.map((n) => n.id));
  await page.getByTestId('proposal-card').last().getByTestId('proposal-use').click();
  let target = '';
  await expect
    .poll(async () => {
      target = (await graph()).nodes.find((n) => !before.has(n.id) && n.type === 'image' && (n.data.content ?? '') === '')?.id ?? '';
      return target;
    }, { timeout: 60_000 })
    .not.toBe('');
  await openPanel(target);
  const prompt = await promptText();
  const url = await generate(target, 'image');
  record({ template: 'agent', label: LABEL, result: { prompt, url } });
  await save(url, `agent-${LABEL}.png`);
});

const FEATURES = 'short black bob, red hooded raincoat, grey hoodie, yellow sneakers';

/** What every section of the score in four sections shares: genre, tempo, key and instruments. */
const SECTION_SHARED = ['温暖的原声民谣', '96 BPM', 'A 大调', '原声吉他、钢琴和轻打击乐'];

/** The intro's words before its length: the film, then what every section shares. */
const SECTION_FILM = ['一支两分钟的咖啡品牌片', ...SECTION_SHARED];

/**
 * The voice to clone: the speech fixture played twice over, 12.3 seconds of one speaker, since a clone takes 10
 * seconds or more and the fixture runs 6.1. Its frames are constant-rate MP3 with no tag, so the two copies join
 * into one playable file.
 */
const VOICE_SAMPLE = 'voice sample';

/**
 * A file a run wires in, from the fixtures.
 * @param media - Its path under the fixtures, or `voice sample`.
 * @returns The path it is dropped under and its bytes.
 */
function mediaOf(media: string): { file: string; bytes: Buffer } {
  if (media !== VOICE_SAMPLE) return { file: join(FIXTURES, media), bytes: readFileSync(join(FIXTURES, media)) };
  const speech = readFileSync(join(FIXTURES, 'mini-tools/speech.mp3'));
  return { file: join(FIXTURES, 'voice-sample.mp3'), bytes: Buffer.concat([speech, speech]) };
}

/**
 * Generate a short song with vocals on a node of its own, for a cover to redo: the lowest-cost model that sings
 * lyrics it is given.
 * @returns The node's id.
 */
async function generateSong(): Promise<string> {
  const id = crypto.randomUUID();
  await seedNode(page, { projectId, spaceId }, id, 'audio', -600, { name: 'song-run', state: 'idle' });
  await openPanel(id);
  await page.getByTestId('generate-audio-mode-trigger').click();
  await page.getByTestId('generate-audio-mode-t2m').click();
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-mureka-v9.5-generate-song').click();
  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('温暖的流行民谣，女声，原声吉他伴奏');
  await page.getByTestId('generate-prompt-group-lyrics-toggle').click();
  await expect(page.getByTestId('generate-lyrics-editor').locator('.ProseMirror')).toBeFocused();
  await page.keyboard.type('清晨的街角，面包刚出炉，我们慢慢走，不赶路');
  const url = await generate(id, 'audio');
  record({ template: 'song-cover', node: 'song', label: LABEL, result: { url } });
  return id;
}

/**
 * Pick the anchor's result into one slot of the open audio panel, the way a user does: the slot, then the part
 * of the anchor still showing.
 * @param slot - The slot's test-id stem, e.g. `sound-video`.
 * @param nodeId - The anchor.
 * @throws {Error} When no part of the anchor is showing.
 */
async function pickIntoAudioSlot(slot: string, nodeId: string): Promise<void> {
  await page.getByTestId(`generate-audio-tool-${slot}`).click();
  const point = await visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`).evaluate((node) => {
    const box = node.getBoundingClientRect();
    for (let y = 0.1; y < 1; y += 0.1) {
      for (let x = 0.1; x < 1; x += 0.1) {
        const at = { x: box.left + box.width * x, y: box.top + box.height * y };
        if (document.elementFromPoint(at.x, at.y)?.closest('.react-flow__node') === node) return at;
      }
    }
    return null;
  });
  if (point === null) throw new Error(`no part of node ${nodeId} is showing`);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId(`generate-audio-${slot}-clear`)).toBeVisible({ timeout: 30_000 });
}

/** How a template is run. */
interface Run {
  /** The anchor's node type. */
  type: Kind;
  /** Whether a picture is wired in: the character picture, or `image` from the fixtures. */
  photo: boolean;
  image?: string;
  /** A file of another kind wired in, from the fixtures: `voice sample` is the speech fixture played twice over. */
  media?: string;
  /** A song with vocals generated first and wired in: covers refuse an instrumental ("Cover mode needs a song with vocals"). */
  song?: boolean;
  /** The template nodes generated before the anchor. */
  first: string[];
  /** The template nodes generated after the anchor, each with the anchor's result picked into one of its slots first. */
  after?: { key: string; slot: string }[];
  /** What each node's braces are filled with, in order; `anchor` for the anchor. */
  fills: Record<string, string[]>;
  /** What each of the anchor's shots' braces are filled with, in order. */
  shots?: string[][];
  /** The template nodes picked into the anchor's frames once generated. */
  frames?: Partial<Record<'first-frame' | 'end-frame', string>>;
}

/** How each template is run. */
const RUNS: Record<string, Run> = {
  'character-bible': { type: 'image', photo: true, first: [], fills: { anchor: [INFO, STYLE] } },
  'expression-sheet': { type: 'image', photo: true, first: [], fills: { anchor: [STYLE] } },
  'costume-sheet': { type: 'image', photo: true, first: [], fills: { anchor: ['the hands'] } },
  'character-design-from-text': {
    type: 'image',
    photo: false,
    first: ['design'],
    fills: {
      design: ['a young woman bicycle courier, about 25, slim, round face, short black bob, red hooded raincoat over a grey hoodie, dark blue cargo trousers, yellow sneakers, a black delivery box on her back', STYLE],
      anchor: [INFO],
    },
  },
  'single-view-refs-scene': {
    type: 'video',
    photo: true,
    first: ['front', 'side', 'back'],
    fills: {
      anchor: [
        'a red hooded raincoat over a grey hoodie, dark blue cargo trousers, yellow sneakers, a black delivery box on her back',
        'a rainy city street at dusk',
        'she rides her bicycle up to a door and rings the bell',
        'starts wide behind her and moves in to a close-up of her face',
      ],
    },
  },
  'identity-locked-sequence': {
    type: 'video',
    photo: true,
    first: [],
    fills: {
      anchor: [
        FEATURES, 'wide shot, slow push in', FEATURES, 'cycles through the rain on a city street',
        'medium shot, tracking alongside', FEATURES, 'stops at a door and checks her phone',
        'close-up, static', FEATURES, 'smiles and rings the bell',
      ],
    },
  },
  'character-showcase-orbit': { type: 'video', photo: true, first: [], fills: { anchor: ['a rooftop with railings in front and city towers far away'] } },
  'pet-selfie-vlog': { type: 'video', photo: true, image: 'pet.jpg', first: [], fills: { anchor: ['a sunny living room', 'jumps onto the sofa and sniffs the phone'] } },
  'phone-vlog-realism': {
    type: 'video',
    photo: true,
    first: [],
    fills: { anchor: ['getting ready in the morning, then grabbing a coffee', 'tying her shoes by the door; ordering at a coffee counter; walking out with the cup'] },
  },
  'retro-found-footage': { type: 'video', photo: false, first: [], fills: { anchor: ['a backyard birthday party at dusk', 'the cake slides off the table'] } },
  'time-freeze-rewind': { type: 'video', photo: true, first: [], fills: { anchor: ['a café terrace', 'a waiter trips and a tray of drinks flies into the air'] } },
  'bullet-time-mishap': { type: 'video', photo: false, first: [], fills: { anchor: ['a cat knocks a full glass of milk off the kitchen table'] } },
  'beat-sync-outfit-change': { type: 'video', photo: true, first: [], fills: { anchor: ['street wear, red carpet, astronaut, knight'] } },
  'pov-continuous-shot': {
    type: 'video',
    photo: false,
    first: [],
    fills: { anchor: ['through a night market to a lantern-lit temple gate', 'passes steaming food stalls and squeezes past a crowd', 'the temple gate glowing with lanterns'] },
  },
  'carried-object-transition': {
    type: 'video',
    photo: true,
    image: 'object.jpg',
    first: ['scene-a', 'scene-b'],
    fills: { 'scene-a': ['a sunny beach'], 'scene-b': ['a snowy mountain hut at night'], anchor: ['a hand tosses it up'] },
    frames: { 'first-frame': 'scene-a', 'end-frame': 'scene-b' },
  },
  'fisheye-clone-pov': { type: 'image', photo: true, first: [], fills: { anchor: ['a basketball court'] } },
  'flash-photo-dump-grid': { type: 'image', photo: true, first: [], fills: { anchor: ['a house party at night'] } },
  'game-ui-livestream': {
    type: 'video',
    photo: true,
    first: [],
    fills: { anchor: ['a stylised 3D action game', 'a boss fight in a ruined castle', 'a winning move and a burst of light'] },
  },
  'travel-city-walk': {
    type: 'video',
    photo: true,
    first: [],
    fills: {
      anchor: [
        'Lisbon', 'climbing a steep tiled street', 'riding the yellow tram', 'buying a pastry at a bakery',
        'crossing a square with a fountain', 'walking along the river',
      ],
    },
  },
  'twist-comedy-skit': {
    type: 'video',
    photo: true,
    first: [],
    fills: {
      anchor: [
        'the burglar was the dog all along', 'a fridge door stands open at midnight', 'a burglar is stealing food',
        'the dog wipes its mouth and looks away',
      ],
    },
  },
  'vertical-15s-quick-tip': {
    type: 'video',
    photo: true,
    image: 'object.jpg',
    first: [],
    fills: {},
    shots: [['the mug spotless and shining inside, the coffee stain gone'], ['a spoon of baking soda into the wet mug'], ['scrubbing the stain and the rim with a damp sponge'], ['rinsing it under the tap'], []],
  },
  'underscore-bgm': {
    type: 'audio',
    photo: false,
    first: [],
    fills: { anchor: ['一段 40 秒的咖啡店产品讲解', '40 秒', 'lo-fi 爵士', '85 BPM', 'F 大调', '电钢琴、柔和的贝斯和刷子鼓', '开头轻，中段稍微推起来，结尾收住'] },
  },
  'ambience-sfx-bed': {
    type: 'audio',
    photo: false,
    first: [],
    fills: { anchor: ['老城区下雨的夜晚街道', '雨打在石板路上、远处低低的车流', '远处一扇门关上、近处有人踩水走过'] },
  },
  'voice-line': { type: 'audio', photo: false, first: [], fills: { anchor: ['欢迎来到我们的小店。今天，新烤的面包刚刚出炉。'] } },
  'two-voice-dialogue': {
    type: 'audio',
    photo: false,
    first: [],
    fills: { anchor: ['你今天怎么来得这么早？', '想赶在人多之前，买到第一炉面包。', '那你运气好，刚好出炉。'] },
  },
  'voice-from-descriptor': { type: 'audio', photo: false, first: [], fills: { anchor: ['今晚的星星特别亮，我们一起去山顶看看吧。'] } },
  'section-mapped-score': {
    type: 'audio',
    photo: false,
    first: ['body', 'reveal', 'outro'],
    fills: {
      anchor: [...SECTION_FILM, '15 秒'],
      body: [...SECTION_SHARED, '60 秒'],
      reveal: [...SECTION_SHARED, '25 秒'],
      outro: [...SECTION_SHARED, '15 秒'],
    },
  },
  'song-cover': { type: 'audio', photo: false, song: true, first: [], fills: { anchor: ['指弹吉他伴奏、轻声演唱的慢板民谣'] } },
  'voice-clone-line': { type: 'audio', photo: false, media: VOICE_SAMPLE, first: [], fills: { anchor: ['今天的风很轻，我们沿着河边慢慢走吧。'] } },
  'score-for-my-video': { type: 'audio', photo: false, media: 'mini-tools/driving.mp4', first: [], fills: { anchor: ['带轻打击乐的温暖原声民谣'] } },
  'music-mood-from-image': { type: 'audio', photo: true, image: 'pet.jpg', first: [], fills: { anchor: ['30 秒', '慢、梦幻'] } },
  'clip-ambience-foley': {
    type: 'video',
    photo: false,
    first: [],
    after: [{ key: 'foley', slot: 'sound-video' }],
    fills: {
      anchor: ['厨师在木砧板上切黄瓜', '刀起落切下第一片', '把切好的片推到一边，再切两刀', '缓慢推近', '左边的窗户'],
      foley: ['刀落在砧板上的清脆声、黄瓜片滑开的声音、远处厨房轻微的环境声'],
    },
  },
};

if (AGENT_ASK === undefined) for (const id of process.env.TEMPLATE_RUN_ONLY ? [process.env.TEMPLATE_RUN_ONLY] : Object.keys(RUNS)) for (let n = 1; n <= REPEAT; n += 1) {
  test(`${id} ${n} @needs-model`, async () => {
    test.setTimeout(3_600_000);
    const run = RUNS[id];
    if (run === undefined) throw new Error(`no run settings for ${id}`);
    // The picture is dropped first: dropped onto an empty node, it would upload into that node instead.
    const photo = run.photo ? await dropMedia(run.image === undefined ? CHARACTER : join(FIXTURES, run.image)) : undefined;
    const media = run.media === undefined ? undefined : mediaOf(run.media);
    const material = media === undefined ? undefined : await dropMedia(media.file, media.bytes);
    const song = run.song === true ? await generateSong() : undefined;
    const anchor = crypto.randomUUID();
    await seedNode(page, { projectId, spaceId }, anchor, run.type, 600, { name: `${run.type}-run`, state: 'idle' });
    // Wired in before the template is picked, so it lands in the template's slot.
    for (const wired of [photo, material, song]) if (wired !== undefined) await wire(page, { projectId, spaceId }, wired, anchor);
    await openPanel(anchor);
    await applyTemplate(id);
    for (const key of run.first) {
      const node = await keyed(key);
      await openPanel(node);
      await fillBraces(run.fills[key] ?? []);
      const prompt = await promptText();
      assertDraftSent(`canvas.template.${id}.node.${key}.prompt`, prompt);
      const kind = ((await graph()).nodes.find((one) => one.id === node)?.type ?? 'image') as Kind;
      const url = await generate(node, kind);
      expect(url).toMatch(/^https?:/);
      record({ template: id, node: key, label: LABEL, n, result: { prompt, url } });
      await save(url, `${id}-${key}-${LABEL}-${n}.${EXTENSION[kind]}`);
    }
    await openPanel(anchor);
    for (const [slot, key] of Object.entries(run.frames ?? {})) await pickIntoFrame(slot as 'first-frame' | 'end-frame', await keyed(key));
    let prompt = '';
    if (run.shots === undefined) {
      await fillBraces(run.fills.anchor ?? []);
      prompt = await promptText();
      assertDraftSent(`canvas.template.${id}.prompt`, prompt);
    } else {
      const shown: string[] = [];
      for (const [i, values] of run.shots.entries()) {
        const editorId = `generate-storyboard-shot-${String(i + 1)}-editor`;
        // Opened before it is read too: a folded shot's box is hidden, and its text then loses the line breaks.
        await openShot(i + 1);
        if (values.length > 0) await fillBraces(values, editorId);
        const text = await promptText(editorId);
        assertDraftSent(`canvas.template.${id}.shot.${String(i + 1)}`, text);
        shown.push(text);
      }
      prompt = shown.join('\n');
    }
    const url = await generate(anchor, run.type);
    expect(url).toMatch(/^https?:/);
    record({ template: id, label: LABEL, n, result: { prompt, url } });
    await save(url, `${id}-${LABEL}-${n}.${EXTENSION[run.type]}`);
    for (const { key, slot } of run.after ?? []) {
      const node = await keyed(key);
      await openPanel(node);
      await pickIntoAudioSlot(slot, anchor);
      await fillBraces(run.fills[key] ?? []);
      const shown = await promptText();
      assertDraftSent(`canvas.template.${id}.node.${key}.prompt`, shown);
      const kind = ((await graph()).nodes.find((one) => one.id === node)?.type ?? 'audio') as Kind;
      const result = await generate(node, kind);
      expect(result).toMatch(/^https?:/);
      record({ template: id, node: key, label: LABEL, n, result: { prompt: shown, url: result } });
      await save(result, `${id}-${key}-${LABEL}-${n}.${EXTENSION[kind]}`);
    }
  });
}
