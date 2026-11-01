// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Real runs of the character templates, for judging a prompt by the pictures it gets (inner#1846).
 * Each run applies the template from the panel, fills the braces, checks that the editor shows the
 * prompt the locale file holds, presses Generate and saves the picture with its prompt. It spends
 * credits, so it carries @needs-model and the default smoke run leaves it out.
 *
 * Environment: TEMPLATE_RUN_ONLY picks one template, TEMPLATE_RUN_REPEAT runs each that many times,
 * TEMPLATE_RUN_LABEL tags the files of one round, TEMPLATE_RUN_OUT is where they go (default
 * test-results/template-runs), TEMPLATE_RUN_IMAGE is the character picture (default the fixture),
 * TEMPLATE_RUN_LOCALE sets the browser locale. TEMPLATE_RUN_ASK instead sends that request to the
 * Agent with the picture attached and generates the node its proposal places.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from 'playwright/test';
import { markedSegments } from '@breatic/shared';
import { test } from '../helpers/slot';

import { openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { dropFile } from '../helpers/upload';
import { startNewConversation } from '../helpers/conversation';
import { seedNode, wire } from '../helpers/mini-tool';

const OUT = process.env.TEMPLATE_RUN_OUT ?? join(__dirname, '../../test-results/template-runs');
const CHARACTER = process.env.TEMPLATE_RUN_IMAGE ?? join(__dirname, '../fixtures/character.jpg');
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
  await expect(page.getByTestId('generate-prompt-editor')).toBeVisible({ timeout: 15_000 });
}

/** Pick a template from the open panel's character goal. */
async function applyTemplate(id: string): Promise<void> {
  await page.getByTestId('generate-template-trigger').click();
  const box = await page.getByTestId('generate-template-goal-character').boundingBox();
  if (!box) throw new Error('no character goal row');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.getByTestId(`generate-template-${id}`).click();
  await page.waitForTimeout(1500);
}

/** Replace each brace span in the open prompt, in order, the way a reader selects and types. */
async function fillBraces(values: string[]): Promise<void> {
  const editor = page.getByTestId('generate-prompt-editor');
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

/** Press Generate on the open panel and wait until the node holds a new result. */
async function generate(nodeId: string, kind: 'image' | 'video'): Promise<string> {
  const before = (await graph()).nodes.find((n) => n.id === nodeId)?.data.content ?? '';
  const button = page.getByTestId(kind === 'video' ? 'generate-video-execute' : 'generate-execute');
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.evaluate((el) => (el as HTMLButtonElement).click());
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

/** The prompt text the open panel shows. */
async function promptText(): Promise<string> {
  return (await page.getByTestId('generate-prompt-editor').innerText()).trim();
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

/** Drop the character picture onto the canvas and return its node once it holds the upload. */
async function dropCharacter(): Promise<string> {
  const before = new Set((await graph()).nodes.map((n) => n.id));
  await dropFile(page, `character-${Date.now()}.png`, 'image/png', readFileSync(CHARACTER));
  let id = '';
  await expect
    .poll(
      async () => {
        const node = (await graph()).nodes.find((n) => !before.has(n.id) && n.type === 'image');
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
  page = await browser.newPage(LOCALE ? { locale: LOCALE } : {});
  await openSmokeProject(page);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  spaceId = await createSpace(page, 'canvas', `template-run-${Date.now()}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const hide = page.getByTestId('viewport-toolbar').getByRole('button', { name: fromLocale('viewportToolbar.minimap.hide'), exact: true });
  if ((await hide.count()) > 0) await hide.click();
});

test.afterEach(async ({ browserName: _browserName }, info) => {
  await fit();
  await page.screenshot({ path: `${OUT}/${info.title.replace(/\s*@needs-model/, '').replace(/\s+/g, '-')}-${LABEL}-canvas.png` });
  await deleteSpace(page, spaceId);
  await page.close();
});

const INFO = 'Mika, bicycle courier, 25, cheerful, stubborn, curious, quick; racing the rain to deliver on time';

const AGENT_ASK = process.env.TEMPLATE_RUN_ASK;

if (AGENT_ASK !== undefined) test('agent @needs-model', async () => {
  test.setTimeout(1_800_000);
  const composer = page.getByTestId('chat-composer-box');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await startNewConversation(page);
  await expect(page.getByTestId('chat-composer-attach')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('chat-composer-file-input').setInputFiles(CHARACTER);
  await expect(page.getByTestId('chat-composer-chips')).toContainText('character', { timeout: 30_000 });
  await composer.fill(AGENT_ASK);
  const send = page.getByTestId('chat-composer-send');
  await expect(send).toBeEnabled({ timeout: 60_000 });
  await send.click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(2, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 600_000 });
  await expect(page.getByTestId('proposal-card').last()).toBeVisible({ timeout: 30_000 });
  const turn = await page.evaluate(async () => {
    const list = await (await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })).json();
    return JSON.stringify((read?.data?.messages ?? []).filter((m: { role?: string }) => m.role === 'assistant').flatMap((m: { parts?: unknown[] }) => m.parts ?? []));
  });
  record({ template: 'agent', label: LABEL, ask: AGENT_ASK, parts: JSON.parse(turn) as unknown });
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
  writeFileSync(`${OUT}/agent-${LABEL}.png`, Buffer.from(await (await page.request.get(url, { timeout: 180_000 })).body()));
});

const FEATURES = 'short black bob, red hooded raincoat, grey hoodie, yellow sneakers';

/** How each template is run: its anchor's node type, whether the character picture is wired in, the template nodes generated before the anchor, and what each one's braces are filled with, in order. */
const RUNS: Record<string, { type: 'image' | 'video'; photo: boolean; first: string[]; fills: Record<string, string[]> }> = {
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
};

if (AGENT_ASK === undefined) for (const id of process.env.TEMPLATE_RUN_ONLY ? [process.env.TEMPLATE_RUN_ONLY] : Object.keys(RUNS)) for (let n = 1; n <= REPEAT; n += 1) {
  test(`${id} ${n} @needs-model`, async () => {
    test.setTimeout(3_600_000);
    const run = RUNS[id];
    if (run === undefined) throw new Error(`no run settings for ${id}`);
    // The picture is dropped first: dropped onto an empty node, it would upload into that node instead.
    const photo = run.photo ? await dropCharacter() : undefined;
    const anchor = crypto.randomUUID();
    await seedNode(page, { projectId, spaceId }, anchor, run.type, 600, { name: `${run.type}-run`, state: 'idle' });
    if (photo !== undefined) await wire(page, { projectId, spaceId }, photo, anchor);
    await openPanel(anchor);
    await applyTemplate(id);
    for (const key of run.first) {
      const node = await keyed(key);
      await openPanel(node);
      await fillBraces(run.fills[key] ?? []);
      const prompt = await promptText();
      assertDraftSent(`canvas.template.${id}.node.${key}.prompt`, prompt);
      const url = await generate(node, 'image');
      expect(url).toMatch(/^https?:/);
      record({ template: id, node: key, label: LABEL, n, result: { prompt, url } });
      writeFileSync(`${OUT}/${id}-${key}-${LABEL}-${n}.png`, Buffer.from(await (await page.request.get(url, { timeout: 180_000 })).body()));
    }
    await openPanel(anchor);
    await fillBraces(run.fills.anchor ?? []);
    const prompt = await promptText();
    assertDraftSent(`canvas.template.${id}.prompt`, prompt);
    const url = await generate(anchor, run.type);
    expect(url).toMatch(/^https?:/);
    record({ template: id, label: LABEL, n, result: { prompt, url } });
    writeFileSync(`${OUT}/${id}-${LABEL}-${n}.${run.type === 'video' ? 'mp4' : 'png'}`, Buffer.from(await (await page.request.get(url, { timeout: 180_000 })).body()));
  });
}
