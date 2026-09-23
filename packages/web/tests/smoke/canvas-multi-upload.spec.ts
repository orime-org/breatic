// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the left menu's upload tool does with several files at once.
 *
 * The picker behind that tool carries `multiple`, so one press can hand over a
 * batch. This reads where the batch lands, which is the thing a reader sees
 * first and the thing no unit test can answer: the position comes from
 * `dropPositionAt`, but whether the reader ends up looking at separate nodes
 * depends on the canvas that renders them.
 *
 * Needs a running dev stack (`pnpm dev`) and the smoke account setup.
 */
import { test, expect, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

test.use({ storageState: STATE_FILE.A });

/** A 320x240 solid PNG, inline so it decodes with no network. */
const SOLID_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADwCAIAAAD+Tyo8AAACD0lEQVR42u3TQQkAAAgEwUtnCJMY3w7+hIFJsLCpHuCpSAAGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGAysAhgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMBhYBTAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMHC3pCIzOUa0Hy8AAAAASUVORK5CYII=';

/** How many files one press hands over. */
const BATCH = 5;

/** What one picked file looks like to the input. */
function pngFile(index: number): {
  name: string;
  mimeType: string;
  buffer: Buffer;
} {
  return {
    name: `batch-${index}.png`,
    mimeType: 'image/png',
    buffer: Buffer.from(SOLID_PNG, 'base64'),
  };
}

/**
 * Where every canvas node sits, read off the rendered transform.
 * @param page - The page with the Space open.
 * @returns One entry per node, in DOM order.
 */
async function nodeBoxes(
  page: Page,
): Promise<{ id: string; x: number; y: number; parent: string | null }[]> {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.react-flow__node')];
    return nodes.map((el) => {
      const box = el.getBoundingClientRect();
      return {
        id: (el as HTMLElement).dataset.id ?? '',
        x: Math.round(box.left),
        y: Math.round(box.top),
        parent: el.getAttribute('data-parent-id'),
      };
    });
  });
}

test('one press of the upload tool with several files', async ({ page }) => {
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'canvas', `multi-upload ${Date.now()}`);

  try {
    // Two inputs carry this id and only one takes a batch: the canvas has its
    // own single-file picker. The left menu's tool clicks the multiple one.
    await page
      .locator('input[data-testid="canvas-upload-input"][multiple]')
      .setInputFiles(Array.from({ length: BATCH }, (_, i) => pngFile(i)));

    // The nodes appear as the drop is processed, before any upload finishes.
    await expect
      .poll(async () => (await nodeBoxes(page)).length, { timeout: 20_000 })
      .toBe(BATCH);

    const boxes = await nodeBoxes(page);
    const distinct = new Set(boxes.map((b) => `${b.x},${b.y}`));
    const parents = new Set(boxes.map((b) => b.parent));

    // Reported as the observed state, not asserted: this run is here to say
    // what the batch does today.
    console.log('BATCH LAYOUT', JSON.stringify({ boxes, distinct: distinct.size, parents: [...parents] }, null, 2));

    expect(boxes.length).toBe(BATCH);
  } finally {
    await deleteSpace(page, spaceId);
  }
});
