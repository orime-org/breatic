// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The template button in a generate panel's corner (inner#977, inner#1345,
 * inner#1807): the panel lists creative goals, each opening its templates;
 * picking one sets the panel up, @s the reference already wired in or places
 * an empty one beside the node, wired and @'d, places the generations a
 * template runs first, and picking it again reuses what it placed; a panel
 * with no templates says so.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject } from '../helpers/project';
import { expectNodesInView, expectPanelInView } from '../helpers/canvas-chrome';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

test.use({ viewport: { width: 1440, height: 1080 } });

let page: Page;
let projectId = '';
let spaceId = '';

/**
 * Write one empty node into the open Space's document and open its panel.
 * @param kind - The node type to write.
 * @param pan - How far to drag the canvas sideways before opening the panel.
 * @returns The node's id.
 */
async function openPanelOnNewNode(kind: 'image' | 'video' | 'audio', pan = 0): Promise<string> {
  const nodeId = crypto.randomUUID();
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, id, type, at]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id,
        type,
        position: { x: 0, y: 0 },
        data: { name: `${type}-template`, createdAt: Date.now(), createdBy: 'template-e2e', locked: false, state: 'idle', attachments: [] },
      });
    },
    [projectId, spaceId, nodeId, kind, canvasAt] as [string, string, string, string, string],
  );
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  if (pan !== 0) {
    const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
    if (!pane) throw new Error('the canvas pane is not on screen');
    const from = { x: pane.x + pane.width * 0.5, y: pane.y + 80 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + pan, from.y, { steps: 10 });
    await page.mouse.up();
  }
  await node.click({ button: 'right' });
  await page.getByTestId('node-menu-generate').click();
  return nodeId;
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage();
  await openSmokeProject(page);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  spaceId = await createSpace(page, 'canvas', `template-e2e-${Date.now()}`);
});

test.afterEach(async () => {
  await deleteSpace(page, spaceId);
  await page.close();
});

/**
 * Wire one node into another through the live canvas module.
 * @param from - The node wired in.
 * @param to - The node it goes into.
 */
async function wire(from: string, to: string): Promise<void> {
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, source, target, at]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addEdge: (p: string, s: string, e: unknown) => boolean;
      };
      canvas.addEdge(pid, sid, { id: `${source}->${target}`, source, target, createdAt: Date.now() });
    },
    [projectId, spaceId, from, to, canvasAt] as [string, string, string, string, string],
  );
}

/**
 * Move the pointer onto one goal's row the way a hand does, in steps, which
 * opens its submenu.
 * @param goal - The goal.
 */
async function pointAtGoal(goal: string): Promise<void> {
  const box = await page.getByTestId(`generate-template-goal-${goal}`).boundingBox();
  if (!box) throw new Error(`the ${goal} row is not on screen`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
}

/**
 * Open the template menu of the open panel and one goal's submenu.
 * @param goal - The goal whose templates to show.
 */
async function openGoal(goal: string): Promise<void> {
  // A menu still closing from the last pick takes the next press as its own.
  await expect(page.getByTestId(`generate-template-goal-${goal}`)).toHaveCount(0);
  const trigger = page.getByTestId('generate-template-trigger');
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  await pointAtGoal(goal);
}

/**
 * The open Space's nodes by name and its edges by node name, read from its document.
 * @returns Each node's name by id, and each edge as its two names.
 */
async function graph(): Promise<{ names: string[]; edges: string[] }> {
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, at]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string; data: { name?: string } }[]; edges: { source: string; target: string }[] };
      };
      const { nodes, edges } = canvas.readCanvasGraph(pid, sid);
      const name = (id: string): string => nodes.find((n) => n.id === id)?.data.name ?? id;
      return { names: nodes.map((n) => n.data.name ?? n.id).sort(), edges: edges.map((e) => `${name(e.source)} -> ${name(e.target)}`).sort() };
    },
    [projectId, spaceId, canvasAt] as [string, string, string],
  );
}

/**
 * Pick the storyboard template in the open image panel, after seeing the
 * character goal hold the costume sheet.
 */
async function pickStoryboard(): Promise<void> {
  await expect(page.getByTestId('generate-template-storyboard-grid-25')).toHaveCount(0);
  await openGoal('character');
  await expect(page.getByTestId('generate-template-costume-sheet')).toBeVisible();
  await pointAtGoal('comics-storyboards');
  await page.getByTestId('generate-template-storyboard-grid-25').click();
}

test('picking a template places the reference it asks for, wired and @\'d, and picking it again places nothing', async () => {
  // Short enough that the grown panel reaches the viewport toolbar, and the
  // node near enough the left that the reference lands under the left menu,
  // unless the camera brings them into view.
  await page.setViewportSize({ width: 1440, height: 900 });
  const nodeId = await openPanelOnNewNode('image', -200);
  const trigger = page.getByTestId('generate-template-trigger');
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  // Right before the close button, in the panel's corner.
  expect(await trigger.evaluate((el) => el.nextElementSibling?.getAttribute('data-testid'))).toBe('generate-exit');
  await pickStoryboard();

  await expect(page.getByTestId('generate-mode-trigger')).toHaveText('Image to Image');
  await expect(page.getByTestId('generate-model-trigger')).toContainText('Nano Banana Pro');
  const nodes = visibleSpace(page).locator('.react-flow__node');
  await expect(nodes).toHaveCount(2, { timeout: 15_000 });
  const reference = visibleSpace(page).locator('.react-flow__node').filter({ hasText: 'Character or scene' });
  await expect(reference).toHaveCount(1);
  await expect(visibleSpace(page).locator('.react-flow__edge')).toHaveCount(1);
  // The new node stands left of the panel's node.
  const anchorBox = await visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
  const referenceBox = await reference.boundingBox();
  expect((referenceBox?.x ?? 0) + (referenceBox?.width ?? 0)).toBeLessThanOrEqual(anchorBox?.x ?? 0);
  const prompt = page.getByTestId('generate-prompt-editor');
  await expect(prompt.locator('[data-reference-mention]')).toHaveCount(1);
  await expect(prompt.locator('[data-prompt-note]')).toHaveCount(1);
  await expect(prompt).toContainText('{✏️ the story}');
  await expect(page.getByText('Replace the text in braces.', { exact: false })).toBeVisible();
  // The camera brings the placed reference and the panel, grown around the
  // prompt, clear of the menu, toolbar and minimap floating over the canvas.
  const menu = await page.getByTestId('left-floating-menu').boundingBox();
  await expect.poll(async () => (await reference.boundingBox())?.x ?? 0, { timeout: 5_000 }).toBeGreaterThanOrEqual((menu?.x ?? 0) + (menu?.width ?? 0));
  await expectPanelInView(page);
  await expectNodesInView(page, 2);
  await page.screenshot({ path: test.info().outputPath('image-template-applied.png') });

  await pickStoryboard();
  await expect(nodes).toHaveCount(2);
  await expect(visibleSpace(page).locator('.react-flow__edge')).toHaveCount(1);
  await expect(prompt.locator('[data-reference-mention]')).toHaveCount(1);
});

test('picking a template @s the reference already wired in and places nothing new', async () => {
  const nodeId = await openPanelOnNewNode('image');
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  const heroId = crypto.randomUUID();
  await page.evaluate(
    async ([pid, sid, id, at]: [string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id,
        type: 'image',
        position: { x: -600, y: 0 },
        data: { name: 'Hero photo', createdAt: Date.now(), createdBy: 'template-e2e', locked: false, state: 'idle', attachments: [] },
      });
    },
    [projectId, spaceId, heroId, canvasAt] as [string, string, string, string],
  );
  await wire(heroId, nodeId);
  await pickStoryboard();

  const prompt = page.getByTestId('generate-prompt-editor');
  await expect(prompt.locator('[data-reference-mention]')).toHaveCount(1, { timeout: 15_000 });
  await expect(prompt.locator('[data-reference-mention]')).toContainText('Hero photo');
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(2);
  // The photo wired in still holds nothing, so the note says to put it there.
  await expect(prompt.locator('[data-prompt-note]')).toHaveCount(1);
});

test('picking the single-view scene places the three views it generates first, all fed by the character and wired into the scene', async () => {
  const nodeId = await openPanelOnNewNode('video');
  await openGoal('character');
  await page.getByTestId('generate-template-single-view-refs-scene').click();

  await expect(page.getByTestId('generate-model-trigger')).toContainText('Seedance 2.5', { timeout: 15_000 });
  // The anchor, the empty character and the front, side and back views.
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(5, { timeout: 15_000 });
  await expect(visibleSpace(page).locator('.react-flow__edge')).toHaveCount(7);
  // Three views into the scene, and the character into the three views and the scene.
  expect(await graph()).toEqual({
    names: ['Back', 'Character', 'Front', 'Side', 'video-template'],
    edges: [
      'Back -> video-template',
      'Character -> Back',
      'Character -> Front',
      'Character -> Side',
      'Character -> video-template',
      'Front -> video-template',
      'Side -> video-template',
    ],
  });
  const prompt = page.getByTestId('generate-prompt-editor');
  await expect(prompt.locator('[data-reference-mention]')).toHaveCount(4);
  // What to put in the character, and to generate each view first.
  await expect(prompt.locator('[data-prompt-note]')).toHaveCount(4);
  await expectNodesInView(page, 5);
  await page.screenshot({ path: test.info().outputPath('single-view-scene-applied.png') });
  expect(await visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`).count()).toBe(1);
});

test('picking the single-view scene feeds a photo already wired into the video node into the three views', async () => {
  const nodeId = await openPanelOnNewNode('video');
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  const heroId = crypto.randomUUID();
  await page.evaluate(
    async ([pid, sid, id, at]: [string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id,
        type: 'image',
        position: { x: -600, y: 0 },
        data: { name: 'Hero photo', createdAt: Date.now(), createdBy: 'template-e2e', locked: false, state: 'idle', attachments: [] },
      });
    },
    [projectId, spaceId, heroId, canvasAt] as [string, string, string, string],
  );
  await wire(heroId, nodeId);
  await openGoal('character');
  await page.getByTestId('generate-template-single-view-refs-scene').click();

  // The anchor, the photo and the three views; no empty character.
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(5, { timeout: 15_000 });
  await expect(visibleSpace(page).locator('.react-flow__edge')).toHaveCount(7);
  expect((await graph()).edges).toEqual([
    'Back -> video-template',
    'Front -> video-template',
    'Hero photo -> Back',
    'Hero photo -> Front',
    'Hero photo -> Side',
    'Hero photo -> video-template',
    'Side -> video-template',
  ]);
  const prompt = page.getByTestId('generate-prompt-editor');
  await expect(prompt.locator('[data-reference-mention]')).toHaveCount(4);
  await expect(prompt.locator('[data-reference-mention]').filter({ hasText: 'Hero photo' })).toHaveCount(1);
});

test('a panel with no templates says so', async () => {
  await openPanelOnNewNode('audio');
  await page.getByTestId('generate-template-trigger').click();
  await expect(page.getByTestId('generate-template-empty')).toHaveText('No templates');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('generate-template-empty')).toBeHidden();
});

test('a note at the top of a prompt shows in orange, and generation does not get it', async () => {
  const nodeId = await openPanelOnNewNode('image');
  await expect(page.getByTestId('generate-prompt-editor')).toBeVisible({ timeout: 15_000 });
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  // Stateless, so a fresh copy served from source writes the same blocks; its
  // yjs resolves to the dependency the page already loaded.
  const promptAt = '/spaces/canvas/generate/proposal-prompt.ts';
  await page.evaluate(
    async ([pid, sid, id, at, writer]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string; data: { mode?: string } }[] };
        getPromptFragment: (p: string, s: string, n: string, m: string) => unknown;
      };
      const { writeProposalPrompt } = (await import(/* @vite-ignore */ writer)) as {
        writeProposalPrompt: (f: unknown, segments: unknown[]) => void;
      };
      const mode = canvas.readCanvasGraph(pid, sid).nodes.find((n) => n.id === id)?.data.mode ?? 't2i';
      writeProposalPrompt(canvas.getPromptFragment(pid, sid, id, mode), [
        { slot: { kind: 'note', label: 'Pick a picture in the panel' } },
        { text: 'a red boat on a still pond' },
      ]);
    },
    [projectId, spaceId, nodeId, canvasAt, promptAt] as [string, string, string, string, string],
  );

  const note = page.getByTestId('generate-prompt-editor').locator('[data-prompt-note]');
  // It names itself before its words, in body text on the warning ground.
  await expect(note.locator('[data-prompt-note-prefix]')).not.toBeEmpty();
  await expect(note).toHaveText(/Pick a picture in the panel$/);
  const [color, ground, want] = await note.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-foreground)';
    probe.style.backgroundColor = 'var(--color-status-warning-bg)';
    document.body.append(probe);
    const expected = [getComputedStyle(probe).color, getComputedStyle(probe).backgroundColor];
    probe.remove();
    return [getComputedStyle(el).color, getComputedStyle(el).backgroundColor, expected];
  });
  expect([color, ground]).toEqual(want);

  let sent: { params?: { prompt?: string } } | null = null;
  await page.route('**/canvas/tasks', async (route) => {
    sent = route.request().postDataJSON() as { params?: { prompt?: string } };
    // A final answer: an aborted request has no answer, and the press would
    // keep sending it (inner#1490).
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: crypto.randomUUID(), status: 'queued' } }),
    });
  });
  await page.getByTestId('generate-execute').click();
  await expect.poll(() => sent, { timeout: 15_000 }).not.toBeNull();
  const prompt = (sent as { params?: { prompt?: string } } | null)?.params?.prompt ?? '';
  expect(prompt).toContain('a red boat on a still pond');
  expect(prompt).not.toContain('Pick a picture');
  await page.screenshot({ path: test.info().outputPath('prompt-note.png') });
});
