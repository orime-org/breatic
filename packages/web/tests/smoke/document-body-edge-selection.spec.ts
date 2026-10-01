// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A selection that reaches past the first or last block (task #124, A6).
 *
 * What jsdom cannot show: a real drag below the last block and above the
 * first, the browser reading its own range back, the widget under the last
 * block letting a press through, the body scrolling under a drag that rests
 * at the bottom edge, and a second tab editing while the selection stands.
 *
 * Every press waits for the pointer to settle first: the block handle shows on
 * hover, and a press in the same instant as the move can land on it.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

let page: Page;

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
});

const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
});

const EDITOR = '[data-testid="document-space"] .ProseMirror';

/** How long the pointer rests before a press. */
const SETTLE_MS = 400;

/** What the editor holds and what the page paints. */
interface Reading {
  kind: string;
  anchor: number;
  head: number;
  size: number;
  text: string;
  rows: string[];
  painted: string[];
  domRects: number;
}

/**
 * Open a freshly made Document Space with the caret in the body.
 * @param p - The page.
 * @returns The new Space's id.
 */
async function openFreshDocument(p: Page): Promise<string> {
  await openSmokeProject(p);
  const id = await createSpace(p, 'document', `edge-${Date.now()}`);
  createdSpaceIds.push(id);
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return id;
}

/** A block to put in the body. */
interface BlockSpec {
  type: 'paragraph' | 'divider' | 'bulletListItem' | 'heading' | 'codeBlock';
  content?: string;
  props?: Record<string, unknown>;
  children?: BlockSpec[];
}

/**
 * Replace the body with these blocks, written straight through the schema.
 * @param p - The page.
 * @param blocks - The blocks.
 */
async function setBlocks(p: Page, blocks: BlockSpec[]): Promise<void> {
  await p.evaluate(
    ([selector, list]) => {
      type PMNode = unknown;
      const el = document.querySelector(selector) as unknown as {
        editor: {
          state: {
            schema: { nodes: Record<string, { create: (attrs: Record<string, unknown> | null, content?: PMNode | PMNode[]) => PMNode }>; text: (t: string) => PMNode };
            doc: { content: { size: number } };
            tr: { replaceWith: (from: number, to: number, nodes: PMNode[]) => unknown };
          };
          view: { dispatch: (tr: unknown) => void };
        };
      };
      const { schema } = el.editor.state;
      const make = (block: BlockSpec): PMNode => {
        const words = block.content ? schema.text(block.content) : undefined;
        const head = schema.nodes[block.type]!.create(block.props ?? null, words);
        const kids = block.children?.length
          ? [head, schema.nodes.blockGroup!.create(null, block.children.map(make))]
          : [head];
        return schema.nodes.blockContainer!.create(null, kids);
      };
      const { state } = el.editor;
      el.editor.view.dispatch(state.tr.replaceWith(1, state.doc.content.size - 1, list.map(make)));
    },
    [EDITOR, blocks] as const,
  );
  await p.waitForTimeout(300);
}

/**
 * Read the selection and the page.
 * @param p - The page.
 * @returns The reading.
 */
async function read(p: Page): Promise<Reading> {
  return p.evaluate((selector) => {
    const el = document.querySelector(selector) as HTMLElement & {
      editor: { state: { selection: { constructor: { name: string }; anchor: number; head: number; from: number; to: number }; doc: { content: { size: number }; textBetween: (a: number, b: number, s: string, l: string) => string } } };
    };
    const { selection, doc } = el.editor.state;
    const dom = window.getSelection();
    const rows = [...el.querySelectorAll('.bn-block-content')];
    return {
      kind: selection.constructor.name,
      anchor: selection.anchor,
      head: selection.head,
      size: doc.content.size,
      text: doc.textBetween(selection.from, selection.to, '|', '#'),
      // Read off the document: a collaborator's caret label sits inside the
      // paragraph's DOM and would show up in its text.
      rows: (() => {
        const out: string[] = [];
        (doc as unknown as { descendants: (f: (n: { type: { name: string }; textContent: string; isTextblock: boolean; isAtom: boolean; attrs: Record<string, unknown> }) => boolean) => void }).descendants((n) => {
          if (n.type.name === 'blockContainer' || n.type.name === 'blockGroup') return true;
          out.push(`${n.type.name}:${n.textContent}`);
          return false;
        });
        return out;
      })(),
      painted: rows.filter((r) => r.classList.contains('doc-in-selection')).map((r) => r.getAttribute('data-content-type') ?? '?'),
      domRects: dom !== null && dom.rangeCount > 0 ? dom.getRangeAt(0).getClientRects().length : 0,
    };
  }, EDITOR);
}

/**
 * The box of a row, by index.
 * @param p - The page.
 * @param index - Which row; negative counts from the end.
 * @returns Its box.
 * @throws {Error} When the row has no box.
 */
async function rowBox(p: Page, index: number): Promise<{ x: number; y: number; width: number; height: number }> {
  const all = p.locator(`${EDITOR} > .bn-block-group > .bn-block-outer`);
  const count = await all.count();
  const box = await all.nth(index < 0 ? count + index : index).boundingBox();
  if (box === null) throw new Error(`row ${index} has no box`);
  return box;
}

/**
 * The box of a word in the body.
 * @param p - The page.
 * @param word - The word.
 * @returns Its box.
 * @throws {Error} When the word has no box.
 */
async function wordBox(p: Page, word: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await p.locator(EDITOR).getByText(word, { exact: true }).boundingBox();
  if (box === null) throw new Error(`${word} has no box`);
  return box;
}

/**
 * Drag from one point to another, resting before the press.
 * @param p - The page.
 * @param from - Where to press.
 * @param from.x - Across.
 * @param from.y - Down.
 * @param path - The points to pass through, the last one where to let go.
 */
async function drag(p: Page, from: { x: number; y: number }, path: { x: number; y: number }[]): Promise<void> {
  await p.mouse.move(from.x, from.y);
  await p.waitForTimeout(SETTLE_MS);
  await p.mouse.down();
  for (const point of path) await p.mouse.move(point.x, point.y, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(200);
}

/**
 * Click with Shift held, resting before the press.
 * @param p - The page.
 * @param x - Across.
 * @param y - Down.
 */
async function shiftClick(p: Page, x: number, y: number): Promise<void> {
  await p.mouse.move(x, y);
  await p.waitForTimeout(SETTLE_MS);
  await p.keyboard.down('Shift');
  await p.mouse.down();
  await p.mouse.up();
  await p.keyboard.up('Shift');
  await p.waitForTimeout(200);
}

const WITH_DIVIDER: BlockSpec[] = [{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'divider' }];
const WITH_EMPTY: BlockSpec[] = [{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'paragraph' }];
const WITH_NESTED_EMPTY: BlockSpec[] = [
  { type: 'paragraph', content: 'Above' },
  { type: 'bulletListItem', content: 'Middle', children: [{ type: 'paragraph' }] },
];

for (const [name, blocks] of [
  ['a divider', WITH_DIVIDER],
  ['an empty line', WITH_EMPTY],
  ['an empty line nested under the last row', WITH_NESTED_EMPTY],
] as const) {
  test(`dragging below the last block takes in ${name} (A6)`, async () => {
    await openFreshDocument(page);
    await setBlocks(page, blocks);
    const word = await wordBox(page, 'Above');
    const last = await rowBox(page, -1);

    await drag(page, { x: word.x + 2, y: word.y + word.height / 2 }, [{ x: word.x + 40, y: last.y + last.height + 120 }]);

    const reading = await read(page);
    expect(reading.kind).toBe('BodyEdgeSelectionClass');
    expect(reading.head).toBe(reading.size - 2);
    expect(reading.text.startsWith('Above|Middle')).toBe(true);
    if (name === 'a divider') expect(reading.painted).toEqual(['divider']);
    // The empty line is drawn by the browser: the range crosses its line.
    else expect(reading.domRects).toBeGreaterThanOrEqual(3);
  });
}

test('dragging up from below the last block anchors on the end (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_DIVIDER);
  const word = await wordBox(page, 'Middle');
  const last = await rowBox(page, -1);

  await drag(page, { x: word.x + 40, y: last.y + last.height + 60 }, [{ x: word.x + 2, y: word.y + word.height / 2 }]);

  const reading = await read(page);
  expect(reading.kind).toBe('BodyEdgeSelectionClass');
  expect(reading.anchor).toBe(reading.size - 2);
  expect(reading.painted).toEqual(['divider']);
});

test('a drag that rests on the last line and then goes lower takes it in (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_EMPTY);
  const word = await wordBox(page, 'Above');
  const last = await rowBox(page, -1);

  await drag(page, { x: word.x + 2, y: word.y + word.height / 2 }, [
    { x: word.x + 10, y: last.y + last.height / 2 },
    { x: word.x + 10, y: last.y + last.height + 80 },
  ]);

  expect((await read(page)).head).toBe((await read(page)).size - 2);
});

/**
 * Whether the empty last line wears the selected-empty-line mark.
 * @param p - The page.
 * @returns True when it does.
 */
async function lastLineMarked(p: Page): Promise<boolean> {
  return p.evaluate((selector) => {
    const lines = document.querySelectorAll(`${selector} .bn-block-content`);
    return lines[lines.length - 1]?.classList.contains('doc-empty-line-in-selection') ?? false;
  }, EDITOR);
}

test('an empty last line shows as selected while the drag is still on, both ways (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_EMPTY);
  const word = await wordBox(page, 'Above');
  const last = await rowBox(page, -1);
  const atWord = { x: word.x + 2, y: word.y + word.height / 2 };

  for (const [from, to] of [
    [atWord, { x: word.x + 30, y: last.y + last.height / 2 }],
    [atWord, { x: word.x + 30, y: last.y + last.height + 60 }],
    [{ x: word.x + 30, y: last.y + last.height / 2 }, atWord],
    [{ x: word.x + 30, y: last.y + last.height + 60 }, atWord],
  ] as const) {
    await page.mouse.move(from.x, from.y);
    await page.waitForTimeout(SETTLE_MS);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await expect.poll(() => lastLineMarked(page)).toBe(true);
    await page.mouse.up();
    await expect.poll(() => lastLineMarked(page)).toBe(true);
    await page.mouse.click(word.x + 20, word.y + word.height / 2);
  }
});

test('a drag onto an empty last line, and one starting on it, take the line in (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_EMPTY);
  const word = await wordBox(page, 'Above');
  const last = await rowBox(page, -1);
  const onLast = { x: word.x + 30, y: last.y + last.height / 2 };

  await drag(page, { x: word.x + 2, y: word.y + word.height / 2 }, [onLast]);
  const down = await read(page);
  expect([down.kind, down.head === down.size - 2]).toEqual(['BodyEdgeSelectionClass', true]);

  await drag(page, onLast, [{ x: word.x + 2, y: word.y + word.height / 2 }]);
  const up = await read(page);
  expect([up.kind, up.anchor === up.size - 2]).toEqual(['BodyEdgeSelectionClass', true]);
  expect(up.domRects).toBeGreaterThanOrEqual(3);
});

test('a drag that goes below and comes back is a text selection again (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_DIVIDER);
  const word = await wordBox(page, 'Above');
  const last = await rowBox(page, -1);

  await drag(page, { x: word.x + 2, y: word.y + word.height / 2 }, [
    { x: word.x + 40, y: last.y + last.height + 120 },
    { x: word.x + 25, y: word.y + word.height / 2 },
  ]);

  const reading = await read(page);
  expect(reading.kind).toBe('_TextSelection');
  expect(reading.painted).toEqual([]);
});

test('Shift+click below the last block and Shift+Down both reach the end (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_DIVIDER);
  const word = await wordBox(page, 'Middle');
  const last = await rowBox(page, -1);

  await page.mouse.click(word.x + 2, word.y + word.height / 2);
  await shiftClick(page, word.x + 40, last.y + last.height + 60);
  const clicked = await read(page);
  expect([clicked.kind, clicked.head === clicked.size - 2]).toEqual(['BodyEdgeSelectionClass', true]);

  await page.mouse.click(word.x + 2, word.y + word.height / 2);
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  const keyed = await read(page);
  expect([keyed.kind, keyed.head === keyed.size - 2]).toEqual(['BodyEdgeSelectionClass', true]);
  expect(keyed.painted).toEqual(['divider']);
});

test('after a drag up from below, Shift+click on the text keeps the end anchored (A6)', async () => {
  await openFreshDocument(page);
  // A line between: the bubble bar stands over the line above the head.
  await setBlocks(page, [{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Gap' }, ...WITH_DIVIDER.slice(1)]);
  const word = await wordBox(page, 'Middle');
  const above = await wordBox(page, 'Above');
  const last = await rowBox(page, -1);
  await drag(page, { x: word.x + 40, y: last.y + last.height + 60 }, [{ x: word.x + 20, y: word.y + word.height / 2 }]);

  await shiftClick(page, above.x + 2, above.y + above.height / 2);

  const reading = await read(page);
  expect(reading.anchor).toBe(reading.size - 2);
  expect(reading.text.startsWith('Above|Gap|Middle')).toBe(true);
});

test('after a drag up from below, Shift+Up moves the head a line and keeps the end anchored (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_DIVIDER);
  const word = await wordBox(page, 'Middle');
  const last = await rowBox(page, -1);
  await drag(page, { x: word.x + 40, y: last.y + last.height + 60 }, [{ x: word.x + 20, y: word.y + word.height / 2 }]);
  const before = await read(page);

  await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(200);

  const reading = await read(page);
  expect(reading.anchor).toBe(reading.size - 2);
  expect(reading.head).toBeLessThan(before.head);
  expect(reading.text.startsWith('bove|Middle') || reading.text.startsWith('Above|Middle') || reading.text.includes('|Middle|#')).toBe(true);
});

test('a leading divider is reached by dragging above the first block and by Shift+Up (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'divider' }, { type: 'paragraph', content: 'Middle' }, { type: 'paragraph', content: 'Below' }]);
  const word = await wordBox(page, 'Below');
  const first = await rowBox(page, 0);

  await drag(page, { x: word.x + 20, y: word.y + word.height / 2 }, [{ x: word.x + 20, y: first.y - 30 }]);
  const dragged = await read(page);
  expect([dragged.kind, dragged.head]).toEqual(['BodyEdgeSelectionClass', 2]);
  expect(dragged.painted).toEqual(['divider']);

  const middle = await wordBox(page, 'Middle');
  await page.mouse.click(middle.x + 20, middle.y + middle.height / 2);
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  const keyed = await read(page);
  expect([keyed.kind, keyed.head]).toEqual(['BodyEdgeSelectionClass', 2]);
});

test('a drag up from above the first block anchors on the start, and Shift+click keeps it (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'divider' }, { type: 'paragraph', content: 'Middle' }, { type: 'paragraph', content: 'Below' }]);
  const middle = await wordBox(page, 'Middle');
  const below = await wordBox(page, 'Below');
  const first = await rowBox(page, 0);

  // Inside the surface's own padding above the first block: a press outside
  // the editable surface starts no editor selection.
  await drag(page, { x: middle.x + 20, y: first.y - 8 }, [{ x: middle.x + 20, y: middle.y + middle.height / 2 }]);
  expect((await read(page)).anchor).toBe(2);

  await shiftClick(page, below.x + 20, below.y + below.height / 2);
  const reading = await read(page);
  expect(reading.anchor).toBe(2);
  expect(reading.painted).toEqual(['divider']);
});

/**
 * Whether each line wears the selected-empty-line mark.
 * @param p - The page.
 * @returns One flag per line, in order.
 */
async function linesMarked(p: Page): Promise<boolean[]> {
  return p.evaluate((selector) => [...document.querySelectorAll(`${selector} .bn-block-content`)].map(
    (line) => line.classList.contains('doc-empty-line-in-selection'),
  ), EDITOR);
}

test('a drag from below an empty last line to above an empty first line marks both while it is on (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph' }, { type: 'paragraph', content: 'Middle' }, { type: 'paragraph' }]);
  const word = await wordBox(page, 'Middle');
  const first = await rowBox(page, 0);
  const last = await rowBox(page, -1);

  await page.mouse.move(word.x + 30, last.y + last.height + 60);
  await page.waitForTimeout(SETTLE_MS);
  await page.mouse.down();
  await page.mouse.move(word.x + 30, first.y - 6, { steps: 10 });
  await expect.poll(() => linesMarked(page)).toEqual([true, false, true]);
  await page.mouse.up();

  expect((await read(page)).kind).toBe('_AllSelection');
  expect(await linesMarked(page)).toEqual([true, false, true]);
});

test('an empty heading last is reached by a drag below it and marked (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'heading', props: { level: 2 } }]);
  const word = await wordBox(page, 'Above');
  const last = await rowBox(page, -1);

  await drag(page, { x: word.x + 2, y: word.y + word.height / 2 }, [{ x: word.x + 40, y: last.y + last.height + 80 }]);

  const reading = await read(page);
  expect([reading.kind, reading.head === reading.size - 2]).toEqual(['BodyEdgeSelectionClass', true]);
  expect(await linesMarked(page)).toEqual([false, false, true]);
});

test('Left and Right collapse a selection past the last block into its text ends (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_DIVIDER);
  const word = await wordBox(page, 'Middle');
  const last = await rowBox(page, -1);
  const below = { x: word.x + 40, y: last.y + last.height + 80 };

  await drag(page, { x: word.x + 2, y: word.y + word.height / 2 }, [below]);
  const range = await read(page);
  await page.keyboard.press('ArrowLeft');
  const left = await read(page);
  expect([left.anchor, left.head]).toEqual([range.anchor, range.anchor]);

  await drag(page, { x: word.x + 2, y: word.y + word.height / 2 }, [below]);
  await page.keyboard.press('ArrowRight');
  const right = await read(page);
  const middleEnd = range.anchor + 'Middle'.length;
  expect([right.kind, right.anchor, right.head]).toEqual(['_TextSelection', middleEnd, middleEnd]);
});

test('from a drag up from below, Shift+Up reaches a leading divider; after select-all a Shift+click keeps the ends (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'divider' }, { type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'divider' }]);
  const word = await wordBox(page, 'Middle');
  const last = await rowBox(page, -1);
  await drag(page, { x: word.x + 40, y: last.y + last.height + 60 }, [{ x: word.x + 2, y: word.y + word.height / 2 }]);

  for (let i = 0; i < 2; i += 1) await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => (await read(page)).kind).toBe('_AllSelection');
  expect((await read(page)).painted).toEqual(['divider', 'divider']);

  // Select-all comes in two tiers: the line, then the whole document. The
  // click's caret lands asynchronously, and a press before it is dropped.
  await page.mouse.click(word.x + 2, word.y + word.height / 2);
  await expect.poll(async () => (await read(page)).kind).toBe('_TextSelection');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+a');
  await expect.poll(async () => (await read(page)).kind).toBe('_AllSelection');
  await shiftClick(page, word.x + 40, last.y + last.height + 60);
  expect((await read(page)).kind).toBe('_AllSelection');

  await page.keyboard.press('ControlOrMeta+a');
  await shiftClick(page, word.x + 30, word.y + word.height / 2);
  const kept = await read(page);
  expect([kept.kind, kept.anchor]).toEqual(['BodyEdgeSelectionClass', 2]);
});

test('Shift+Right and Shift+Down leave the whole document whole, and Backspace still asks first (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'One' }, { type: 'paragraph', content: 'Two' }]);
  const word = await wordBox(page, 'Two');
  await page.mouse.click(word.x + 2, word.y + word.height / 2);
  await expect.poll(async () => (await read(page)).kind).toBe('_TextSelection');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+a');
  await expect.poll(async () => (await read(page)).kind).toBe('_AllSelection');

  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  expect((await read(page)).kind).toBe('_AllSelection');

  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('document-clear-confirm')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('Shift+Down from the last line of words in a code block ending in a line break stops on the empty line first (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'codeBlock', content: 'abc\ndef\n' }, { type: 'divider' }]);
  const code = await rowBox(page, 0);
  await page.mouse.click(code.x + 200, code.y + code.height / 2);
  // The click's caret lands asynchronously, and a key before it is dropped.
  await page.waitForTimeout(SETTLE_MS);
  // The click past the end of the middle line puts the caret after "def".
  const clicked = await read(page);
  expect(clicked.text).toBe('');

  await page.keyboard.press('Shift+ArrowDown');
  const empty = await read(page);
  expect(empty.kind).toBe('_TextSelection');
  expect(empty.head).toBe(clicked.head + 1);

  await page.keyboard.press('Shift+ArrowDown');
  const edge = await read(page);
  expect([edge.kind, edge.head]).toEqual(['BodyEdgeSelectionClass', edge.size - 2]);
});

test('a Shift+click past the end keeps the end of a range the page keeps (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'paragraph', content: 'Lower' }, { type: 'divider' }]);
  const middle = await wordBox(page, 'Middle');
  const lower = await wordBox(page, 'Lower');
  const last = await rowBox(page, -1);
  await drag(page, { x: lower.x + 30, y: lower.y + lower.height / 2 }, [{ x: middle.x + 20, y: middle.y + middle.height / 2 }]);
  const made = await read(page);
  // The page's own rule (probe38): on macOS the end farther from the click
  // stays, which here is the top of the range; elsewhere the anchor stays.
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));

  await shiftClick(page, middle.x + 20, last.y + last.height + 60);

  const reading = await read(page);
  expect([reading.kind, reading.head]).toEqual(['BodyEdgeSelectionClass', reading.size - 2]);
  expect(reading.anchor).toBe(mac ? Math.min(made.anchor, made.head) : made.anchor);
});

test('a Shift+click on words below a range whose head is on the start reaches from the start (A6)', async () => {
  await openFreshDocument(page);
  // Lines between: the bubble bar stands over the rows under the head.
  await setBlocks(page, [{ type: 'divider' }, { type: 'paragraph', content: 'Middle' }, { type: 'paragraph', content: 'Gap' }, { type: 'paragraph', content: 'Gap' }, { type: 'paragraph', content: 'Tail' }]);
  const middle = await wordBox(page, 'Middle');
  const tail = await wordBox(page, 'Tail');
  const first = await rowBox(page, 0);
  await drag(page, { x: middle.x + 30, y: middle.y + middle.height / 2 }, [{ x: middle.x + 30, y: first.y - 30 }]);
  expect((await read(page)).head).toBe(2);
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));

  await shiftClick(page, tail.x + 10, tail.y + tail.height / 2);

  const reading = await read(page);
  if (mac) {
    expect([reading.kind, reading.anchor]).toEqual(['BodyEdgeSelectionClass', 2]);
    expect(reading.painted).toContain('divider');
    expect(reading.text).toContain('Middle|Gap|Gap|T');
  } else {
    expect(reading.head).toBeGreaterThan(reading.anchor);
  }
});

test('a selection anchored on the start moves its head a line at a time with Shift+Up and Shift+Down (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'divider' }, { type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Middle' }, { type: 'paragraph', content: 'Last' }]);
  const middle = await wordBox(page, 'Middle');
  const first = await rowBox(page, 0);
  await drag(page, { x: middle.x + 20, y: first.y - 8 }, [{ x: middle.x + 2, y: middle.y + middle.height / 2 }]);

  const heads: number[] = [];
  for (const key of ['Shift+ArrowDown', 'Shift+ArrowUp', 'Shift+ArrowUp']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
    const reading = await read(page);
    expect(reading.anchor).toBe(2);
    heads.push(reading.head);
  }
  expect(heads[0]).toBeGreaterThan(heads[1]!);
  expect(heads[1]).toBeGreaterThan(heads[2]!);
});

test('Shift+Down from a clicked divider keeps the divider in the selection (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'Above' }, { type: 'divider' }, { type: 'paragraph', content: 'Below' }]);
  const divider = await rowBox(page, 1);

  await page.mouse.move(divider.x + 100, divider.y + divider.height / 2);
  await page.waitForTimeout(SETTLE_MS);
  await page.mouse.click(divider.x + 100, divider.y + divider.height / 2);
  expect((await read(page)).kind).toBe('_NodeSelection');
  await page.keyboard.press('Shift+ArrowDown');

  const reading = await read(page);
  expect(reading.kind).toBe('_TextSelection');
  expect(reading.painted).toEqual(['divider']);
});

const WRAPPED = `Long ${'word '.repeat(70)}end`;

test('next to an edge block, Shift+Up and Shift+Down move the head of a wrapped line by one line (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'Intro' }, { type: 'paragraph', content: WRAPPED }, { type: 'divider' }]);
  let long = await rowBox(page, 1);
  const last = await rowBox(page, -1);
  await drag(page, { x: long.x + 40, y: last.y + last.height + 60 }, [{ x: long.x + 40, y: long.y + 10 }]);
  const start = await read(page);
  await page.keyboard.press('Shift+ArrowDown');
  const down = await read(page);
  expect([down.kind, down.anchor]).toEqual(['BodyEdgeSelectionClass', start.anchor]);
  expect(down.head).toBeGreaterThan(start.head);
  expect(down.head).toBeLessThan(start.anchor - 'end'.length);

  await setBlocks(page, [{ type: 'divider' }, { type: 'paragraph', content: WRAPPED }, { type: 'paragraph', content: 'Last' }]);
  long = await rowBox(page, 1);
  await drag(page, { x: long.x + 40, y: long.y + 10 }, [{ x: long.x + 200, y: long.y + long.height - 10 }]);
  const inside = await read(page);
  // A range made by the mouse has no direction on macOS, and there Shift+Up
  // moves its start, already on the first line next to the divider; with a
  // direction, Shift+Up moves the head a line.
  const direction = await page.evaluate(() => (window.getSelection() as unknown as { direction?: string }).direction);
  await page.keyboard.press('Shift+ArrowUp');
  const up = await read(page);
  if (direction === 'none') {
    expect([up.kind, up.anchor, up.head]).toEqual(['BodyEdgeSelectionClass', inside.head, 2]);
  } else {
    expect([up.kind, up.anchor]).toEqual(['_TextSelection', inside.anchor]);
    expect(up.head).toBeGreaterThan(inside.anchor);
    expect(up.head).toBeLessThan(inside.head);
  }
});

test('an empty code block last shows the empty-line mark when a drag reaches past it (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'Above' }, { type: 'codeBlock' }]);
  const word = await wordBox(page, 'Above');
  const last = await rowBox(page, -1);

  await drag(page, { x: word.x + 2, y: word.y + word.height / 2 }, [{ x: word.x + 40, y: last.y + last.height + 80 }]);

  expect((await read(page)).head).toBe((await read(page)).size - 2);
  const mark = await page.evaluate((selector) => {
    const lines = document.querySelectorAll(`${selector} .bn-block-content`);
    const code = lines[lines.length - 1]!.querySelector('.bn-inline-content')!;
    const before = getComputedStyle(code, '::before');
    return { tag: code.tagName, display: before.display, width: parseFloat(before.width) };
  }, EDITOR);
  expect(mark.tag).toBe('CODE');
  expect(mark.display).toBe('inline-block');
  expect(mark.width).toBeGreaterThan(0);
});

test('Shift+Left on a selection past the last block steps over a whole emoji (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'Hi\u{1F600}' }, { type: 'divider' }]);
  const line = await rowBox(page, 0);
  const last = await rowBox(page, -1);
  await drag(page, { x: line.x + 300, y: last.y + last.height + 60 }, [{ x: line.x + 300, y: line.y + line.height / 2 }]);
  const start = await read(page);

  await page.keyboard.press('Shift+ArrowLeft');

  expect((await read(page)).head).toBe(start.head - 2);
});

test('a Shift+click on a clicked divider keeps it in the selection (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'Above' }, { type: 'divider' }, { type: 'paragraph', content: 'Below' }]);
  const divider = await rowBox(page, 1);
  await page.mouse.move(divider.x + 100, divider.y + divider.height / 2);
  await page.waitForTimeout(SETTLE_MS);
  await page.mouse.click(divider.x + 100, divider.y + divider.height / 2);

  await shiftClick(page, divider.x + 100, divider.y + divider.height / 2);

  const reading = await read(page);
  expect(reading.painted).toEqual(['divider']);
  expect([reading.kind, reading.text]).toEqual(['_TextSelection', '|#|']);
});

test('Enter on a selection anchored past the last block replaces it and opens a line (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_DIVIDER);
  const word = await wordBox(page, 'Middle');
  const last = await rowBox(page, -1);
  await drag(page, { x: word.x + 40, y: last.y + last.height + 60 }, [{ x: word.x + 2, y: word.y + word.height / 2 }]);
  expect((await read(page)).anchor).toBe((await read(page)).size - 2);

  await page.keyboard.press('Enter');

  await expect.poll(async () => (await read(page)).rows).toEqual(['paragraph:Above', 'paragraph:', 'paragraph:']);
});

test('Shift+Down next to an edge keeps the column the browser remembers across a short line (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'Intro' }, { type: 'paragraph', content: 'x' }, { type: 'divider' }]);
  await page.locator(EDITOR).getByText('x', { exact: true }).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('a'.repeat(40));
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('b');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('c'.repeat(40));
  const start = await page.evaluate((selector) => {
    const el = document.querySelector(selector) as unknown as { editor: { state: { doc: { descendants: (f: (n: { isTextblock: boolean; textContent: string }, p: number) => boolean) => void } } } };
    let at = -1;
    el.editor.state.doc.descendants((n, p) => {
      if (n.isTextblock && n.textContent.startsWith('aaaa')) at = p + 1;
      return at < 0;
    });
    return at;
  }, EDITOR);
  // Twenty characters into the first line, set through the editor so the
  // browser's own column starts there.
  await page.evaluate(([selector, pos]) => {
    const el = document.querySelector(selector) as unknown as { editor: { state: { doc: unknown; selection: { constructor: { create: (doc: unknown, pos: number) => unknown } }; tr: { setSelection: (s: unknown) => unknown } }; view: { dispatch: (tr: unknown) => void } } };
    const { state } = el.editor;
    el.editor.view.dispatch(state.tr.setSelection(state.selection.constructor.create(state.doc, pos)));
  }, [EDITOR, start + 20] as const);

  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');

  // Line one is 0-39, the break 40, 'b' 41, the break 42, line three from 43.
  await expect.poll(async () => (await read(page)).head - start).toBe(43 + 20);
});

test('a Shift+drag from the body past an empty last line takes it in (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'One' }, { type: 'paragraph', content: 'Two' }, { type: 'paragraph' }]);
  const one = await wordBox(page, 'One');
  const two = await wordBox(page, 'Two');
  const last = await rowBox(page, -1);
  await page.mouse.click(one.x + 2, one.y + one.height / 2);
  await expect.poll(async () => (await read(page)).kind).toBe('_TextSelection');

  await page.mouse.move(two.x + 10, two.y + two.height / 2);
  await page.waitForTimeout(SETTLE_MS);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(two.x + 10, last.y + last.height + 60, { steps: 10 });
  await expect.poll(async () => (await read(page)).head).toBe((await read(page)).size - 2);
  await page.mouse.up();
  await page.keyboard.up('Shift');

  expect(await linesMarked(page)).toEqual([false, false, true]);
});

test('a Shift+click on the first of two trailing dividers holds both (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'Above' }, { type: 'divider' }, { type: 'divider' }]);
  const divider = await rowBox(page, 1);
  await page.mouse.move(divider.x + 100, divider.y + divider.height / 2);
  await page.waitForTimeout(SETTLE_MS);
  await page.mouse.click(divider.x + 100, divider.y + divider.height / 2);
  expect((await read(page)).kind).toBe('_NodeSelection');

  await shiftClick(page, divider.x + 100, divider.y + divider.height / 2);

  // Which end stays follows the page's rule, so either end may be on the edge.
  const reading = await read(page);
  expect(reading.kind).toBe('BodyEdgeSelectionClass');
  expect([reading.anchor, reading.head]).toContain(reading.size - 2);
  expect(reading.painted).toEqual(['divider', 'divider']);
});

test('a Shift+click below the last block made from outside the body focuses it and shows the selection (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_DIVIDER);
  const word = await wordBox(page, 'Middle');
  const last = await rowBox(page, -1);
  await page.mouse.click(word.x + 2, word.y + word.height / 2);
  await page.evaluate(() => {
    const other = document.createElement('input');
    other.id = 'edge-smoke-other';
    other.style.position = 'fixed';
    other.style.top = '0';
    document.body.appendChild(other);
    other.focus();
  });

  await shiftClick(page, word.x + 40, last.y + last.height + 60);

  const reading = await read(page);
  expect([reading.kind, reading.head === reading.size - 2, reading.painted]).toEqual(['BodyEdgeSelectionClass', true, ['divider']]);
  expect(await page.evaluate((selector) => document.activeElement === document.querySelector(selector), EDITOR)).toBe(true);
  await page.evaluate(() => document.getElementById('edge-smoke-other')?.remove());
});

test('Shift+Down from the end of the next-to-last line of a wrapped last paragraph moves a line before the edge (A6)', async () => {
  await openFreshDocument(page);
  const cjk = '中文段落'.repeat(60);
  await setBlocks(page, [{ type: 'paragraph', content: 'Intro' }, { type: 'paragraph', content: cjk }, { type: 'divider' }]);
  const box = (await page.locator(EDITOR).getByText(cjk).boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + box.height - 30);
  await expect.poll(async () => (await read(page)).kind).toBe('_TextSelection');
  await page.keyboard.press('Meta+ArrowRight');

  await page.keyboard.press('Shift+ArrowDown');
  const down = await read(page);
  expect(down.kind).toBe('_TextSelection');

  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await read(page)).head).toBe((await read(page)).size - 2);
});

test('after a drag up from below an empty last line, a Shift+click on words keeps the line in (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Gap' }, { type: 'paragraph', content: 'Middle' }, { type: 'paragraph' }]);
  const word = await wordBox(page, 'Middle');
  const above = await wordBox(page, 'Above');
  const last = await rowBox(page, -1);
  await drag(page, { x: word.x + 40, y: last.y + last.height + 60 }, [{ x: word.x + 2, y: word.y + word.height / 2 }]);

  await shiftClick(page, above.x + 2, above.y + above.height / 2);

  const reading = await read(page);
  expect(reading.anchor).toBe(reading.size - 2);
  expect(reading.text.startsWith('Above|Gap|Middle')).toBe(true);
  expect(await linesMarked(page)).toEqual([false, false, false, true]);
});

test('with words last, dragging below the body is the plain text selection it always was (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, [{ type: 'paragraph', content: 'Above' }, { type: 'paragraph', content: 'Below' }]);
  const word = await wordBox(page, 'Above');
  const last = await rowBox(page, -1);

  await drag(page, { x: word.x + 2, y: word.y + word.height / 2 }, [{ x: word.x + 40, y: last.y + last.height + 120 }]);

  const reading = await read(page);
  expect(reading.kind).toBe('_TextSelection');
  expect(reading.text).toBe('Above|Below');
});

test('a click on the space below a trailing divider opens a line there', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_DIVIDER);
  const word = await wordBox(page, 'Above');
  const last = await rowBox(page, -1);

  await page.mouse.move(word.x + 40, last.y + last.height + 60);
  await page.waitForTimeout(SETTLE_MS);
  await page.mouse.click(word.x + 40, last.y + last.height + 60);
  await page.keyboard.type('New');

  await expect.poll(async () => (await read(page)).rows).toEqual(['paragraph:Above', 'paragraph:Middle', 'divider:', 'paragraph:New']);
});

test('a drag that rests at the bottom of a long body scrolls it and reaches the end (A6)', async () => {
  await openFreshDocument(page);
  const lines: BlockSpec[] = Array.from({ length: 60 }, (_, i) => ({ type: 'paragraph', content: `Line ${i}` }));
  await setBlocks(page, [...lines, { type: 'divider' }]);
  const word = await wordBox(page, 'Line 0');
  const viewport = page.viewportSize()!;

  await page.mouse.move(word.x + 2, word.y + word.height / 2);
  await page.waitForTimeout(SETTLE_MS);
  await page.mouse.down();
  await page.mouse.move(word.x + 40, viewport.height - 2, { steps: 10 });
  await expect.poll(async () => (await read(page)).head, { timeout: 20_000 }).toBe((await read(page)).size - 2);
  await page.mouse.up();

  expect((await read(page)).painted).toEqual(['divider']);
});

test('deleting a selection that reaches the end takes the divider, and undo brings both back (A6)', async () => {
  await openFreshDocument(page);
  await setBlocks(page, WITH_DIVIDER);
  await page.waitForTimeout(600);
  const word = await wordBox(page, 'Middle');
  const last = await rowBox(page, -1);
  await drag(page, { x: word.x + 2, y: word.y + word.height / 2 }, [{ x: word.x + 40, y: last.y + last.height + 120 }]);

  await page.keyboard.press('Backspace');
  await expect.poll(async () => (await read(page)).rows).toEqual(['paragraph:Above', 'paragraph:']);

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(async () => (await read(page)).rows).toEqual(['paragraph:Above', 'paragraph:Middle', 'divider:']);
  const reading = await read(page);
  expect(reading.kind).toBe('BodyEdgeSelectionClass');
  expect(reading.painted).toEqual(['divider']);
});

test('a second tab typing elsewhere leaves the selection reaching the end (A6)', async ({ browser }) => {
  const id = await openFreshDocument(page);
  await setBlocks(page, WITH_DIVIDER);
  const other = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  try {
    await other.goto(page.url());
    await other.getByTestId(`space-tab-${id}`).click().catch(() => undefined);
    const otherEditor = other.locator(EDITOR);
    await expect(otherEditor).toContainText('Middle', { timeout: 15_000 });

    await page.bringToFront();
    const word = await wordBox(page, 'Middle');
    const last = await rowBox(page, -1);
    await drag(page, { x: word.x + 2, y: word.y + word.height / 2 }, [{ x: word.x + 40, y: last.y + last.height + 120 }]);

    await other.bringToFront();
    await other.locator(EDITOR).getByText('Above', { exact: true }).click();
    await other.keyboard.press('End');
    await other.keyboard.type(' more');
    await page.bringToFront();
    await expect.poll(async () => (await read(page)).rows[0]).toBe('paragraph:Above more');

    const reading = await read(page);
    expect(reading.kind).toBe('BodyEdgeSelectionClass');
    expect(reading.head).toBe(reading.size - 2);
    expect(reading.painted).toEqual(['divider']);
  } finally {
    await other.close();
  }
});
