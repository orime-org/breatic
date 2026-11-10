// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The template button in a generate panel's corner (inner#977, inner#1345,
 * inner#1807): the panel lists creative goals, each opening its templates;
 * picking one sets the panel up, @s the reference already wired in or places
 * an empty one beside the node, wired and @'d, places the generations a
 * template runs first, and picking it again reuses what it placed; a template
 * with a shot list writes its shots, and one whose pictures go into the first
 * and end frame notes which frame each goes into (inner#1816). The sound
 * templates (inner#1825) wire an input into a slot instead of the prompt, or
 * fill that slot with the material already wired in, place a node past the
 * anchor or nodes beside it wired to nothing, and set a model's own params.
 *
 * Every node type now has templates, so the empty state is pinned by the unit
 * case in `TemplateMenu.test.tsx` alone.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject } from '../helpers/project';
import { expectNodesInView, expectPanelInView } from '../helpers/canvas-chrome';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { wire } from '../helpers/mini-tool';

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
 * The group a template's new nodes formed beside an anchor, read from the open Space's document.
 * @param anchorId - The anchor.
 * @returns The distance from the group's right edge to the anchor's left edge, the anchor card's width, and how many members the group holds.
 */
async function groupBesideAnchor(anchorId: string): Promise<{ gap: number; card: number; members: number }> {
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, anchor, at]: [string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        readNodePlacements: (p: string, s: string) => { id: string; type: string; x: number; width?: number }[];
        readCanvasGraph: (p: string, s: string) => { nodes: { parentId?: string }[] };
      };
      const placements = canvas.readNodePlacements(pid, sid);
      const group = placements.find((p) => p.type === 'group');
      const anchorAt = placements.find((p) => p.id === anchor);
      // offsetWidth ignores the viewport's scale, so it is the card's width on the canvas.
      const card = (document.querySelector(`.react-flow__node[data-id="${anchor}"]`) as HTMLElement | null)?.offsetWidth;
      if (!group || !anchorAt || !card) throw new Error('no group, anchor or anchor card');
      return {
        gap: anchorAt.x - (group.x + (group.width ?? 0)),
        card,
        members: canvas.readCanvasGraph(pid, sid).nodes.filter((n) => n.parentId === group.id).length,
      };
    },
    [projectId, spaceId, anchorId, canvasAt] as [string, string, string, string],
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
  await wire(page, { projectId, spaceId }, heroId, nodeId);
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
  // The anchor, the empty character, the front, side and back views, and the group the four new nodes form.
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(6, { timeout: 15_000 });
  await expect(visibleSpace(page).locator('.react-flow__edge')).toHaveCount(7);
  // Three views into the scene, and the character into the three views and the scene.
  expect(await graph()).toEqual({
    names: ['Back', 'Character', 'Character in a video scene', 'Front', 'Side', 'video-template'],
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
  // The group holds the four new nodes and stands right beside the anchor, left of it.
  const { gap, card, members } = await groupBesideAnchor(nodeId);
  expect(members).toBe(4);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(card);
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
  await wire(page, { projectId, spaceId }, heroId, nodeId);
  await openGoal('character');
  await page.getByTestId('generate-template-single-view-refs-scene').click();

  // The anchor, the photo, the three views and the group the three new views form; no empty character.
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(6, { timeout: 15_000 });
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

test('picking the quick tip writes its five shots of three seconds, each @ing the subject it places', async () => {
  await openPanelOnNewNode('video');
  await openGoal('social-hooks');
  await page.getByTestId('generate-template-vertical-15s-quick-tip').click();

  await expect(page.getByTestId('generate-model-trigger')).toContainText('Seedance 2.5', { timeout: 15_000 });
  // The anchor and the empty subject; one new node forms no group.
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(2, { timeout: 15_000 });
  expect(await graph()).toEqual({ names: ['Subject', 'video-template'], edges: ['Subject -> video-template'] });
  await expect(page.getByTestId('generate-storyboard-shots')).toBeVisible();
  for (const n of [1, 2, 3, 4, 5]) {
    await expect(page.getByTestId(`generate-storyboard-shot-${String(n)}-seconds`)).toContainText('3');
    const editor = page.getByTestId(`generate-storyboard-shot-${String(n)}-editor`);
    await expect(editor.locator('[data-reference-mention]').filter({ hasText: 'Subject' })).toHaveCount(1);
    // What to put in the subject sits on top of the first shot only.
    await expect(editor.locator('[data-prompt-note]')).toHaveCount(n === 1 ? 1 : 0);
  }
  await expect(page.getByTestId('generate-storyboard-shot-6')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('quick-tip-applied.png') });
});

test('picking the carried-object transition places two scene pictures for the first and end frame, noted and left to pick', async () => {
  await openPanelOnNewNode('video');
  await openGoal('social-hooks');
  await page.getByTestId('generate-template-carried-object-transition').click();

  await expect(page.getByTestId('generate-model-trigger')).toContainText('Seedance 2.5', { timeout: 15_000 });
  // The anchor, the empty object, the two scenes and the group the three new nodes form.
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(5, { timeout: 15_000 });
  expect(await graph()).toEqual({
    names: ['Object', 'Object-carried transition', 'Scene A', 'Scene B', 'video-template'],
    edges: ['Object -> Scene A', 'Object -> Scene B', 'Scene A -> video-template', 'Scene B -> video-template'],
  });
  const prompt = page.getByTestId('generate-prompt-editor');
  // The scenes go into frames, not the pool: nothing is @'d, and each note names its frame.
  await expect(prompt.locator('[data-reference-mention]')).toHaveCount(0);
  const notes = prompt.locator('[data-prompt-note]');
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(0)).toContainText('First frame');
  await expect(notes.nth(1)).toContainText('End frame');
  // The frames stay empty until the user picks the generated scenes in.
  await expect(page.getByTestId('generate-video-tool-first-frame')).toBeVisible();
  await expect(page.getByTestId('generate-video-tool-end-frame')).toBeVisible();
  await expect(page.getByTestId('generate-video-first-frame-thumbnail')).toHaveCount(0);
  await expect(page.getByTestId('generate-video-end-frame-thumbnail')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('carried-object-applied.png') });
});

test('picking the carried-object transition feeds a picture already wired into the video node into both scenes', async () => {
  const nodeId = await openPanelOnNewNode('video');
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  const photoId = crypto.randomUUID();
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
    [projectId, spaceId, photoId, canvasAt] as [string, string, string, string],
  );
  await wire(page, { projectId, spaceId }, photoId, nodeId);
  await openGoal('social-hooks');
  await page.getByTestId('generate-template-carried-object-transition').click();

  await expect(page.getByTestId('generate-model-trigger')).toContainText('Seedance 2.5', { timeout: 15_000 });
  // The anchor, the photo, the two scenes and the group the two new scenes form; no empty object.
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(5, { timeout: 15_000 });
  expect(await graph()).toEqual({
    names: ['Hero photo', 'Object-carried transition', 'Scene A', 'Scene B', 'video-template'],
    edges: [
      'Hero photo -> Scene A',
      'Hero photo -> Scene B',
      'Hero photo -> video-template',
      'Scene A -> video-template',
      'Scene B -> video-template',
    ],
  });
});

/**
 * The ids of the templates the open goal submenu lists, in order.
 * @returns The template ids.
 */
async function listedTemplates(): Promise<string[]> {
  const items = page.locator('[role="menuitem"][data-testid^="generate-template-"]:not([data-testid^="generate-template-goal-"])');
  await expect(items.first()).toBeVisible();
  return items.evaluateAll((all) => all.map((el) => (el.getAttribute('data-testid') ?? '').replace('generate-template-', '')));
}

/**
 * Seed a node holding a file into the open Space and wire it into another.
 * @param type - Its node type.
 * @param name - Its name.
 * @param content - The file it holds.
 * @param into - The node it is wired into.
 * @returns Its id.
 */
async function seedWiredMaterial(type: 'image' | 'video', name: string, content: string, into: string): Promise<string> {
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  const id = crypto.randomUUID();
  await page.evaluate(
    async ([pid, sid, nodeId, kind, label, url, at]: [string, string, string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id: nodeId,
        type: kind,
        position: { x: -600, y: 0 },
        data: { name: label, createdAt: Date.now(), createdBy: 'template-e2e', locked: false, state: 'idle', attachments: [], content: url, status: 'ready', duration: 8 },
      });
    },
    [projectId, spaceId, id, type, name, content, canvasAt] as [string, string, string, string, string, string, string],
  );
  await wire(page, { projectId, spaceId }, id, into);
  return id;
}

/**
 * The open Space's node names by node type, each list sorted.
 * @returns The names under each type.
 */
async function namesByType(): Promise<Record<string, string[]>> {
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, at]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string; type: string; data: { name?: string } }[] };
      };
      const out: Record<string, string[]> = {};
      for (const n of canvas.readCanvasGraph(pid, sid).nodes) (out[n.type] ??= []).push(n.data.name ?? n.id);
      for (const list of Object.values(out)) list.sort();
      return out;
    },
    [projectId, spaceId, canvasAt] as [string, string, string],
  );
}

/**
 * The id of the open Space's node with a name.
 * @param name - The name.
 * @returns Its id.
 */
async function nodeIdNamed(name: string): Promise<string> {
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  const id = await page.evaluate(
    async ([pid, sid, label, at]: [string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string; data: { name?: string } }[] };
      };
      return canvas.readCanvasGraph(pid, sid).nodes.find((n) => n.data.name === label)?.id ?? '';
    },
    [projectId, spaceId, name, canvasAt] as [string, string, string, string],
  );
  if (id === '') throw new Error(`no node named ${name}`);
  return id;
}

test('an audio panel lists the ten sound templates under one goal', async () => {
  await openPanelOnNewNode('audio');
  await openGoal('sound');
  await expect(page.locator('[data-testid^="generate-template-goal-"]')).toHaveCount(1);
  await expect(page.getByTestId('generate-template-goal-sound')).toHaveText(/^Sound, music & voice\s*10$/);
  expect(await listedTemplates()).toEqual([
    'ambience-sfx-bed',
    'voice-line',
    'two-voice-dialogue',
    'underscore-bgm',
    'voice-from-descriptor',
    'song-cover',
    'voice-clone-line',
    'score-for-my-video',
    'music-mood-from-image',
    'section-mapped-score',
  ]);
});

test('a video panel lists the one sound template, the silent shot with foley', async () => {
  await openPanelOnNewNode('video');
  await openGoal('sound');
  await expect(page.getByTestId('generate-template-goal-sound')).toHaveText(/^Sound, music & voice\s*1$/);
  expect(await listedTemplates()).toEqual(['clip-ambience-foley']);
});

test('picking music for your video places the video it asks for, wired into the anchor, and notes to pick it into the Video slot', async () => {
  await openPanelOnNewNode('audio');
  await openGoal('sound');
  await page.getByTestId('generate-template-score-for-my-video').click();

  await expect(page.getByTestId('generate-model-trigger')).toContainText('Sonilo', { timeout: 15_000 });
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(2, { timeout: 15_000 });
  expect(await graph()).toEqual({ names: ['Your video', 'audio-template'], edges: ['Your video -> audio-template'] });
  const prompt = page.getByTestId('generate-prompt-editor');
  // The note leads the prompt, and the video goes into the slot, not the prompt.
  const note = prompt.locator('[data-prompt-note]');
  await expect(note).toHaveCount(1);
  await expect(note).toContainText('Add your video first, then pick it into the Video slot');
  expect(await prompt.locator('.ProseMirror').evaluate((root) => (root.firstElementChild?.querySelector('[data-prompt-note]') ?? null) !== null)).toBe(true);
  await expect(prompt.locator('[data-reference-mention]')).toHaveCount(0);
  await expect(page.getByTestId('generate-audio-tool-sound-video')).toBeVisible();
  await expect(page.getByTestId('generate-audio-sound-video-clear')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('score-for-my-video-applied.png') });
});

test('picking music for your video puts a video already wired in into the Video slot and places nothing new', async () => {
  await page.route('https://smoke-media.test/**', (route) =>
    route.fulfill({
      status: 200,
      body: readFileSync(join(__dirname, '../fixtures/mini-tools/driving.mp4')),
      headers: { 'access-control-allow-origin': '*', 'content-type': 'video/mp4' },
    }),
  );
  const nodeId = await openPanelOnNewNode('audio');
  await seedWiredMaterial('video', 'Ride', 'https://smoke-media.test/ride.mp4', nodeId);
  await openGoal('sound');
  await page.getByTestId('generate-template-score-for-my-video').click();

  await expect(page.getByTestId('generate-audio-sound-video-clear')).toBeVisible({ timeout: 15_000 });
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(2);
  expect(await graph()).toEqual({ names: ['Ride', 'audio-template'], edges: ['Ride -> audio-template'] });
  // Nothing is left to do with the video, so no note asks for it.
  await expect(page.getByTestId('generate-prompt-editor').locator('[data-prompt-note]')).toHaveCount(0);
});

test('picking the silent shot with foley places a foley node right of the video, wired from it', async () => {
  const nodeId = await openPanelOnNewNode('video');
  await openGoal('sound');
  await page.getByTestId('generate-template-clip-ambience-foley').click();

  await expect(page.getByTestId('generate-model-trigger')).toContainText('Kling', { timeout: 15_000 });
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(2, { timeout: 15_000 });
  expect(await graph()).toEqual({ names: ['Foley', 'video-template'], edges: ['video-template -> Foley'] });
  expect((await namesByType()).audio).toEqual(['Foley']);
  const foleyId = await nodeIdNamed('Foley');
  const anchorBox = await visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
  const foleyBox = await visibleSpace(page).locator(`.react-flow__node[data-id="${foleyId}"]`).boundingBox();
  expect(foleyBox?.x ?? 0).toBeGreaterThanOrEqual((anchorBox?.x ?? 0) + (anchorBox?.width ?? 0));
});

test('picking the score in four sections places three more sections and a guide, wired to nothing, and picking it again places nothing', async () => {
  await openPanelOnNewNode('audio');
  await openGoal('sound');
  await page.getByTestId('generate-template-section-mapped-score').click();

  await expect(page.getByTestId('generate-model-trigger')).toContainText('Mureka', { timeout: 15_000 });
  await expect.poll(async () => (await namesByType()).audio, { timeout: 15_000 }).toEqual(['Body', 'Outro', 'Reveal', 'audio-template']);
  const placed = await namesByType();
  expect(placed.text).toEqual(['Score in four sections']);
  expect((await graph()).edges).toEqual([]);
  const count = await visibleSpace(page).locator('.react-flow__node').count();
  await page.screenshot({ path: test.info().outputPath('section-mapped-score-applied.png') });

  await openGoal('sound');
  await page.getByTestId('generate-template-section-mapped-score').click();
  await expect(page.getByTestId('generate-template-goal-sound')).toHaveCount(0);
  await page.waitForTimeout(1_000);
  expect(await namesByType()).toEqual(placed);
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(count);
  expect((await graph()).edges).toEqual([]);
});

test('picking the two-voice dialogue reads it on Gemini with Ava and Leo, and a run sends the speakers, not a voice', async () => {
  await openPanelOnNewNode('audio');
  await openGoal('sound');
  await page.getByTestId('generate-template-two-voice-dialogue').click();

  await expect(page.getByTestId('generate-model-trigger')).toContainText('Gemini', { timeout: 15_000 });
  const pill = page.getByTestId('generate-audio-settings-trigger');
  await expect(pill).toContainText('Dialogue · 2');
  await pill.click();
  await expect(page.getByTestId('generate-audio-row-voice_id')).toHaveCount(0);
  await expect(page.getByTestId('generate-audio-row-speakers-0')).toContainText('Ava · Kore');
  await expect(page.getByTestId('generate-audio-row-speakers-1')).toContainText('Leo · Puck');
  await expect(page.getByTestId('generate-audio-row-speakers-2')).toHaveCount(0);
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(pill).toHaveAttribute('aria-expanded', 'false', { timeout: 500 });
  }).toPass({ timeout: 5_000 });

  const prompt = page.getByTestId('generate-prompt-editor');
  await prompt.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Ava: You are early today. Leo: I wanted the first loaf.');
  let sent: { params?: Record<string, unknown> } | null = null;
  await page.route('**/canvas/tasks', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent = route.request().postDataJSON() as { params?: Record<string, unknown> };
    // A final answer, so the press does not send it again (inner#1490).
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: crypto.randomUUID(), status: 'queued' } }),
    });
  });
  await page.getByTestId('generate-audio-execute').click();
  await expect.poll(() => sent, { timeout: 15_000 }).not.toBeNull();
  const params = (sent as { params?: Record<string, unknown> } | null)?.params ?? {};
  expect((params.speakers as { speaker: string; voice: string }[] | undefined)?.map((s) => `${s.speaker}:${s.voice}`)).toEqual(['Ava:Kore', 'Leo:Puck']);
  expect(params).not.toHaveProperty('voice_id');
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
