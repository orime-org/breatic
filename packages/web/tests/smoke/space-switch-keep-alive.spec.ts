// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Switching Space tabs hides the Space it leaves and shows it again as it was
 * (inner#1235). Every case here works in a real browser: what hiding does to
 * focus, to the canvas library's store and to an editor's caret is browser
 * behaviour, and jsdom has none of it.
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from 'playwright/test';

import { CANVAS_SPACE, TEXT_BODY, liveModuleUrl } from '../helpers/live-module';
import { selectFirstParagraph } from '../helpers/bubble-bar';
import { dragTabOnto } from '../helpers/tab-strip';
import { DOCUMENT_EDITOR, VISIBLE_SPACE, visibleSpace } from '../helpers/space';
import {
  activeId,
  addSpaces,
  camera,
  storedViewport,
  openFreshProject,
  projectIdOf,
  stripIds,
} from '../helpers/tab-restore';

/**
 * Adds an empty node of a type to a Space's document.
 * @param p - A page with the Space open.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param id - The node id.
 * @param type - The node type.
 * @param at - Where it goes, in canvas coordinates.
 */
async function seedNode(
  p: Page,
  projectId: string,
  spaceId: string,
  id: string,
  type: 'text' | 'image',
  at: { x: number; y: number } = { x: 0, y: 0 },
): Promise<void> {
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  await p.evaluate(
    async ([pid, sid, nodeId, kind, canvasUrl, x, y]: string[]) => {
      const canvas = (await import(/* @vite-ignore */ canvasUrl!)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid!, sid!, {
        id: nodeId,
        type: kind,
        position: { x: Number(x), y: Number(y) },
        data: {
          name: 'keep-alive',
          createdAt: Date.now(),
          createdBy: 'keep-alive',
          locked: false,
          attachments: [],
        },
      });
    },
    [projectId, spaceId, id, type, canvasAt, String(at.x), String(at.y)],
  );
}

/**
 * Writes a text node holding some words into a Space's document.
 * @param p - A page with the Space open.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param id - The node id.
 * @param words - What the node says.
 */
async function seedTextNode(
  p: Page,
  projectId: string,
  spaceId: string,
  id: string,
  words: string,
): Promise<void> {
  await seedNode(p, projectId, spaceId, id, 'text');
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  const bodyAt = await liveModuleUrl(p, TEXT_BODY);
  await p.evaluate(
    async ([pid, sid, nodeId, text, canvasUrl, bodyUrl]: string[]) => {
      const canvas = (await import(/* @vite-ignore */ canvasUrl!)) as {
        getTextBody: (p: string, s: string, id: string) => unknown;
      };
      const shared = (await import(/* @vite-ignore */ bodyUrl!)) as {
        writePlainTextIntoBody: (b: unknown, t: string) => void;
      };
      shared.writePlainTextIntoBody(canvas.getTextBody(pid!, sid!, nodeId!), text!);
    },
    [projectId, spaceId, id, words, canvasAt, bodyAt],
  );
}

/**
 * Shows a Space by its tab.
 * @param p - The page.
 * @param spaceId - The Space.
 */
async function showSpace(p: Page, spaceId: string): Promise<void> {
  await p.locator(`[data-testid="space-tab-${spaceId}"]`).click();
  await expect.poll(() => activeId(p)).toBe(spaceId);
}

test('a canvas keeps its nodes, not rebuilt ones, across a switch', async ({ page }) => {
  // Everything a node holds on screen — a video's position, a panel's scroll —
  // lives on its elements; the reader comes back to those elements, not new ones.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await seedNode(page, projectIdOf(projectUrl), first, 'kept-node', 'image');
  const node = visibleSpace(page).locator('.react-flow__node[data-id="kept-node"]');
  await expect(node).toBeVisible({ timeout: 20_000 });
  await node.evaluate((el) => {
    (el as unknown as { keptMark?: boolean }).keptMark = true;
  });

  await showSpace(page, second);
  await showSpace(page, first);

  await expect(node).toBeVisible();
  expect(
    await node.evaluate((el) => (el as unknown as { keptMark?: boolean }).keptMark === true),
  ).toBe(true);
});

test('a node panel is the same panel after a switch', async ({ page }) => {
  // A submit in flight, a list scrolled down: what a panel holds lives on it.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await seedNode(page, projectIdOf(projectUrl), first, 'kept-panel-host', 'image');
  const node = visibleSpace(page).locator('.react-flow__node[data-id="kept-panel-host"]');
  await expect(node).toBeVisible({ timeout: 20_000 });
  await node.click({ button: 'right' });
  await page.getByTestId('node-menu-generate').click();
  const panel = visibleSpace(page).getByTestId('generate-prompt-editor');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await panel.evaluate((el) => {
    (el as unknown as { keptMark?: boolean }).keptMark = true;
  });

  await showSpace(page, second);
  await showSpace(page, first);

  await expect(panel).toBeVisible();
  expect(
    await panel.evaluate((el) => (el as unknown as { keptMark?: boolean }).keptMark === true),
  ).toBe(true);
});

test('a canvas opened empty is not framed again once it has content', async ({ page }) => {
  // A3: a Space with no stored camera is framed on its first open only.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await expect(visibleSpace(page).locator('.react-flow__viewport')).toBeVisible({
    timeout: 20_000,
  });
  await seedNode(page, projectIdOf(projectUrl), first, 'late-a', 'image', { x: 900, y: 700 });
  await seedNode(page, projectIdOf(projectUrl), first, 'late-b', 'image', { x: 1600, y: 1200 });
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(2, {
    timeout: 20_000,
  });
  const before = await camera(page);

  await showSpace(page, second);
  await showSpace(page, first);

  await expect.poll(() => camera(page)).toEqual(before);
});

test('a text node being written stays open with its caret and undo across a switch', async ({
  page,
}) => {
  // A13: the words are in the document either way; what a switch must not
  // take is the editor itself — the caret where the reader left it and the
  // undo that takes back what they just typed.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await seedTextNode(page, projectIdOf(projectUrl), first, 'keep-alive-text', 'Seeded');
  const node = visibleSpace(page).locator('.react-flow__node[data-id="keep-alive-text"]');
  await expect(node).toBeVisible({ timeout: 20_000 });
  await node.dblclick();
  const body = node.locator('[data-testid="text-node-body"][contenteditable="true"]');
  await expect(body).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' words');
  await expect(body).toHaveText('Seeded words');

  await showSpace(page, second);
  await showSpace(page, first);

  await expect(body).toBeVisible();
  await expect(body).toBeFocused();
  await page.keyboard.type('!');
  await expect(body).toHaveText('Seeded words!');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(body).not.toHaveText('Seeded words!');
});

test('a prompt being written stays with its caret and undo across a switch', async ({ page }) => {
  // A13, the generate panel's half: the panel is taken down with the hidden
  // canvas and put back, and the prompt's editor must come back with it.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await seedNode(page, projectIdOf(projectUrl), first, 'keep-alive-image', 'image');
  const node = visibleSpace(page).locator('.react-flow__node[data-id="keep-alive-image"]');
  await expect(node).toBeVisible({ timeout: 20_000 });
  await node.click({ button: 'right' });
  await page.getByTestId('node-menu-generate').click();
  const prompt = visibleSpace(page).locator('[data-testid="generate-prompt-editor"] .ProseMirror');
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await prompt.click();
  await page.keyboard.type('a red fox');
  await expect(prompt).toHaveText('a red fox');

  await showSpace(page, second);
  await showSpace(page, first);

  await expect(prompt).toBeVisible();
  await expect(prompt).toBeFocused();
  await page.keyboard.type('!');
  await expect(prompt).toHaveText('a red fox!');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(prompt).not.toHaveText('a red fox!');
});

test('a note being written stays open with its words across a switch', async ({ page }) => {
  // A14: the box exists nowhere but on this screen, so hiding the Space must
  // not read as the reader having left it.
  await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await page.getByTestId('tool-comment').click();
  const pane = visibleSpace(page).locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the canvas pane has no box');
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.4);
  const composer = visibleSpace(page).getByTestId('annotation-composer-input');
  await expect(composer).toBeFocused({ timeout: 15_000 });
  await page.keyboard.type('half a thought');

  await showSpace(page, second);
  await showSpace(page, first);

  await expect(composer).toHaveValue('half a thought');
  await composer.click();
  await page.keyboard.type(' finished');
  await page.keyboard.press('Enter');
  await expect(composer).toHaveCount(0);
});

test('a document being written keeps its caret across a switch', async ({ page }) => {
  // A1: the reader comes back to the place they were typing, and the next
  // keystroke lands there.
  await openFreshProject(page);
  const [doc] = await addSpaces(page, 1, 'document');
  // The dialog hands focus back to its button once it has closed; a click in
  // the editor before that would have its caret taken away.
  await expect(page.getByTestId('new-space-button')).toBeFocused();
  const [first] = (await stripIds(page)) as [string, string];
  await showSpace(page, doc!);
  const editor = page.locator(DOCUMENT_EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type('first line');

  await showSpace(page, first);
  await showSpace(page, doc!);

  await expect(editor).toBeFocused();
  await page.keyboard.type(' kept');
  await expect(editor.locator('p').first()).toHaveText('first line kept');
});

test('a document scrolled down comes back at the same place', async ({ page }) => {
  // A1: hiding a Space takes its scroller out of layout, and a scroller out
  // of layout reads 0; the reader comes back to the line they left.
  await openFreshProject(page);
  const [doc] = await addSpaces(page, 1, 'document');
  // The dialog hands focus back to its button once it has closed; a click in
  // the editor before that would have its caret taken away.
  await expect(page.getByTestId('new-space-button')).toBeFocused();
  const [first] = (await stripIds(page)) as [string, string];
  await showSpace(page, doc!);
  const editor = page.locator(DOCUMENT_EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.type(`line ${String(i)} of a document long enough to scroll`);
    await page.keyboard.press('Enter');
  }
  const scroller = visibleSpace(page).locator(
    '.doc-body-scroller [data-radix-scroll-area-viewport]',
  );
  await scroller.evaluate((el) => el.scrollTo(0, 300));
  await expect.poll(() => scroller.evaluate((el) => Math.round(el.scrollTop))).toBe(300);

  await showSpace(page, first);
  await showSpace(page, doc!);

  await expect.poll(() => scroller.evaluate((el) => Math.round(el.scrollTop))).toBe(300);
});

test('a wide table scrolled sideways comes back at the same place', async ({ page }) => {
  // A1: the document's DOM is put back into its body when the Space is shown
  // again; a wide table's frame must still be where the reader scrolled it.
  await openFreshProject(page);
  const [doc] = await addSpaces(page, 1, 'document');
  await expect(page.getByTestId('new-space-button')).toBeFocused();
  const [first] = (await stripIds(page)) as [string, string];
  await showSpace(page, doc!);
  const editor = page.locator(DOCUMENT_EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type('above');
  const row = await page
    .locator(`${DOCUMENT_EDITOR} > .bn-block-group > .bn-block-outer > .bn-block > .bn-block-content`)
    .first()
    .boundingBox();
  if (row === null) throw new Error('the first row has no box');
  await page.mouse.move(row.x + 40, row.y + Math.min(row.height / 2, 12), { steps: 3 });
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-9').click();
  for (let i = 0; i < 9; i += 1) {
    if (i > 0) await page.keyboard.press('Tab');
    await page.keyboard.type(`column ${String(i)} wide enough`);
  }
  const frame = page.locator(`${DOCUMENT_EDITOR} [data-radix-scroll-area-viewport]`).first();
  await frame.evaluate((viewport) => {
    viewport.scrollLeft = 200;
  });
  await expect.poll(() => frame.evaluate((el) => Math.round(el.scrollLeft))).toBe(200);

  await showSpace(page, first);
  await showSpace(page, doc!);

  await expect.poll(() => frame.evaluate((el) => Math.round(el.scrollLeft))).toBe(200);
});

/** A 320x240 solid PNG, inline so it decodes with no network. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADwCAIAAAD+Tyo8AAACD0lEQVR42u3TQQkAAAgEwUtnCJMY3w7+hIFJsLCpHuCpSAAGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGAysAhgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMBhYBTAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMHC3pCIzOUa0Hy8AAAAASUVORK5CYII=',
  'base64',
);

/** Real decoded media, both tracks present (64x48, 15 seconds). */
const CLIP = readFileSync(resolve(__dirname, '../fixtures/media-history.mp4'));

/**
 * Opens a fresh project with a document Space beside its canvas, the document
 * shown with the caret in its body.
 * @param p - The page.
 * @returns The canvas Space and the document Space.
 */
async function canvasAndDocument(p: Page): Promise<{ canvas: string; doc: string }> {
  await openFreshProject(p);
  const [doc] = await addSpaces(p, 1, 'document');
  await expect(p.getByTestId('new-space-button')).toBeFocused();
  const [canvas] = (await stripIds(p)) as [string, string];
  await showSpace(p, doc!);
  const editor = p.locator(DOCUMENT_EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  return { canvas, doc: doc! };
}

test('a document\'s undo history and its controls are all there after a switch', async ({ page }) => {
  // A1: the next undo takes back what was typed before the switch, and the
  // block handle and the bubble bar come up as they did before it.
  const { canvas, doc } = await canvasAndDocument(page);
  await page.keyboard.type('typed before the switch');

  await showSpace(page, canvas);
  await showSpace(page, doc);

  const editor = page.locator(DOCUMENT_EDITOR);
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor.locator('p').first()).toHaveText('');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(editor.locator('p').first()).toHaveText('typed before the switch');

  const row = await editor.locator('p').first().boundingBox();
  if (row === null) throw new Error('the first row has no box');
  await page.mouse.move(row.x + 40, row.y + row.height / 2, { steps: 3 });
  await expect(visibleSpace(page).getByTestId('doc-block-handle')).toBeVisible();
  await selectFirstParagraph(page);
  await expect(page.getByTestId('doc-bubble-tool-comment')).toBeVisible();
});

test('a comment not sent yet is still being written after a switch', async ({ page }) => {
  // A2: the draft card and its words are where the reader left them.
  const { canvas, doc } = await canvasAndDocument(page);
  await page.keyboard.type('a line to comment on');
  await selectFirstParagraph(page);
  await page.getByTestId('doc-bubble-tool-comment').click();
  const draft = page.getByTestId('doc-comment-draft-input');
  await draft.fill('words not sent yet');

  await showSpace(page, canvas);
  await showSpace(page, doc);

  await expect(draft).toBeVisible();
  await expect(draft).toHaveValue('words not sent yet');
});

test('the nodes selected on a canvas are still selected after a switch', async ({ page }) => {
  // A3.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await seedNode(page, projectIdOf(projectUrl), first, 'kept-selected', 'image');
  const node = visibleSpace(page).locator('.react-flow__node[data-id="kept-selected"]');
  await expect(node).toBeVisible({ timeout: 20_000 });
  await node.click();
  await expect(node).toHaveClass(/selected/);

  await showSpace(page, second);
  await showSpace(page, first);

  await expect(node).toHaveClass(/selected/);
});

test('the zoom readout and a zoom act on the canvas on screen only', async ({ page }) => {
  // A4: zooming one canvas leaves the one kept hidden alone, and the readout
  // reads whichever is shown.
  await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const firstCamera = await camera(page);
  const firstReadout = await page.getByTestId('zoom-readout').textContent();

  await showSpace(page, second);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  if (pane === null) throw new Error('the pane has no box');
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await camera(page)).zoom).not.toBe(firstCamera.zoom);
  await expect(page.getByTestId('zoom-readout')).not.toHaveText(firstReadout ?? '');

  await showSpace(page, first);

  expect(await camera(page)).toEqual(firstCamera);
  await expect(page.getByTestId('zoom-readout')).toHaveText(firstReadout ?? '');
});

test('an upload started on one canvas lands there, done, while another is shown', async ({ page }) => {
  // A4: the upload tool puts the file on the canvas on screen. A7: switching
  // away before it finishes still leaves a finished node to come back to.
  await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  await showSpace(page, second);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const onSecond = await visibleSpace(page).locator('.react-flow__node').count();
  await showSpace(page, first);
  const ids = (): Promise<string[]> =>
    visibleSpace(page)
      .locator('.react-flow__node')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-id') ?? ''));
  const before = await ids();
  await page
    .locator('input[data-testid="canvas-upload-input"][multiple]')
    .setInputFiles([{ name: 'kept-upload.png', mimeType: 'image/png', buffer: PNG }]);
  await expect.poll(async () => (await ids()).length).toBe(before.length + 1);
  const added = (await ids()).find((id) => !before.includes(id))!;

  await showSpace(page, second);
  await page.waitForTimeout(10_000);
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(onSecond);
  await showSpace(page, first);

  const img = visibleSpace(page)
    .locator(`.react-flow__node[data-id="${added}"]`)
    .getByTestId('image-node-img');
  await expect(img).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
    timeout: 30_000,
  }).toBe(320);
});

test('a hidden canvas takes no keys and stops what it was playing', async ({ page }) => {
  // A5: keys pressed in the document do not reach the canvas behind it, and a
  // video playing on the canvas pauses when it is hidden.
  const { canvas, doc } = await canvasAndDocument(page);
  const projectId = projectIdOf(page.url());
  await showSpace(page, canvas);
  const src = `${new URL(page.url()).origin}/keep-alive-clip.mp4`;
  await page.route('**/keep-alive-clip.mp4', (route) =>
    route.fulfill({ contentType: 'video/mp4', body: CLIP }),
  );
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([at, pid, sid, url]: string[]) => {
      const mod = (await import(/* @vite-ignore */ at!)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      mod.addNode(pid!, sid!, {
        id: 'kept-video',
        type: 'video',
        position: { x: 0, y: 0 },
        data: {
          name: 'keep-alive',
          createdAt: Date.now(),
          createdBy: 'keep-alive',
          locked: false,
          state: 'idle',
          attachments: [],
          content: url,
        },
      });
    },
    [canvasAt, projectId, canvas, src],
  );
  const node = page.locator('.react-flow__node[data-id="kept-video"]');
  const media = node.getByTestId('media-element');
  await expect
    .poll(() => media.evaluate((el: HTMLMediaElement) => el.readyState), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);
  await node.click({ position: { x: 4, y: 4 } });
  await expect(node).toHaveClass(/selected/);
  await node.getByTestId('play-toggle').click();
  await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.paused)).toBe(false);

  await showSpace(page, doc);
  await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.paused)).toBe(true);
  await page.locator(DOCUMENT_EDITOR).click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');

  await showSpace(page, canvas);
  await expect(node).toBeVisible();
});

test('a peer sees the pointer go when the Space is hidden, and their writes are there on return', async ({
  page,
}) => {
  // A5: a hidden canvas shows nobody where this reader's pointer is. A6: what
  // another person changed in the meantime is on the canvas when it is shown.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  const peer = await page.context().newPage();
  try {
    await peer.goto(projectUrl);
    await peer.locator(`[data-testid="space-tab-${first}"]`).click();
    await expect(visibleSpace(peer).locator('.react-flow')).toBeVisible({ timeout: 20_000 });

    const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
    if (pane === null) throw new Error('the pane has no box');
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2, { steps: 4 });
    const pointer = visibleSpace(peer).locator('[data-testid^="canvas-cursor-"]');
    await expect(pointer).toHaveCount(1, { timeout: 15_000 });

    await showSpace(page, second);
    await expect(pointer).toHaveCount(0, { timeout: 15_000 });

    await seedNode(peer, projectIdOf(projectUrl), first, 'peer-wrote-this', 'image');
    await expect(visibleSpace(peer).locator('.react-flow__node[data-id="peer-wrote-this"]'))
      .toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2_000);
    await showSpace(page, first);

    await expect(visibleSpace(page).locator('.react-flow__node[data-id="peer-wrote-this"]'))
      .toBeVisible({ timeout: 20_000 });
  } finally {
    await peer.close();
  }
});

test('the background of the canvas on screen moves with that canvas when another is kept', async ({
  page,
}) => {
  // A3: with two canvases on the page, the dot grid shown is the shown
  // canvas's own, so it follows that canvas's pan.
  await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  for (const id of [first, second]) {
    await showSpace(page, id);
    await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  }
  const grid = (): Promise<{ own: boolean; x: string | null }> =>
    page.evaluate((space) => {
      const rect = document.querySelector(`${space} [data-testid="rf__background"] rect`);
      const id = (rect?.getAttribute('fill') ?? '').slice(5, -1);
      const pattern = document.getElementById(id);
      return {
        own: pattern?.closest('[data-space-outlet]') === rect?.closest('[data-space-outlet]'),
        x: pattern?.getAttribute('x') ?? null,
      };
    }, VISIBLE_SPACE);
  const before = await grid();
  expect(before.own).toBe(true);
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  if (pane === null) throw new Error('the pane has no box');
  await page.mouse.move(pane.x + 300, pane.y + 300);
  await page.mouse.wheel(37, 11);

  await expect.poll(async () => (await grid()).x).not.toBe(before.x);
});

test('reordering the tabs leaves a document where the reader scrolled it', async ({ page }) => {
  // A1: dragging a tab to another place on the strip moves the tab, not the
  // Space's content, which stays scrolled where the reader left it.
  await openFreshProject(page);
  const [docA, docB] = await addSpaces(page, 2, 'document');
  await expect(page.getByTestId('new-space-button')).toBeFocused();
  await showSpace(page, docA!);
  const editor = page.locator(DOCUMENT_EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.type(`line ${String(i)} of a document long enough to scroll`);
    await page.keyboard.press('Enter');
  }
  const scroller = visibleSpace(page).locator(
    '.doc-body-scroller [data-radix-scroll-area-viewport]',
  );
  await scroller.evaluate((el) => el.scrollTo(0, 300));
  await expect.poll(() => scroller.evaluate((el) => Math.round(el.scrollTop))).toBe(300);

  await dragTabOnto(page, docA!, docB!);
  await expect.poll(async () => (await stripIds(page)).indexOf(docA!)).toBeGreaterThan(
    (await stripIds(page)).indexOf(docB!),
  );

  await expect.poll(() => scroller.evaluate((el) => Math.round(el.scrollTop))).toBe(300);
});

/**
 * Adds an image node showing a decoded picture.
 * @param p - A page with the Space open.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param id - The node id.
 * @param at - Where it goes, in canvas coordinates.
 */
async function seedPicture(
  p: Page,
  projectId: string,
  spaceId: string,
  id: string,
  at: { x: number; y: number },
): Promise<void> {
  // The crop export asks for the picture again in CORS mode, with a query.
  await p.route('**/keep-alive-picture.png*', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: PNG,
      headers: { 'Access-Control-Allow-Origin': '*' },
    }),
  );
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  await p.evaluate(
    async ([pid, sid, nodeId, url, src, x, y]: string[]) => {
      const canvas = (await import(/* @vite-ignore */ url!)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid!, sid!, {
        id: nodeId,
        type: 'image',
        position: { x: Number(x), y: Number(y) },
        data: {
          name: 'keep-alive',
          createdAt: Date.now(),
          createdBy: 'keep-alive',
          locked: false,
          state: 'idle',
          attachments: [],
          content: src,
        },
      });
    },
    [
      projectId,
      spaceId,
      id,
      canvasAt,
      `${new URL(p.url()).origin}/keep-alive-picture.png`,
      String(at.x),
      String(at.y),
    ],
  );
  await expect
    .poll(
      () =>
        visibleSpace(p)
          .locator(`.react-flow__node[data-id="${id}"] [data-testid="image-node-img"]`)
          .evaluate((el: HTMLImageElement) => el.naturalWidth),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
}

/**
 * Opens the Generate panel on a node.
 * @param p - The page.
 * @param nodeId - The node.
 */
async function openGenerate(p: Page, nodeId: string): Promise<void> {
  await visibleSpace(p)
    .locator(`.react-flow__node[data-id="${nodeId}"]`)
    .click({ button: 'right', position: { x: 4, y: 4 } });
  await p.getByTestId('node-menu-generate').click();
  await expect(visibleSpace(p).getByTestId('generate-prompt-editor')).toBeVisible({
    timeout: 15_000,
  });
}

test('choosing Generate again on the open panel keeps what was typed undoable', async ({
  page,
}) => {
  // A13: the open panel chosen again on its own node is the same panel, and
  // its prompt editor keeps its undo history.
  const projectUrl = await openFreshProject(page);
  const [space] = (await stripIds(page)) as [string];
  await seedPicture(page, projectIdOf(projectUrl), space, 'again-host', { x: 0, y: 0 });
  await openGenerate(page, 'again-host');
  const prompt = visibleSpace(page).getByTestId('generate-prompt-editor').locator('.ProseMirror');
  await prompt.click();
  await page.keyboard.type('a red cat');

  await openGenerate(page, 'again-host');
  await prompt.click();
  await page.keyboard.press('ControlOrMeta+z');

  await expect(prompt).not.toContainText('a red cat');
});

test('a focus pick left on a canvas is still on when the canvas is shown again', async ({
  page,
}) => {
  // A15: switching away and back is not the pick ending, and says nothing.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  const projectId = projectIdOf(projectUrl);
  await seedPicture(page, projectId, first, 'pick-host', { x: 0, y: 0 });
  await seedPicture(page, projectId, first, 'pick-source', { x: 520, y: 0 });
  await openGenerate(page, 'pick-host');
  await page.getByTestId('generate-tool-focus').click();
  const banner = visibleSpace(page).getByTestId('reference-pick-banner');
  await expect(banner).toBeVisible();

  await showSpace(page, second);
  await showSpace(page, first);

  await expect(banner).toBeVisible();
  await expect(page.getByText('Selection ended.')).toHaveCount(0);
  await visibleSpace(page)
    .locator('.react-flow__node[data-id="pick-source"] [data-testid="image-node-img"]')
    .click();
  await expect(page.getByTestId('focus-crop-controls')).toBeVisible({ timeout: 10_000 });
});

test('a tab with a focus crop still uploading cannot be closed', async ({ page }) => {
  // A17: closing is held back while the cropped picture is on its way.
  const projectUrl = await openFreshProject(page);
  const [space] = (await stripIds(page)) as [string];
  const projectId = projectIdOf(projectUrl);
  await seedPicture(page, projectId, space, 'crop-host', { x: 0, y: 0 });
  await seedPicture(page, projectId, space, 'crop-source', { x: 520, y: 0 });
  await openGenerate(page, 'crop-host');
  await page.getByTestId('generate-tool-focus').click();
  await visibleSpace(page)
    .locator('.react-flow__node[data-id="crop-source"] [data-testid="image-node-img"]')
    .click();
  await expect(page.getByTestId('focus-crop-controls')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('focus-ratio-original').click();
  // The upload is held so that it is still on its way when the tab is closed.
  await page.route('**/assets/upload-ticket**', () => undefined);
  await page.getByTestId('focus-crop-confirm').click();

  await page.locator(`[data-testid="space-tab-${space}"]`).hover();
  await page.locator(`[data-testid="space-tab-close-${space}"]`).click();

  await expect(
    page.getByText('An operation is still in progress — finish it before closing this Space.'),
  ).toBeVisible();
  expect(await stripIds(page)).toContain(space);
});

test('a panel whose node a collaborator deleted while hidden closes and says so', async ({
  page,
}) => {
  // A16: the reader comes back to the panel gone and the reason on screen.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  const projectId = projectIdOf(projectUrl);
  await seedPicture(page, projectId, first, 'doomed-host', { x: 0, y: 0 });
  await openGenerate(page, 'doomed-host');
  await showSpace(page, second);

  const peer = await page.context().newPage();
  try {
    await peer.goto(projectUrl);
    await peer.locator(`[data-testid="space-tab-${first}"]`).click();
    await expect(visibleSpace(peer).locator('.react-flow__node[data-id="doomed-host"]')).toBeVisible({
      timeout: 20_000,
    });
    const canvasAt = await liveModuleUrl(peer, CANVAS_SPACE);
    await peer.evaluate(
      async ([pid, sid, url]: string[]) => {
        const canvas = (await import(/* @vite-ignore */ url!)) as {
          removeNode: (p: string, s: string, id: string) => void;
        };
        canvas.removeNode(pid!, sid!, 'doomed-host');
      },
      [projectId, first, canvasAt],
    );
    await expect(peer.locator('.react-flow__node[data-id="doomed-host"]')).toHaveCount(0);
    await page.waitForTimeout(2_000);

    await showSpace(page, first);

    await expect(page.getByText('A collaborator deleted the node.')).toBeVisible();
    await expect(visibleSpace(page).getByTestId('generate-prompt-editor')).toHaveCount(0);
  } finally {
    await peer.close();
  }
});

test('a closed tab leaves the page, and opens again on the camera it was closed on', async ({
  page,
}) => {
  // A8: closing unmounts the Space and releases what it held. A18: storage
  // keeps the closed tab's camera, so opening it again lands where it was.
  await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  if (pane === null) throw new Error('the pane has no box');
  await page.mouse.move(pane.x + 300, pane.y + 300);
  await page.mouse.wheel(120, 80);
  await expect.poll(async () => (await camera(page)).x).not.toBe(0);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await camera(page)).zoom).not.toBe(1);
  const aimed = await camera(page);
  await showSpace(page, second);

  await page.locator(`[data-testid="space-tab-${first}"]`).hover();
  await page.locator(`[data-testid="space-tab-close-${first}"]`).click();
  await expect.poll(() => stripIds(page)).not.toContain(first);
  await expect(page.locator(`[data-space-outlet="${first}"]`)).toHaveCount(0);

  expect(await storedViewport(page, first)).not.toBeNull();

  await page.getByTestId('space-drawer-trigger').click();
  await page.getByTestId(`space-drawer-row-${first}`).click();
  await expect.poll(() => activeId(page)).toBe(first);
  if (await page.getByTestId('space-drawer').isVisible()) await page.keyboard.press('Escape');
  await expect(page.getByTestId('space-drawer')).toBeHidden();
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => camera(page)).toEqual(aimed);
});

test('a hidden document shows no floating bar, no caret to others, and takes in their writes', async ({
  page,
}) => {
  // A5 and A6 for a document: hidden, its bubble bar is off screen and a
  // collaborator no longer sees this reader's caret; what the collaborator
  // writes meanwhile is there when it is shown again.
  const projectUrl = await openFreshProject(page);
  const [docA, docB] = await addSpaces(page, 2, 'document');
  await expect(page.getByTestId('new-space-button')).toBeFocused();
  await showSpace(page, docA!);
  const editor = page.locator(DOCUMENT_EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type('the reader was here');

  const peer = await page.context().newPage();
  try {
    await peer.goto(projectUrl);
    await peer.locator(`[data-testid="space-tab-${docA!}"]`).click();
    const peerEditor = peer.locator(DOCUMENT_EDITOR);
    await expect(peerEditor).toContainText('the reader was here', { timeout: 20_000 });
    const carets = peer.locator(
      `${VISIBLE_SPACE} .collaboration-carets__caret:not(.collaboration-carets__caret--blurred)`,
    );
    await expect(carets).toHaveCount(1, { timeout: 15_000 });

    await selectFirstParagraph(page);
    await expect(page.getByTestId('doc-bubble-tool-comment')).toBeVisible();
    await showSpace(page, docB!);

    await expect(page.getByTestId('doc-bubble-tool-comment')).toBeHidden();
    await expect(carets).toHaveCount(0, { timeout: 15_000 });

    await peerEditor.click();
    await peer.keyboard.press('ControlOrMeta+End');
    await peer.keyboard.press('Enter');
    await peer.keyboard.type('written while it was hidden');
    await page.waitForTimeout(2_000);
    await showSpace(page, docA!);

    await expect(editor).toContainText('written while it was hidden');
  } finally {
    await peer.close();
  }
});

test('a node name being typed stays open and unsent across a switch', async ({ page }) => {
  // A13: renaming is writing too; switching away is not the reader done.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await seedNode(page, projectIdOf(projectUrl), first, 'rename-me', 'image');
  const node = visibleSpace(page).locator('.react-flow__node[data-id="rename-me"]');
  await expect(node).toBeVisible({ timeout: 20_000 });
  await node.getByTestId('node-header-name').dblclick();
  const input = node.getByTestId('node-header-input');
  await expect(input).toBeFocused();
  await page.keyboard.type('Hero sh');

  await showSpace(page, second);
  await showSpace(page, first);

  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Hero sh');
  await page.keyboard.type('ot');
  await page.keyboard.press('Enter');
  await expect(node.getByTestId('node-header-name')).toHaveText('Hero shot');
});

test('a reply not sent yet and the comment panel are where they were after a switch', async ({
  page,
}) => {
  // A1 and A2: the panel's cards stand where they stood, and the words in a
  // reply box are still there.
  const { canvas, doc } = await canvasAndDocument(page);
  await page.keyboard.type('a line worth answering');
  await selectFirstParagraph(page);
  await page.getByTestId('doc-bubble-tool-comment').click();
  await page.getByTestId('doc-comment-draft-input').fill('worth answering');
  await page.getByTestId('doc-comment-draft-save').click();
  await expect(page.getByTestId('doc-comment-draft-card')).toHaveCount(0);
  await page.getByTestId('doc-comment-card').click();
  const reply = page.getByTestId('doc-comment-reply-input');
  await expect(reply).toBeVisible();
  await reply.click();
  await page.keyboard.type('half a reply');
  const card = page.getByTestId('doc-comment-card');
  const before = await card.boundingBox();

  await showSpace(page, canvas);
  await showSpace(page, doc);

  await expect(reply).toHaveValue('half a reply');
  expect(await card.boundingBox()).toEqual(before);
  // A19: the caret is back in the reply, so the next keys go on writing it.
  await expect(reply).toBeFocused();
  await page.keyboard.type('!');
  await expect(reply).toHaveValue('half a reply!');
});

test('a hidden document does not take a drop made outside the shown one', async ({ page }) => {
  // A5: the hidden document's editor is still in the page; BlockNote must not
  // pick it as the place a drag lands, or a drag let go over the tab strip is
  // taken (and a dragged selection deleted from the shown document).
  await openFreshProject(page);
  const [a, b] = await addSpaces(page, 2, 'document');
  await showSpace(page, a!);
  await showSpace(page, b!);
  const editor = page.locator(DOCUMENT_EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('beta');
  await page.evaluate(() => {
    const w = window as unknown as { dropTaken?: boolean; dragEnded?: boolean };
    w.dropTaken = false;
    document.addEventListener('drop', (e) => {
      queueMicrotask(() => {
        if (e.defaultPrevented) w.dropTaken = true;
      });
    });
    document.addEventListener('dragend', () => {
      w.dragEnded = true;
    });
  });
  const row = await editor.locator('.bn-block-content').nth(1).boundingBox();
  if (row === null) throw new Error('no row');
  await page.mouse.move(row.x + 40, row.y + 11);
  const handle = await page.getByTestId('doc-block-handle').boundingBox();
  if (handle === null) throw new Error('no handle');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 8, handle.y + 12, { steps: 4 });
  await page.mouse.move(60, 60, { steps: 12 });
  await page.mouse.up();

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { dragEnded?: boolean }).dragEnded))
    .toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as { dropTaken: boolean }).dropTaken),
  ).toBe(false);
  await expect(editor.locator('.bn-block-content')).toHaveCount(2);
});

test('words left selected in a hidden document do not take the canvas copy', async ({
  page,
  context,
}) => {
  // A3, A5: a selection the reader can no longer see is not theirs; Cmd+C on
  // the shown canvas copies its selected node.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const projectUrl = await openFreshProject(page);
  const [doc] = await addSpaces(page, 1, 'document');
  const [canvas] = (await stripIds(page)) as [string, string];
  await showSpace(page, canvas);
  await seedNode(page, projectIdOf(projectUrl), canvas, 'copied-node', 'image', { x: 500, y: 0 });
  const node = visibleSpace(page).locator('.react-flow__node[data-id="copied-node"]');
  await node.click();
  await expect(node).toHaveClass(/selected/);

  await showSpace(page, doc!);
  const editor = page.locator(DOCUMENT_EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type('words in the document');
  await page.keyboard.press('Shift+Home');
  await showSpace(page, canvas);

  const nodes = visibleSpace(page).locator('.react-flow__node');
  const before = await nodes.count();
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(nodes).toHaveCount(before + 1);
});

test('a node copied on one canvas lands where another canvas is looking', async ({
  page,
  context,
}) => {
  // A20: the old place of the copy is in view on the second canvas too, and
  // the copy still lands in the middle of that canvas, not beside a source
  // that is not on it — stepped aside when a node already sits there.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await seedNode(page, projectIdOf(projectUrl), first, 'copied-across', 'image', { x: 500, y: 0 });
  const source = visibleSpace(page).locator('.react-flow__node[data-id="copied-across"]');
  await source.click();
  await page.keyboard.press('ControlOrMeta+c');

  // The second canvas has content of its own, framed when it first shows: an
  // empty canvas frames its first content (A3), which would move the camera
  // onto the pasted node wherever it landed. Framed at zoom 1 around (0, 0),
  // its view takes in (500, 0) too.
  await showSpace(page, second);
  await seedNode(page, projectIdOf(projectUrl), second, 'already-here', 'image');
  const nodes = visibleSpace(page).locator('.react-flow__node');
  await expect(nodes).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(nodes).toHaveCount(2);
  const pastedNode = visibleSpace(page).locator(
    '.react-flow__node:not([data-id="already-here"])',
  );
  await expect(pastedNode).toHaveClass(/react-flow__node-image/);

  // The middle of the view is where the second canvas framed its own node,
  // so the copy steps one paste offset down and right of it and both show.
  const existing = await visibleSpace(page)
    .locator('.react-flow__node[data-id="already-here"]')
    .boundingBox();
  const pasted = await pastedNode.boundingBox();
  if (existing === null || pasted === null) throw new Error('a node has no box');
  expect(Math.abs(pasted.x - existing.x - 24)).toBeLessThan(2);
  expect(Math.abs(pasted.y - existing.y - 24)).toBeLessThan(2);
});

test('pasting again on the same canvas steps each copy past the last one', async ({
  page,
  context,
}) => {
  // A20: every paste steps past a node already on its spot — a copied node
  // pasted twice, and words pasted twice, all show.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await seedNode(page, projectIdOf(projectUrl), first, 'pasted-again', 'image', { x: 200, y: 100 });
  const source = visibleSpace(page).locator('.react-flow__node[data-id="pasted-again"]');
  await source.click();
  await page.keyboard.press('ControlOrMeta+c');
  const nodes = visibleSpace(page).locator('.react-flow__node');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(nodes).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(nodes).toHaveCount(3);

  await page.evaluate(() => navigator.clipboard.writeText('words pasted twice'));
  await visibleSpace(page).locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+v');
  await expect(nodes).toHaveCount(4);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(nodes).toHaveCount(5);

  const corners = await nodes.evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).style.transform),
  );
  expect(new Set(corners).size).toBe(5);
});

test('words selected in a read-only document are still selected after a switch', async ({
  page,
}) => {
  // A1: a viewer's selection lives only in the page, with no editor focus to
  // put it back, so the switch must leave it where it was.
  const { canvas, doc } = await canvasAndDocument(page);
  await page.keyboard.type('words a viewer selects');
  await page.locator(DOCUMENT_EDITOR).evaluate((el) =>
    (el as HTMLElement & { editor: { setEditable: (editable: boolean) => void } }).editor.setEditable(false),
  );
  const row = await page.locator(DOCUMENT_EDITOR).locator('p').first().boundingBox();
  if (row === null) throw new Error('the first row has no box');
  await page.mouse.move(row.x + 2, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + row.width - 2, row.y + row.height / 2, { steps: 8 });
  await page.mouse.up();
  const selected = () => page.evaluate(() => document.getSelection()?.toString());
  expect(await selected()).toBe('words a viewer selects');

  await showSpace(page, canvas);
  await showSpace(page, doc);

  expect(await selected()).toBe('words a viewer selects');
});

test('the caret goes back into a reply without moving what the reader scrolled to', async ({
  page,
}) => {
  // A1 and A19: with the reply scrolled out of view, coming back keeps the
  // body where it was and still puts the caret in the reply.
  const { canvas, doc } = await canvasAndDocument(page);
  await page.keyboard.type('a line worth answering');
  for (let i = 0; i < 60; i += 1) await page.keyboard.press('Enter');
  await page.keyboard.type('the end');
  await selectFirstParagraph(page);
  await page.getByTestId('doc-bubble-tool-comment').click();
  await page.getByTestId('doc-comment-draft-input').fill('worth answering');
  await page.getByTestId('doc-comment-draft-save').click();
  await page.getByTestId('doc-comment-card').click();
  const reply = page.getByTestId('doc-comment-reply-input');
  await reply.click();
  await page.keyboard.type('half a reply');

  const scroller = visibleSpace(page)
    .getByTestId('document-editor-content')
    .locator('xpath=ancestor::*[@data-radix-scroll-area-viewport][1]');
  const box = await scroller.boundingBox();
  if (box === null) throw new Error('the scroller has no box');
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
  await page.mouse.wheel(0, 900);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
  const scrolled = await scroller.evaluate((el) => el.scrollTop);
  await expect(reply).toBeFocused();

  await showSpace(page, canvas);
  await showSpace(page, doc);

  await expect(reply).toBeFocused();
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrolled);
});

test('the button on a table cell is on that cell after a switch', async ({ page }) => {
  // A1: the cell button comes back on the cell the caret is in.
  const { canvas, doc } = await canvasAndDocument(page);
  await page.keyboard.type('above');
  const row = await page
    .locator(`${DOCUMENT_EDITOR} > .bn-block-group > .bn-block-outer > .bn-block > .bn-block-content`)
    .first()
    .boundingBox();
  if (row === null) throw new Error('the first row has no box');
  await page.mouse.move(row.x + 40, row.y + Math.min(row.height / 2, 12), { steps: 3 });
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-3').click();
  await page.keyboard.type('c1');
  const button = page.getByTestId('doc-table-cell-button');
  await expect(button).toBeVisible();
  const before = await button.boundingBox();

  await showSpace(page, canvas);
  await showSpace(page, doc);

  await expect(button).toBeVisible();
  expect(await button.boundingBox()).toEqual(before);
});

test('a generation answered while its Space was hidden leaves the panel ready', async ({
  page,
}) => {
  // A7: the submit was on its way when the reader switched away; coming back,
  // the panel is not stuck submitting.
  const projectUrl = await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
  await showSpace(page, first);
  await seedPicture(page, projectIdOf(projectUrl), first, 'gen-host', { x: 0, y: 0 });
  await openGenerate(page, 'gen-host');
  const prompt = visibleSpace(page).getByTestId('generate-prompt-editor').locator('.ProseMirror');
  await prompt.click();
  await page.keyboard.type('a quiet harbour at dawn');
  // The answer comes back after the switch, and is a refusal: nothing is spent.
  await page.route('**/canvas/tasks', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.fulfill({ status: 500, json: { success: false, error: 'held' } });
  });
  await visibleSpace(page).getByTestId('generate-execute').click();
  await expect(visibleSpace(page).getByTestId('generate-execute-pending')).toBeVisible();

  await showSpace(page, second);
  await page.waitForTimeout(4_000);
  await showSpace(page, first);

  await expect(visibleSpace(page).getByTestId('generate-execute-pending')).toHaveCount(0);
  await expect(visibleSpace(page).getByTestId('generate-execute')).toBeEnabled();
});

test.describe('on a Mac, where Cmd is the canvas library\'s add-to-selection key', () => {
  // The library reads the platform from the user agent, and the smoke device
  // reports Windows, where the key is Control and a Control press on macOS is
  // a right-click that resets the key state on its own.
  test.use({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  });

  test('a key held while switching away is let go when the canvas is shown again', async ({
    page,
  }) => {
    // The library keeps "this key is down" while its Space is hidden and never
    // hears the key come up there; shown again, a click selects one node as
    // before.
    const projectUrl = await openFreshProject(page);
    await addSpaces(page, 1);
    const [first, second] = (await stripIds(page)) as [string, string];
    await showSpace(page, first);
    await seedNode(page, projectIdOf(projectUrl), first, 'held-a', 'image', { x: 0, y: 0 });
    await seedNode(page, projectIdOf(projectUrl), first, 'held-b', 'image', { x: 400, y: 0 });
    const a = visibleSpace(page).locator('.react-flow__node[data-id="held-a"]');
    const b = visibleSpace(page).locator('.react-flow__node[data-id="held-b"]');
    await expect(b).toBeVisible({ timeout: 20_000 });

    await page.keyboard.down('Meta');
    await page.locator(`[data-testid="space-tab-${second}"]`).click();
    await expect.poll(() => activeId(page)).toBe(second);
    await page.keyboard.up('Meta');
    await showSpace(page, first);

    await a.click();
    await b.click();

    await expect(b).toHaveClass(/selected/);
    await expect(a).not.toHaveClass(/selected/);
  });
});
