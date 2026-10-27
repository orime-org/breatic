// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press in the chat, a wired group on the canvas (#229).
 *
 * Unit tests settle each half: what the tool refuses, where the nodes land,
 * what goes in the prompt, what the card draws. What they cannot settle is
 * that the halves are joined -- that a real turn reaches the tool, that the
 * answer survives the trip into a stored message, that the card built from
 * that message posts into a mailbox a canvas is actually holding, and that
 * what comes out the far end is a group the reader can generate from.
 *
 * The turn is real, so the model decides whether to propose. A run where it
 * answers in prose instead is reported as such rather than passed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { startNewConversation } from '../helpers/conversation';

import { openSmokeProject } from '../helpers/project';
import { expectPanelInView } from '../helpers/canvas-chrome';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { projectIdOf } from '../helpers/tab-restore';

let page: Page;
let spaceId = '';

/**
 * Which tools the newest stored conversation used.
 *
 * Read off the stored parts rather than the running line: the line naming a
 * tool is gone by the time the reply lands, and what a finished turn can
 * still be read from is what was stored.
 * @param p - The signed-in page.
 * @returns Each tool name, in the order the turn used them.
 */
async function toolsUsed(p: Page): Promise<string[]> {
  return p.evaluate(async () => {
    const list = await (
      await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })
    ).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (
      await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })
    ).json();
    const messages = (read?.data?.messages ?? []) as { parts?: { type?: string }[] }[];
    return messages
      .flatMap((m) => m.parts ?? [])
      .map((part) => part.type ?? '')
      .filter((type) => type.startsWith('tool-'))
      .map((type) => type.slice('tool-'.length));
  });
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({
    viewport: { width: 1500, height: 900 },
  });
  await openSmokeProject(page);
  spaceId = await createSpace(page, 'canvas', `propose-${String(Date.now())}`);
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page.close();
});

test('proposes a pair of nodes, and one press puts them on the canvas wired @needs-model', async () => {
  // A real turn: the wait is on a model, and on the catalog calls before it.
  test.setTimeout(240_000);
  const composer = page.getByTestId('chat-composer-box');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  // Pan away from where the space opened. A reader asking for this has been
  // working somewhere, and what lands has to be in front of THEM -- framing
  // the group against a canvas that has not been moved proves nothing.
  const pane = visibleSpace(page).locator('.react-flow__pane');
  const paneBox = await pane.boundingBox();
  await page.mouse.move(
    (paneBox?.x ?? 0) + (paneBox?.width ?? 0) / 2,
    (paneBox?.y ?? 0) + (paneBox?.height ?? 0) / 2,
  );
  await page.mouse.wheel(900, 700);

  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  // Asked the way the reader this feature exists for would ask: what they
  // want, in their own words, with no canvas vocabulary in it.
  await composer.fill(
    'I have a product photo and I want it on a plain white background. Set it up for me on the canvas -- do not ask me anything, just propose it.',
  );
  await composer.press('Enter');

  const bubbles = page.getByTestId('message-bubble');
  await expect(bubbles).toHaveCount(2, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, {
    timeout: 200_000,
  });

  const used = await toolsUsed(page);
  expect(used, `the turn proposed a group. Tools used: ${used.join(', ')}`).toContain(
    'propose_canvas_action',
  );

  // The card is built from the stored call, so its presence is the whole trip
  // -- tool answer, stored message, panel read -- having worked.
  const card = page.getByTestId('proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const chips = card.getByTestId('proposal-chip');
  expect(
    await chips.count(),
    'an image-to-image proposal is a pair: the empty node and the one that generates',
  ).toBe(2);

  // Where the prompt the agent wrote is found: a reader new to the canvas does
  // not know a right-click opens the panel (#289). Matched in any of the five
  // languages, because the account's language is not this file's to choose.
  const promptReady = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'].map(
    (locale) =>
      (
        JSON.parse(
          readFileSync(join(__dirname, '../../../../locales', `${locale}.json`), 'utf8'),
        ) as { chat: { proposal: { promptReady: string } } }
      ).chat.proposal.promptReady,
  );
  const cardText = (await card.textContent()) ?? '';
  expect(
    promptReady.some((line) => cardText.includes(line)),
    `the card says where the prompt is found. Read: "${cardText}"`,
  ).toBe(true);
  // Credits and run time belong to the generation panel, not the card.
  expect(
    await card.locator('svg.lucide-star, svg.lucide-clock').count(),
    `the card shows no credits and no run time. Read: "${cardText}"`,
  ).toBe(0);

  const before = await visibleSpace(page).locator('.react-flow__node').count();
  // The button fills the card at the narrowest column and stops at 270px
  // once the column is wider, centred in the card (inner#1372). Measured at
  // the widest column, where the card is wider than the cap.
  const column = page.getByTestId('agent-column');
  const columnBox = await column.boundingBox();
  const edgeX = (columnBox?.x ?? 0) + (columnBox?.width ?? 0);
  const midY = (columnBox?.y ?? 0) + (columnBox?.height ?? 0) / 2;
  await page.mouse.move(edgeX, midY);
  await page.mouse.down();
  await page.mouse.move(edgeX + 400, midY, { steps: 8 });
  await page.mouse.up();
  const geometry = await card.evaluate((el) => {
    const button = el.querySelector('[data-testid="proposal-use"]') as HTMLElement;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const inner = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    const b = button.getBoundingClientRect();
    return { inner, width: b.width, offset: b.left + b.width / 2 - (box.left + box.width / 2) };
  });
  expect(geometry.inner, 'the widened column gives the card more room than the cap').toBeGreaterThan(270);
  expect(geometry.width).toBeCloseTo(270, 0);
  expect(Math.abs(geometry.offset)).toBeLessThanOrEqual(1);
  const widened = await column.boundingBox();
  const widenedEdgeX = (widened?.x ?? 0) + (widened?.width ?? 0);
  await page.mouse.move(widenedEdgeX, midY);
  await page.mouse.down();
  await page.mouse.move(edgeX - 400, midY, { steps: 8 });
  await page.mouse.up();
  // Back at the narrowest column the cap is the card's own width, so the
  // button fills it.
  const narrow = await card.evaluate((el) => {
    const button = el.querySelector('[data-testid="proposal-use"]') as HTMLElement;
    const style = getComputedStyle(el);
    const inner = el.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    return { inner, width: button.getBoundingClientRect().width };
  });
  expect(await column.boundingBox().then((b) => b?.width)).toBeCloseTo(320, 0);
  expect(narrow.inner).toBeCloseTo(270, 0);
  expect(narrow.width).toBeCloseTo(270, 0);
  await card.getByTestId('proposal-use').click();

  // Two nodes, the group the canvas puts two or more of them into, and the
  // wire between them. Counted rather than matched by id: the ids are minted
  // by the canvas as it places them.
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(before + 3, {
    timeout: 20_000,
  });
  await expect(visibleSpace(page).locator('.react-flow__node-group')).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(visibleSpace(page).locator('.react-flow__edge')).toHaveCount(1, { timeout: 20_000 });

  // Every node of the group is on screen. The empty ones are what the reader
  // is being asked to fill, so a group placed where they have to go looking
  // for it is not the one press this feature promises.
  const view = await pane.boundingBox();
  const nodes = await visibleSpace(page).locator('.react-flow__node').all();
  const offScreen: string[] = [];
  for (const node of nodes) {
    const box = await node.boundingBox();
    const inside =
      box !== null &&
      view !== null &&
      box.x >= view.x &&
      box.y >= view.y &&
      box.x + box.width <= view.x + view.width &&
      box.y + box.height <= view.y + view.height;
    if (!inside) offScreen.push(JSON.stringify(box));
  }
  expect(
    offScreen,
    `every placed node is inside the canvas. Canvas: ${JSON.stringify(view)}`,
  ).toEqual([]);

  // What the reader is left looking at: the node that generates, selected,
  // with its panel open and the prompt already in the box, the empty node
  // @'d there and a note saying to put their picture in it first
  // (inner#1315).
  const selected = visibleSpace(page).locator('.react-flow__node.selected');
  await expect(selected).toHaveCount(1, { timeout: 20_000 });
  const prompt = page.getByTestId('generate-prompt-editor');
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  const written = await prompt.innerText();
  expect(written.length, `the prompt box is empty. Read: "${written}"`).toBeGreaterThan(0);
  await expect(prompt.locator('[data-reference-mention]')).toHaveCount(1);
  await expect(prompt.locator('[data-prompt-note]')).not.toHaveCount(0);

  // A6: one press put the whole group down, so one undo takes all of it back.
  // The click moves focus off the prompt editor first -- it keeps a history of
  // its own and would otherwise answer the keystroke itself, leaving the group
  // on the canvas and this reading of it meaningless.
  await pane.click({ position: { x: 24, y: 24 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(before, {
    timeout: 20_000,
  });
  await expect(visibleSpace(page).locator('.react-flow__edge')).toHaveCount(0, {
    timeout: 20_000,
  });
});

test('proposes a multi-shot video, and the panel opens on its shots @needs-model', async () => {
  // A proposal carrying shots lands in the multi-shot mode, each shot holding
  // the words the agent wrote.
  test.setTimeout(240_000);
  const composer = page.getByTestId('chat-composer-box');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  await composer.fill(
    'Set up a 5-second multi-shot video on Kling 3.0 4K with two shots: first a paper boat on a still pond, then the boat drifting into fog. Do not ask me anything, just propose it.',
  );
  await composer.press('Enter');

  await expect(page.getByTestId('message-bubble')).toHaveCount(2, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 200_000 });
  const used = await toolsUsed(page);
  expect(used, `the turn proposed a group. Tools used: ${used.join(', ')}`).toContain(
    'propose_canvas_action',
  );

  const card = page.getByTestId('proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId('proposal-use').click();

  // The node that generates is selected with its panel open.
  await expect(page.getByTestId('generate-storyboard-shots')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('generate-video-mode-trigger')).toContainText('Multi-Shot');
  for (const shot of [1, 2]) {
    const words = await page.getByTestId(`generate-storyboard-shot-${String(shot)}-editor`).innerText();
    expect(words.trim().length, `shot ${String(shot)} is empty`).toBeGreaterThan(0);
  }
});

/**
 * The templates the newest stored conversation's proposals named (inner#977).
 * @param p - The signed-in page.
 * @returns Each template id a proposed node carried.
 */
async function templatesProposed(p: Page): Promise<string[]> {
  return p.evaluate(async () => {
    const list = await (
      await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })
    ).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (
      await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })
    ).json();
    const messages = (read?.data?.messages ?? []) as {
      parts?: { type?: string; input?: { nodes?: { template?: { id?: string } }[] } }[];
    }[];
    return messages
      .flatMap((m) => m.parts ?? [])
      .filter((part) => part.type === 'tool-propose_canvas_action')
      .flatMap((part) => part.input?.nodes ?? [])
      .flatMap((node) => (node.template?.id ? [node.template.id] : []));
  });
}

/**
 * Whether a placed proposal in the newest stored conversation left a ✏️ mark
 * for the reader to fill.
 * @param p - The signed-in page.
 * @returns True when one did.
 */
async function tweaksProposed(p: Page): Promise<boolean> {
  return p.evaluate(async () => {
    const list = await (
      await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })
    ).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (
      await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })
    ).json();
    const messages = (read?.data?.messages ?? []) as {
      parts?: {
        type?: string;
        output?: { placed?: boolean };
        input?: { nodes?: { prompt?: { slot?: { kind?: string } }[] }[] };
      }[];
    }[];
    return messages
      .flatMap((m) => m.parts ?? [])
      .filter((part) => part.type === 'tool-propose_canvas_action' && part.output?.placed === true)
      .flatMap((part) => part.input?.nodes ?? [])
      .some((node) => (node.prompt ?? []).some((segment) => segment.slot?.kind === 'tweak'));
  });
}

test('starts a storyboard from its template, and reminds the reader of what is theirs to fill @needs-model', async () => {
  test.setTimeout(240_000);
  const composer = page.getByTestId('chat-composer-box');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  await composer.fill(
    'I have a photo of my character. Make me one 25-panel storyboard image of her walking through a night market, to turn into a video later. Do not ask me anything, just propose it.',
  );
  await composer.press('Enter');

  await expect(page.getByTestId('message-bubble')).toHaveCount(2, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 200_000 });
  const named = await templatesProposed(page);
  expect(named, `the proposal started from the storyboard template. Named: ${named.join(', ')}`).toContain(
    'storyboard-grid-25',
  );

  const card = page.getByTestId('proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const toFill = await tweaksProposed(page);
  await card.getByTestId('proposal-use').click();
  // A proposal lands no square brackets, so the reminder speaks of braces
  // alone, and only when one is left to fill (inner#1315).
  const reminder = page.getByText('Replace the text in braces.', { exact: false });
  if (toFill) await expect(reminder).toBeVisible({ timeout: 20_000 });

  const prompt = page.getByTestId('generate-prompt-editor');
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  // The prompt is the agent's own, rewritten from the template's, and the
  // photo's empty node is @'d where it speaks of it (inner#1315).
  await expect(prompt.locator('[data-reference-mention]')).toHaveCount(1);
  await expect(prompt).not.toContainText('[📎');
  await expect(page.getByTestId('generate-model-trigger')).toContainText('Nano Banana Pro');
  await expect(page.getByText('square brackets', { exact: false })).toHaveCount(0);
  // Checked once the panel is ready, so a toast that came late still counts.
  if (!toFill) await expect(reminder).toHaveCount(0);
});

test('chains a generated character into a template storyboard, a ref @-ing it @needs-model', async () => {
  test.setTimeout(240_000);
  const composer = page.getByTestId('chat-composer-box');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  await composer.fill(
    'I have no picture of my character yet. Generate her first (a young courier in a red coat), then make one 25-panel storyboard image of her crossing a rainy city, drawn from that generated picture. Do not ask me anything, just propose both, wired together.',
  );
  await composer.press('Enter');

  await expect(page.getByTestId('message-bubble')).toHaveCount(2, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 200_000 });
  const refs = await page.evaluate(async () => {
    const list = await (await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })).json();
    const messages = (read?.data?.messages ?? []) as {
      parts?: {
        type?: string;
        output?: { placed?: boolean };
        input?: { nodes?: { template?: string; prompt?: { ref?: number }[] }[] };
      }[];
    }[];
    const placed = messages
      .flatMap((m) => m.parts ?? [])
      .filter((part) => part.type === 'tool-propose_canvas_action' && part.output?.placed === true);
    const grid = placed.flatMap((part) => part.input?.nodes ?? []).find((n) => n.template === 'storyboard-grid-25');
    return grid?.prompt?.flatMap((s) => (s.ref === undefined ? [] : [s.ref])) ?? null;
  });
  expect(refs, 'a placed proposal carried the storyboard template').not.toBeNull();
  expect(refs).toHaveLength(1);
});

test('writes the proposal prompt in the language the reader asked in @needs-model', async () => {
  test.setTimeout(240_000);
  const composer = page.getByTestId('chat-composer-box');
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await startNewConversation(page);
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });

  await composer.fill('帮我在画布上生成一张图：一只在雨夜城市里奔跑的橘猫，电影感。不要问我任何问题，直接提议。');
  await composer.press('Enter');

  await expect(page.getByTestId('message-bubble')).toHaveCount(2, { timeout: 200_000 });
  await expect(page.getByTestId('chat-composer-abort')).toHaveCount(0, { timeout: 200_000 });
  const words = await page.evaluate(async () => {
    const list = await (await fetch('/api/v1/chat/conversations?limit=1', { credentials: 'include' })).json();
    const id = list?.data?.conversations?.[0]?.id as string;
    const read = await (await fetch(`/api/v1/chat/conversations/${id}`, { credentials: 'include' })).json();
    const messages = (read?.data?.messages ?? []) as {
      parts?: { type?: string; input?: { nodes?: { prompt?: { text?: string }[] }[] } }[];
    }[];
    return messages
      .flatMap((m) => m.parts ?? [])
      .filter((part) => part.type === 'tool-propose_canvas_action')
      .flatMap((part) => part.input?.nodes ?? [])
      .flatMap((node) => node.prompt ?? [])
      .map((segment) => segment.text ?? '')
      .join('');
  });
  expect(words, 'a proposal was made').not.toBe('');
  expect(words, `the prompt is in Chinese. Read: "${words}"`).toMatch(/[\u4e00-\u9fff]/);
});

/** The steps of the guide the replayed template proposal carries. */
const GUIDE_WORDS = 'Template smoke\n1. Split the result into a grid\n2. Pick the panel you like';

/**
 * A template proposal as the tool answers it once the check has passed
 * (inner#1345): the anchor, an empty reference wired into its pool and @'d,
 * and the guide text node pointing at the anchor.
 */
const TEMPLATE_ANSWER = {
  placed: true,
  nodes: [
    {
      role: 'generate',
      type: 'image',
      name: 'Storyboard',
      mode: 'i2i',
      model: 'nano-banana-pro-edit-ultra',
      params: { aspect_ratio: '1:1', resolution: '4k' },
      takesPrompt: true,
      prompt: [
        { slot: { kind: 'note', label: 'Put the character in Character first' } },
        { text: 'Use ' },
        { ref: 1 },
        { text: ' for a 5x5 storyboard.' },
      ],
    },
    { role: 'source', type: 'image', name: 'Character' },
    {
      role: 'written',
      type: 'text',
      name: 'Template smoke',
      prompt: [{ text: GUIDE_WORDS }],
      templateNode: { template: 'storyboard-grid-25', key: 'guide', anchor: 0 },
    },
  ],
  edges: [{ fromIndex: 1, toIndex: 0, into: 'pool' }],
  rationale: '',
  groupName: 'Template smoke',
};

test('places a template proposal with its guide text node pointing at the anchor', async () => {
  const chunks = [
    { type: 'data-heartbeat', transient: true, data: {} },
    { type: 'data-conversation-titled', data: { title: 'template smoke' } },
    { type: 'start', messageId: 'm-reply' },
    { type: 'start-step' },
    { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'propose_canvas_action', input: { action: 'add_nodes' } },
    { type: 'tool-output-available', toolCallId: 'call-1', output: TEMPLATE_ANSWER },
    { type: 'finish-step' },
    { type: 'finish' },
  ];
  await page.route('**/chat/message', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''),
    }),
  );
  await startNewConversation(page);
  const composer = page.getByTestId('chat-composer-box');
  await composer.fill('Make a storyboard of my character.');
  await composer.press('Enter');

  const card = page.getByTestId('proposal-card').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  // The guide is drawn on the card as words already written.
  await expect(card.getByTestId('proposal-words')).toContainText('Split the result into a grid');
  await card.getByTestId('proposal-use').click();

  const guide = visibleSpace(page).locator('.react-flow__node').filter({ hasText: 'Pick the panel you like' });
  await expect(guide).toHaveCount(1, { timeout: 20_000 });
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  const tags = await page.evaluate(
    async ([pid, sid, at]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string; type: string; data: { name?: string; templateNode?: { anchor?: string } } }[] };
      };
      const nodes = canvas.readCanvasGraph(pid, sid).nodes;
      const anchor = nodes.find((n) => n.data.name === 'Storyboard')?.id;
      const guideNode = nodes.find((n) => n.type === 'text');
      return { anchor, guideAnchor: guideNode?.data.templateNode?.anchor };
    },
    [projectIdOf(page.url()), spaceId, canvasAt] as [string, string, string],
  );
  expect(typeof tags.anchor).toBe('string');
  expect(tags.guideAnchor).toBe(tags.anchor);
  // The panel opened on the anchor is brought clear of what floats over the canvas.
  await expectPanelInView(page);
  await page.screenshot({ path: test.info().outputPath('template-proposal-placed.png') });
});
