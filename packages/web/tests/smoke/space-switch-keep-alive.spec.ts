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
import { DOCUMENT_EDITOR, VISIBLE_SPACE, visibleSpace } from '../helpers/space';
import {
  activeId,
  addSpaces,
  camera,
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
