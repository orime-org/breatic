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
import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

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
    storageState: STATE_FILE.A,
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
  const composer = page.getByTestId('chat-composer-textarea');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  // Pan away from where the space opened. A reader asking for this has been
  // working somewhere, and what lands has to be in front of THEM -- framing
  // the group against a canvas that has not been moved proves nothing.
  const pane = page.locator('.react-flow__pane');
  const paneBox = await pane.boundingBox();
  await page.mouse.move(
    (paneBox?.x ?? 0) + (paneBox?.width ?? 0) / 2,
    (paneBox?.y ?? 0) + (paneBox?.height ?? 0) / 2,
  );
  await page.mouse.wheel(900, 700);

  await page.getByTestId('new-conversation').click();
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

  const before = await page.locator('.react-flow__node').count();
  await card.getByTestId('proposal-use').click();

  // Two nodes and the wire between them. Counted rather than matched by id:
  // the ids are minted by the canvas as it places them.
  await expect(page.locator('.react-flow__node')).toHaveCount(before + 2, {
    timeout: 20_000,
  });
  await expect(page.locator('.react-flow__edge')).toHaveCount(1, { timeout: 20_000 });

  // Every node of the group is on screen. The empty ones are what the reader
  // is being asked to fill, so a group placed where they have to go looking
  // for it is not the one press this feature promises.
  const view = await pane.boundingBox();
  const nodes = await page.locator('.react-flow__node').all();
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
  // with its panel open and the prompt already in the box. The bracket is
  // what says the rest is theirs to do.
  const selected = page.locator('.react-flow__node.selected');
  await expect(selected).toHaveCount(1, { timeout: 20_000 });
  const prompt = page.getByTestId('generate-prompt-editor');
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  const written = await prompt.innerText();
  expect(written.length, `the prompt box is empty. Read: "${written}"`).toBeGreaterThan(0);
  expect(
    written,
    `nothing in the prompt marks what is left for the reader. Read: "${written}"`,
  ).toContain('[');

  // A6: one press put the whole group down, so one undo takes all of it back.
  // The click moves focus off the prompt editor first -- it keeps a history of
  // its own and would otherwise answer the keystroke itself, leaving the group
  // on the canvas and this reading of it meaningless.
  await pane.click({ position: { x: 24, y: 24 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.react-flow__node')).toHaveCount(before, {
    timeout: 20_000,
  });
  await expect(page.locator('.react-flow__edge')).toHaveCount(0, {
    timeout: 20_000,
  });
});
