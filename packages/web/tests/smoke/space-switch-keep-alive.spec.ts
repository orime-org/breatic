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
import { expect, test, type Page } from 'playwright/test';

import { CANVAS_SPACE, TEXT_BODY, liveModuleUrl } from '../helpers/live-module';
import { DOCUMENT_EDITOR, visibleSpace } from '../helpers/space';
import {
  activeId,
  addSpaces,
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
  const [first] = (await stripIds(page)) as [string, string];
  await showSpace(page, doc!);
  const editor = page.locator(DOCUMENT_EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('new-space-button')).toBeFocused();
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
  const [first] = (await stripIds(page)) as [string, string];
  await showSpace(page, doc!);
  const editor = page.locator(DOCUMENT_EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('new-space-button')).toBeFocused();
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
