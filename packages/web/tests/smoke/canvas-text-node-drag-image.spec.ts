// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The image that follows the pointer while words selected in a canvas text
 * node are dragged: the same full-strength image the prompt box, the Agent
 * input and the document body hand the browser (inner#1515).
 */

import { randomUUID } from 'node:crypto';

import { expect } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { addTextNode } from '../helpers/request-bodies';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

test.use({ viewport: { width: 1500, height: 900 } });

const madeSpaces: string[] = [];

test.afterEach(async ({ page }) => {
  await page.mouse.up();
  while (madeSpaces.length > 0) await deleteSpace(page, madeSpaces.pop() as string);
});

test('dragging words selected in a text node hands the browser the shared drag image, at full strength', async ({ page }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'canvas', `text-drag-${Date.now()}`);
  madeSpaces.push(spaceId);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const nodeId = randomUUID();
  await addTextNode(page, { projectId, spaceId, nodeId }, 'alpha beta gamma');
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await node.dblclick();
  const body = node.locator('[data-testid="text-node-body"][contenteditable="true"]');
  await expect(body).toBeFocused();

  // Each element handed to setDragImage, read as it is handed over.
  await page.evaluate(() => {
    const seen: Array<{ classes: string; position: string; text: string; opacity: string[]; root: Element }> = [];
    (window as unknown as { __dragImages: typeof seen }).__dragImages = seen;
    const original = DataTransfer.prototype.setDragImage;
    DataTransfer.prototype.setDragImage = function (el: Element, x: number, y: number) {
      seen.push({
        classes: el.className,
        position: getComputedStyle(el).position,
        text: el.textContent ?? '',
        opacity: [el, ...el.querySelectorAll('*')].map((child) => getComputedStyle(child).opacity).filter((o) => o !== '1'),
        root: el,
      });
      original.call(this, el, x, y);
    };
  });
  const word = await body.evaluate((element) => {
    const text = element.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    const rect = range.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, end: element.getBoundingClientRect().right - 4 };
  });
  await page.mouse.dblclick(word.x, word.y);
  // A press within 500 ms of the double click would count as its third click
  // (prosemirror-view `handlers.mousedown`) and select the whole line.
  await page.waitForTimeout(600);
  await page.mouse.move(word.x, word.y);
  await page.mouse.down();
  // Chromium on macOS starts a drag of selected words only after a 150 ms hold
  // (`kTextDragDelay`); a quicker move extends the selection instead.
  await page.waitForTimeout(300);
  await page.mouse.move(word.end, word.y, { steps: 8 });
  await page.mouse.up();

  const images = await page.evaluate(() =>
    (window as unknown as { __dragImages: Array<{ classes: string; position: string; text: string; opacity: string[]; root: Element }> })
      .__dragImages.map(({ root, ...seen }) => ({ ...seen, onPage: root.isConnected })),
  );
  expect(images).toEqual([{ classes: 'drag-image', position: 'fixed', text: 'beta', opacity: [], onPage: false }]);
});
