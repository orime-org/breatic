// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A15: the geometry and colour inside the editor are ours (task #904).
 *
 * Every value here is a laid-out box or a computed style, which is the half
 * jsdom reports as zero. What the editor draws comes from two stylesheets —
 * the one it ships and the one we write over it — and only a browser resolves
 * the cascade between them.
 *
 * Wants dev running and a smoke account:
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
});

test.afterAll(async () => {
  await page?.close();
});

const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
});

/** Which project this run works in; without one, the top of the studio page. */
const projectUrl = process.env.SMOKE_PROJECT_URL;

const EDITOR = '[data-testid="document-space"] .ProseMirror';

/** The Cmd key on macOS, Ctrl everywhere else. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Opens a freshly made Document Space with the caret in the body.
 * @param p - The page.
 */
async function openFreshDocument(p: Page): Promise<void> {
  if (projectUrl === undefined) {
    await p.goto('/studio');
    const firstProject = p.locator('a[href^="/project/"]').first();
    await expect(firstProject).toBeVisible({ timeout: 15_000 });
    await firstProject.click();
  } else {
    await p.goto(projectUrl);
  }
  await p.waitForURL(/\/project\//, { timeout: 15_000 });

  createdSpaceIds.push(await createSpace(p, 'document', `styles-${Date.now()}`));

  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(p.getByTestId('new-space-button')).toBeFocused();
  await editor.click();
  await expect(editor).toBeFocused();
}

/** One block's box and the marker drawn beside it. */
interface BlockBox {
  readonly type: string;
  readonly text: string;
  readonly left: number;
  readonly marker: string;
  readonly markerFont: string;
}

/**
 * Measures every block's left edge and the marker drawn before it.
 * @param p - The page.
 * @returns One entry per block, in document order.
 */
async function blockBoxes(p: Page): Promise<BlockBox[]> {
  return p.evaluate(
    (sel) =>
      [...document.querySelectorAll(`${sel} .bn-block-content`)].map(
        (element) => {
          const before = getComputedStyle(element, '::before');
          return {
            type: element.getAttribute('data-content-type') ?? '?',
            text: (element.textContent ?? '').trim(),
            left: Math.round(element.getBoundingClientRect().left),
            marker: before.content,
            markerFont: before.fontSize,
          };
        },
      ),
    EDITOR,
  );
}

test('draws each indent level further right than the one above it', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('- top');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('deep');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('deeper');

  const boxes = await blockBoxes(page);
  expect(boxes.map((box) => box.text)).toEqual(['top', 'deep', 'deeper']);
  // A reader who presses Tab has to see the block move. The step itself is
  // whatever the editor's own stylesheet sets; what this pins is that each
  // level starts further right than the one above it.
  expect(boxes[1]!.left).toBeGreaterThan(boxes[0]!.left);
  expect(boxes[2]!.left).toBeGreaterThan(boxes[1]!.left);
});

test('opens flush and keeps one list tighter than it stands apart', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('- a');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('a1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a2');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.type('b');

  const gaps = await page.evaluate((sel) => {
    const all = [...document.querySelectorAll(`${sel} .bn-block-content`)];
    return all.map((element, index) => ({
      text: (element.textContent ?? '').trim(),
      marginTop: parseFloat(getComputedStyle(element).marginTop),
      gap:
        index === 0
          ? null
          : element.getBoundingClientRect().top -
            all[index - 1]!.getBoundingClientRect().bottom,
    }));
  }, EDITOR);

  expect(gaps.map((row) => row.text)).toEqual(['a', 'a1', 'a2', 'b']);
  // The first block of the DOCUMENT carries no space above it. Indenting
  // opens a new block group, and `a1` is the first child of that one — it
  // used to match the same rule and sit flush against its parent while every
  // other pair stood 12.75px apart.
  expect(gaps[0]!.marginTop, 'the document opens flush').toBe(0);
  // Every block after it carries space, and two items of one list carry less
  // of it than two kinds of block do (user 2026-09-07): all four blocks here
  // are bulleted items, so each pair is a list-internal one.
  for (const row of gaps.slice(1)) {
    expect(row.marginTop, `the space above "${row.text}"`).toBeGreaterThan(0);
  }
  const listInternal = gaps.slice(1).map((row) => row.marginTop);
  for (const margin of listInternal) {
    expect(margin, 'inside one list').toBeLessThan(12.75);
  }
});

test('draws a marker beside a bulleted item and a numbered one', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('- bulleted');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. numbered');

  const boxes = await blockBoxes(page);
  const bulleted = boxes.find((box) => box.type === 'bulletListItem');
  const numbered = boxes.find((box) => box.type === 'numberedListItem');
  expect(bulleted?.marker, 'a bulleted item draws its bullet').not.toBe('none');
  expect(numbered?.marker, 'a numbered item draws its number').toContain('1');
});

// All three levels, because the rule that gives the number its size is the
// one that declines to state one: a size written into it — even an absolute
// one that happens to equal level 1's — flattens the other two onto it, and
// a single level cannot tell those two worlds apart.
for (const level of [1, 2, 3]) {
  test(`sets a level ${String(level)} heading's number in that heading's own size`, async () => {
    await openFreshDocument(page);
    await page.keyboard.type('a numbered heading');
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.press(`${MOD}+Shift+7`);
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.press(`${MOD}+Alt+${String(level)}`);

    const measured = await page.evaluate((sel) => {
      const element = document.querySelector(`${sel} .bn-block-content`)!;
      const inner = element.querySelector('.bn-inline-content');
      return {
        type: element.getAttribute('data-content-type'),
        level: element.getAttribute('data-level'),
        number: element.getAttribute('data-doc-number'),
        headingFont: inner === null ? null : getComputedStyle(inner).fontSize,
        markerFont: getComputedStyle(element, '::before').fontSize,
      };
    }, EDITOR);

    expect(measured.type).toBe('heading');
    expect(measured.level ?? '1').toBe(String(level));
    expect(measured.number).toBe(level === 1 ? '1.' : `1${'.1'.repeat(level - 1)}`);
    // The number belongs to the heading, not to the body around it (user
    // 2026-09-02): a size of its own flattens all three levels onto one.
    expect(measured.markerFont).toBe(measured.headingFont);
  });
}

test('starts an empty document at the left edge, hint and all', async () => {
  await openFreshDocument(page);

  const seen = await page.evaluate((sel) => {
    const block = document.querySelector(`${sel} .bn-block-content`);
    if (block === null) return null;
    const inline = block.querySelector('.bn-inline-content');
    if (inline === null) return null;
    const before = getComputedStyle(block, '::before');
    const after = getComputedStyle(block, '::after');
    return {
      offset:
        Math.round(
          (inline.getBoundingClientRect().left -
            block.getBoundingClientRect().left) * 10,
        ) / 10,
      hintOnBefore: before.content,
      hintOnAfter: after.content,
      hintStyle: after.fontStyle,
      hintInset: after.marginInlineStart,
    };
  }, EDITOR);

  // A block is a flex container (BlockNote's `style.css`), and a flex item's
  // float is ignored — so a `::before` carrying the hint became an item of its
  // own and pushed the line along. Measured, the text and the caret with it
  // started 99.3px in, the width of "Start writing…".
  expect(seen?.offset).toBe(0);
  // The hint follows the line it labels, which is where BlockNote's own puts
  // it (`.bn-block-content:has(.ProseMirror-trailingBreak:only-child):after`).
  // Every block already carries a `::before` from that library, holding the
  // empty string, so what says the hint moved is that it is not in there.
  expect(seen?.hintOnBefore).not.toContain('Start writing');
  expect(seen?.hintOnAfter).toContain('Start writing');
  // BlockNote styles the `::after` of a block holding only a trailing break,
  // which is what an empty one holds — italic, and pulled 2px either side. The
  // hint reads in the body's own face and starts where the caret does.
  expect(seen?.hintStyle).toBe('normal');
  expect(seen?.hintInset).toBe('0px');
});

test('holds every number 8px clear of the text it labels', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('an ordered item');
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Shift+7`);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a heading');
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Alt+1`);

  const rows = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    return [...root.querySelectorAll('.bn-block-content[data-doc-number]')].map(
      (element) => {
        const before = getComputedStyle(element, '::before');
        return {
          type: element.getAttribute('data-content-type'),
          minWidth: before.minWidth,
          paddingRight: before.paddingRight,
          justify: before.justifyContent,
        };
      },
    );
  }, EDITOR);

  expect(rows).toHaveLength(2);

  // 8px between any number and its text, whichever block carries it and however
  // long the number runs (user 2026-09-08). A width floor cannot state that: it
  // holds only while the number fits under it, and past that the padding is the
  // whole gap. Measured against the 24px floor and 4px padding that stood here,
  // a heading's `1.1.1` and a list's `12.` both came out at 4px while a
  // one-digit `1` sat 13.7px clear.
  for (const row of rows) {
    expect(row.minWidth, row.type ?? '').toBe('0px');
    expect(row.paddingRight, row.type ?? '').toBe('8px');
    // Numbers read from the left, the same as the text they label. Centred, a
    // number narrower than its box floated: measured on three numbered
    // headings, `1` sat about 3.5px right of `1.1` and `1.1.1`.
    expect(row.justify, row.type ?? '').toBe('flex-start');
  }
});

test('draws the body in our own font and the code block on our own panel', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('plain line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```');
  await page.keyboard.type('code here');

  const measured = await page.evaluate((sel) => {
    const root = document.querySelector(sel) as HTMLElement | null;
    if (root === null) return null;
    const rootStyle = getComputedStyle(document.documentElement);
    /** What a token value computes to once the browser has resolved it. */
    const paint = (property: string, value: string): string => {
      const probe = document.createElement('span');
      probe.style.setProperty(property, value);
      document.body.appendChild(probe);
      const painted = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return painted;
    };
    const token = (name: string): string =>
      rootStyle.getPropertyValue(name).trim();
    const editor = getComputedStyle(root);
    const code = root.querySelector('[data-content-type="codeBlock"]');
    const pre = code?.querySelector('pre') ?? null;
    return {
      editorFont: editor.fontFamily,
      editorSize: editor.fontSize,
      wantFont: paint('font-family', token('--font-sans')),
      wantSize: paint('font-size', token('--font-size-base')),
      codeFound: code !== null,
      codeColor: code === null ? null : getComputedStyle(code).color,
      preBackground: pre === null ? null : getComputedStyle(pre).backgroundColor,
      wantColor: paint('color', token('--color-foreground')),
      wantPanel: paint('background-color', token('--color-muted')),
    };
  }, EDITOR);

  expect(measured).not.toBeNull();
  const seen = measured as NonNullable<typeof measured>;
  // BlockNote's own `.bn-default-styles` sets a font stack and 16px, and
  // neither is ours: the stack it ships carries no CJK face, and the body
  // stood 1px above every other surface in the product (§9.1, A15 ④).
  expect(seen.editorFont, 'the body is set in our own stack').toBe(seen.wantFont);
  expect(seen.editorSize, 'the body is set at our own size').toBe(seen.wantSize);

  // And the code block, which BlockNote paints near-black with white text on
  // purpose — deliberately theme-independent, which our light panel is not
  // (A15 ②). The white text is set on the block and inherited by the `pre`
  // inside it, so it survives a panel that only sets a background.
  expect(seen.codeFound, 'the document holds a code block').toBe(true);
  expect(seen.codeColor, 'the code block writes in body colour').toBe(
    seen.wantColor,
  );
  expect(seen.preBackground, 'the code block sits on the muted panel').toBe(
    seen.wantPanel,
  );
});

test('marks a node-selected block in our colour and no other (A15)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('a block to select');
  // Ctrl/Cmd-click is what node-selects a block in ProseMirror.
  await page
    .locator(`${EDITOR} .bn-block-content`)
    .first()
    .click({ modifiers: ['ControlOrMeta'] });

  const measured = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const selected = root?.querySelector('.ProseMirror-selectednode') ?? null;
    if (selected === null) return null;
    const rootStyle = getComputedStyle(document.documentElement);
    /** What a token value computes to once the browser has resolved it. */
    const paint = (property: string, value: string): string => {
      const probe = document.createElement('span');
      probe.style.setProperty(property, value);
      document.body.appendChild(probe);
      const painted = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return painted;
    };
    // The overlay ships on the ::after of whatever the block content holds,
    // which is why it is read off the child rather than off the block.
    const inner = selected.firstElementChild;
    const overlay = inner === null ? null : getComputedStyle(inner, '::after');
    return {
      outlineColour: getComputedStyle(selected).outlineColor,
      wantColour: paint(
        'color',
        rootStyle.getPropertyValue('--color-status-selected').trim(),
      ),
      overlayBackground: overlay?.backgroundColor ?? null,
      overlayShadow: overlay?.boxShadow ?? null,
    };
  }, EDITOR);

  expect(measured, 'the click node-selected a block').not.toBeNull();
  const seen = measured as NonNullable<typeof measured>;
  expect(seen.outlineColour, 'the block is marked in our selected colour').toBe(
    seen.wantColour,
  );
  // BlockNote paints a second marker of its own over the same block: a
  // `#64a0ff` wash with a 4px inset ring of the same hue, on a fixed value
  // that follows neither theme nor our tokens (A15 ①). Measured against ours
  // it is a different colour outright — purple outline, blue fill — so a
  // selected block carried two markers that disagreed.
  expect(seen.overlayBackground, 'no second wash over the block').toBe(
    'rgba(0, 0, 0, 0)',
  );
  expect(seen.overlayShadow, 'no second ring inside the block').toBe('none');
});

test.describe('the values the visual review settled (user 2026-09-07)', () => {
  test('sets the three heading levels at 24, 20 and 18', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('# One');
    await page.keyboard.press('Enter');
    await page.keyboard.type('## Two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('### Three');

    const sizes = await page.evaluate(
      (sel) =>
        [
          ...document.querySelectorAll(`${sel} [data-content-type="heading"]`),
        ].map((element) => parseFloat(getComputedStyle(element).fontSize)),
      EDITOR,
    );
    // A level 3 heading led the body by 2px, the smallest step in the ladder,
    // and 17px is the one size in the document off the project's scale.
    expect(sizes).toEqual([24, 20, 18]);
  });

  test('leaves each heading a line of its own size beneath it', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('# One');
    await page.keyboard.press('Enter');
    await page.keyboard.type('body under one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('## Two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('body under two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('### Three');
    await page.keyboard.press('Enter');
    await page.keyboard.type('body under three');

    const gaps = await page.evaluate((sel) => {
      const blocks = [
        ...document.querySelectorAll(`${sel} .bn-block-content`),
      ] as HTMLElement[];
      return blocks
        .map((element, index) => {
          if (element.getAttribute('data-content-type') !== 'heading') {
            return null;
          }
          const next = blocks[index + 1];
          if (next === undefined) return null;
          return {
            size: parseFloat(getComputedStyle(element).fontSize),
            gap:
              Math.round(
                (next.getBoundingClientRect().top -
                  element.getBoundingClientRect().bottom) * 10,
              ) / 10,
          };
        })
        .filter((row) => row !== null);
    }, EDITOR);

    // The space under a heading tracks its own size (user 2026-09-08). It
    // used to be the next block's 12.75px whichever level it followed — 0.85
    // of the body size, under a level 3 that leads the body by 3px.
    expect(gaps).toEqual([
      { size: 24, gap: 24 },
      { size: 20, gap: 20 },
      { size: 18, gap: 18 },
    ]);
  });

  test('holds two headings apart by the lower one alone', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('# One');
    await page.keyboard.press('Enter');
    await page.keyboard.type('## Two');

    const gap = await page.evaluate((sel) => {
      const [first, second] = [
        ...document.querySelectorAll(`${sel} .bn-block-content`),
      ] as HTMLElement[];
      if (first === undefined || second === undefined) return null;
      return (
        Math.round(
          (second.getBoundingClientRect().top -
            first.getBoundingClientRect().bottom) * 10,
        ) / 10
      );
    }, EDITOR);

    // The distance between two sections is the lower heading's own 1.7em,
    // which is wider than the space either of them keeps above its body. The
    // space a heading leaves beneath itself stacks onto that rather than
    // collapsing into it, so it is dropped where a heading is what follows.
    expect(gap).toBe(34);
  });

  test('sets the code block at the small step of the scale', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('const a = 1');
    await page.keyboard.press(`${MOD}+Alt+c`);

    const measured = await page.evaluate((sel) => {
      const pre = document.querySelector(`${sel} pre`) as HTMLElement;
      const root = getComputedStyle(document.documentElement);
      return {
        size: parseFloat(getComputedStyle(pre).fontSize),
        want: parseFloat(root.getPropertyValue('--text-sm')),
      };
    }, EDITOR);
    expect(measured.size).toBe(measured.want);
  });

  test('gives the code panel the same weight in both themes', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('const a = 1');
    await page.keyboard.press(`${MOD}+Alt+c`);

    const read = async (): Promise<{ panel: number; page: number }> =>
      page.evaluate((sel) => {
        const pre = document.querySelector(`${sel} pre`) as HTMLElement;
        const star = (value: string): number => {
          const [r, g, b] = value.match(/\d+/g)!.map(Number) as [
            number,
            number,
            number,
          ];
          const ch = (v: number): number => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          };
          const y = 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
          return y <= 216 / 24389 ? y * (24389 / 27) : y ** (1 / 3) * 116 - 16;
        };
        return {
          panel: star(getComputedStyle(pre).backgroundColor),
          page: star(getComputedStyle(document.body).backgroundColor),
        };
      }, EDITOR);

    const light = await read();
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await page.waitForTimeout(300);
    const dark = await read();
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.removeAttribute('data-theme');
    });

    // A surface lifts off its ground by moving toward the light the theme
    // has: down in a light theme, up in a dark one (user 2026-09-07).
    // Measured before: 5.6 L* under the page in light and 3.0 UNDER it in
    // dark as well, so the same object read as a solid plate in one theme and
    // as nearly absent in the other.
    const lightStep = light.page - light.panel;
    const darkStep = dark.panel - dark.page;
    expect(lightStep, 'the light panel sits below the page').toBeGreaterThan(4);
    expect(darkStep, 'the dark panel sits above the page').toBeGreaterThan(4);
    expect(
      Math.abs(lightStep - darkStep),
      `light ${lightStep.toFixed(1)} against dark ${darkStep.toFixed(1)}`,
    ).toBeLessThan(1.5);
  });

  test('holds a list together more tightly than it holds two kinds apart', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('- one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('a paragraph');

    const margins = await page.evaluate(
      (sel) =>
        [...document.querySelectorAll(`${sel} .bn-block-content`)].map(
          (element) => ({
            text: (element.textContent ?? '').trim(),
            marginTop: parseFloat(getComputedStyle(element).marginTop),
          }),
        ),
      EDITOR,
    );
    const [, second, third] = margins as { text: string; marginTop: number }[];
    // One margin for every relationship read as one undifferentiated column:
    // the paragraph stood no further from the list than the list's own two
    // items stood from each other.
    expect(second!.marginTop, 'inside one list').toBeLessThan(third!.marginTop);
  });

  test('leaves the space inside a run to the blocks (user 2026-09-08)', async () => {
    await openFreshDocument(page);
    // Two ordinary blocks first: the document's own first block carries no
    // space above it, so the pair below is what "two unrelated blocks" means.
    await page.keyboard.type('first');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    await page.keyboard.press('Enter');
    await page.keyboard.type('quoted one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('quoted two');
    await page.locator(`${EDITOR} .bn-block-content`).nth(2).click({ clickCount: 3 });
    await page.keyboard.press(`${MOD}+Shift+b`);
    await page.locator(`${EDITOR} .bn-block-content`).nth(3).click({ clickCount: 3 });
    await page.keyboard.press(`${MOD}+Shift+b`);
    await page.waitForTimeout(300);

    const measured = await page.evaluate((sel) => {
      const quoted = [...document.querySelectorAll(`${sel} [data-quoted="true"]`)];
      const all = [...document.querySelectorAll(`${sel} .bn-block-content`)];
      const wrapper = quoted[1]!.closest('.bn-block-outer') as HTMLElement;
      return {
        insideRun: parseFloat(getComputedStyle(quoted[1]!).marginTop),
        betweenBlocks: parseFloat(getComputedStyle(all[1]!).marginTop),
        // The wrapper is what the rule is drawn on, and its box has to cover
        // that space or the rule breaks between the two blocks.
        wrapperHeight: Math.round(wrapper.getBoundingClientRect().height * 10) / 10,
        contentHeight: Math.round(quoted[1]!.getBoundingClientRect().height * 10) / 10,
        rule: getComputedStyle(wrapper).borderInlineStartWidth,
      };
    }, EDITOR);

    // Quoting a block changes no spacing at all: a rule here used to state one
    // value for every block in a run, which ADDED to what each block already
    // carried — two quoted list items stood 12px apart against the 4px they
    // take anywhere else (user 2026-09-08).
    expect(measured.insideRun, 'inside the run').toBe(measured.betweenBlocks);
    // What holds the run together is the rule running unbroken past that
    // space, which is why it is drawn on the wrapper: the wrapper's box
    // contains the block's margin, the content element's does not.
    expect(measured.rule).toBe('2px');
    expect(
      measured.wrapperHeight - measured.contentHeight,
      'the wrapper covers the margin the rule has to run past',
    ).toBeCloseTo(measured.insideRun, 0);
  });
});

test('leaves a to-do box the gutter its markers keep (user 2026-09-07)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('- bulleted');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[] a to-do');
  await page.waitForTimeout(400);

  const rows = await page.evaluate((sel) => {
    const all = [...document.querySelectorAll(`${sel} .bn-block-content`)];
    return all.map((element) => {
      const text = element.querySelector('.bn-inline-content');
      const box = element.querySelector('input');
      return {
        kind: element.getAttribute('data-content-type'),
        blockLeft: element.getBoundingClientRect().left,
        textLeft: text ? text.getBoundingClientRect().left : null,
        boxRight: box ? box.getBoundingClientRect().right : null,
      };
    });
  }, EDITOR);

  const [bullet, todo] = rows as {
    kind: string | null;
    blockLeft: number;
    textLeft: number | null;
    boxRight: number | null;
  }[];
  // The text starts at the same place for both kinds, and the box clears it
  // by more than the 4px it had. Measured before: the bulleted item's glyph
  // ended 12px from its text while the box ended 4px from its own, because
  // the box's own margins were what pushed that text out (user 2026-09-07).
  expect(todo!.textLeft, 'both kinds start their text at one x').toBe(
    bullet!.textLeft,
  );
  expect(todo!.textLeft! - todo!.boxRight!, 'the box clears its text').toBeGreaterThan(6);
});

test('centres the tick on the box it ticks (user 2026-09-07)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('[] a to-do');
  await page.waitForTimeout(300);
  await page.locator(`${EDITOR} input[type="checkbox"]`).click();
  await page.waitForTimeout(300);

  const centres = await page.evaluate((sel) => {
    const block = document.querySelector(
      `${sel} .bn-block-content[data-content-type="checkListItem"]`,
    )!;
    const box = block.querySelector('input')!.getBoundingClientRect();
    const holder = block.querySelector('div')!;
    const after = getComputedStyle(holder, '::after');
    const left = parseFloat(after.left);
    const width = parseFloat(after.width);
    return {
      boxCentre: box.left + box.width / 2 - holder.getBoundingClientRect().left,
      tickCentre: left + width / 2,
    };
  }, EDITOR);
  // The tick is a mask on the holder, positioned from the holder's own edge,
  // so moving the box inside the holder moves it away from its tick.
  expect(Math.abs(centres.tickCentre - centres.boxCentre)).toBeLessThan(0.6);
});

test('draws a heading number in the line height its text takes (#963)', async () => {
  await openFreshDocument(page);
  for (const level of [1, 2, 3]) {
    await page.keyboard.type(`heading ${String(level)}`);
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.press(`${MOD}+Alt+${String(level)}`);
    await page.keyboard.press(`${MOD}+Shift+7`);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+Alt+0`);
  }

  const rows = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    return [
      ...root.querySelectorAll(
        '.bn-block-content[data-content-type="heading"][data-doc-number]',
      ),
    ].map((element) => ({
      level: element.getAttribute('data-level') ?? '1',
      marker: getComputedStyle(element, '::before').lineHeight,
      text: getComputedStyle(element.querySelector('.bn-inline-content')!).lineHeight,
    }));
  }, EDITOR);

  expect(rows).toHaveLength(3);

  // The number is a `::before` on the block and the text is an `h1`..`h3`
  // inside it, so the two draw in line boxes that start on the same edge. Give
  // them different heights and each centres its own glyphs at a different
  // depth: measured with the block on 1.5 and the text on 1.3/1.35/1.45, the
  // number sat 2.4, 1.5 and 0.45px below the first line.
  //
  // Read off the marker rather than off the block: today the marker inherits
  // the block's line height and the heading element inherits it too, so
  // block-against-text is a pair that cannot differ, and a line height written
  // onto the marker's own rule — 300 lines from the heading rules — would
  // break the alignment with that comparison still green.
  for (const row of rows) {
    expect(row.marker, `level ${row.level}`).toBe(row.text);
  }
});

test('holds a number its whole width when the heading wraps (#963)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('one');
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Alt+1`);
  await page.keyboard.press(`${MOD}+Shift+7`);
  await page.keyboard.press('End');

  /**
   * How wide the number's box is right now, and how tall its text stands.
   * @returns The gutter in pixels and the text's height.
   */
  const gutter = async (): Promise<{ width: number; height: number }> =>
    page.evaluate((sel) => {
      const block = document.querySelector(
        `${sel} .bn-block-content[data-doc-number]`,
      )!;
      const inline = block.querySelector('.bn-inline-content')!;
      return {
        width:
          inline.getBoundingClientRect().left - block.getBoundingClientRect().left,
        height: inline.getBoundingClientRect().height,
      };
    }, EDITOR);

  const single = await gutter();
  await page.keyboard.type(
    ' with enough words after it to run past the end of the line and wrap onto a second one',
  );
  await page.waitForTimeout(200);
  const wrapped = await gutter();

  // The heading has to have wrapped for the rest to mean anything: on one line
  // the two readings are of the same state and match whatever the rule says.
  expect(wrapped.height).toBeGreaterThan(single.height * 1.5);

  // The number's box and the text are both flex items, so once the text's
  // content outgrows the line the two shrink together and the squeeze comes
  // out of the gap: measured, a heading's `1` held 18.4px on one line and
  // 14.2px across two, leaving 3.8px of the 8px it states.
  expect(Math.abs(wrapped.width - single.width)).toBeLessThan(0.5);
});

test('draws every block marker in the palette blue (#964)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('a heading');
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Alt+1`);
  await page.keyboard.press(`${MOD}+Shift+7`);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${MOD}+Alt+0`);
  await page.keyboard.type('an ordered item');
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Shift+7`);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${MOD}+Alt+0`);
  await page.keyboard.type('a bullet item');
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Shift+8`);
  await page.waitForTimeout(200);

  const seen = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    // What `--color-palette-blue` resolves to in this theme, read the way the
    // marker reads it rather than written out here, so the case holds in dark.
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-palette-blue)';
    root.append(probe);
    const blue = getComputedStyle(probe).color;
    probe.remove();

    const of = (type: string): { marker: string; text: string } => {
      const block = root.querySelector(`.bn-block-content[data-content-type="${type}"]`)!;
      return {
        marker: getComputedStyle(block, '::before').color,
        text: getComputedStyle(block.querySelector('.bn-inline-content')!).color,
      };
    };
    return {
      blue,
      heading: of('heading'),
      ordered: of('numberedListItem'),
      bullet: of('bulletListItem'),
    };
  }, EDITOR);

  // A marker tells the reader what shape a block is, and told it in the text's
  // own colour it says nothing at a glance (user 2026-09-08).
  for (const kind of ['heading', 'ordered', 'bullet'] as const) {
    expect(seen[kind].marker, kind).toBe(seen.blue);
    expect(seen[kind].marker, kind).not.toBe(seen[kind].text);
  }
});

test('draws a ticked to-do box and its tick in the palette blue (#964)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('[] a to-do');
  await page.waitForTimeout(300);

  const read = async (): Promise<{
    blue: string;
    quiet: string;
    border: string;
    background: string;
    tick: string;
  }> =>
    page.evaluate((sel) => {
      const root = document.querySelector(sel)!;
      /**
       * What a token resolves to here, read the way the box reads it.
       * @param token - The custom property to resolve.
       * @returns The resolved colour.
       */
      const resolve = (token: string): string => {
        const probe = document.createElement('span');
        probe.style.color = `var(${token})`;
        root.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };

      const block = root.querySelector(
        '.bn-block-content[data-content-type="checkListItem"]',
      )!;
      const input = block.querySelector('input')!;
      const holder = block.querySelector('div')!;
      const style = getComputedStyle(input);
      return {
        blue: resolve('--color-palette-blue'),
        quiet: resolve('--color-muted-foreground'),
        border: style.borderTopColor,
        background: style.backgroundColor,
        tick: getComputedStyle(holder, '::after').backgroundColor,
      };
    }, EDITOR);

  const unticked = await read();
  // Nothing has been decided yet, and the box says it is there the way the
  // shared `Checkbox` says it: `--color-muted-foreground`, whose 5.6:1 clears
  // SC 1.4.11's 3:1 where `--color-border` measured 1.26:1. Named rather than
  // asserted as "not blue", so that losing the border altogether fails here.
  expect(unticked.border).toBe(unticked.quiet);

  // Clicked, and the pointer stays on the box: a ticked box has to hold the
  // blue under the pointer that just put it there, which is what the hover
  // rule's `:not(:checked)` is for.
  await page.locator(`${EDITOR} input[type="checkbox"]`).click();
  await page.waitForTimeout(300);
  const ticked = await read();

  // Ticked, the box and the tick both carry the blue — the box is not filled
  // with it (user 2026-09-08).
  expect(ticked.border).toBe(ticked.blue);
  expect(ticked.tick).toBe(ticked.blue);
  expect(ticked.background).not.toBe(ticked.blue);
});

test('keeps a marker blue inside a quote (#964)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('an item inside a quote');
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Shift+7`);
  await page.keyboard.press('End');
  await page.keyboard.press(`${MOD}+Shift+B`);
  await page.waitForTimeout(300);

  const quoted = await page.evaluate((sel) => {
    const block = document.querySelector(
      `${sel} .bn-block-content[data-quoted="true"][data-doc-number]`,
    );
    if (block === null) return null;
    return {
      marker: getComputedStyle(block, '::before').color,
      text: getComputedStyle(block.querySelector('.bn-inline-content')!).color,
      // Read back through the cascade so the token's own notation — a hex
      // string — does not have to match what a computed colour serialises to.
      blue: (() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-palette-blue)';
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      })(),
    };
  }, EDITOR);

  // The marker says which item this is, and that does not change with where
  // the item sits: quoting a block mutes its words, not the mark that counts
  // them (user 2026-09-08). Muted, a run holding both kinds showed a grey
  // number on one line and a blue dot on the next, since the bullet's colour
  // is written with one term more than the quote's.
  expect(quoted).not.toBeNull();
  expect(quoted!.marker).not.toBe(quoted!.text);
  expect(quoted!.marker).toBe(quoted!.blue);
});

test('draws a heading number in the weight its title carries (#964)', async () => {
  await openFreshDocument(page);
  for (const level of [1, 2, 3]) {
    await page.keyboard.type(`heading ${String(level)}`);
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.press(`${MOD}+Alt+${String(level)}`);
    await page.keyboard.press(`${MOD}+Shift+7`);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+Alt+0`);
  }

  const rows = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    return [
      ...root.querySelectorAll(
        '.bn-block-content[data-content-type="heading"][data-doc-number]',
      ),
    ].map((element) => ({
      level: element.getAttribute('data-level') ?? '1',
      marker: getComputedStyle(element, '::before').fontWeight,
      title: getComputedStyle(element.querySelector('.bn-inline-content')!).fontWeight,
    }));
  }, EDITOR);

  expect(rows).toHaveLength(3);
  // The number is a `::before` on the block, so it takes the block's weight.
  // Written on the `h1`..`h3` inside instead, the number kept BlockNote's 700
  // while a level-2 or level-3 title went to 600.
  for (const row of rows) {
    expect(row.marker, `level ${row.level}`).toBe(row.title);
  }
});

test('sets every number in figures of one width (#964)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('the first item');
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Shift+7`);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('the second item');
  await page.waitForTimeout(200);

  const gutters = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    return [...root.querySelectorAll('.bn-block-content[data-doc-number]')].map(
      (block) => ({
        number: block.getAttribute('data-doc-number'),
        numeric: getComputedStyle(block, '::before').fontVariantNumeric,
        gutter:
          block.querySelector('.bn-inline-content')!.getBoundingClientRect().left -
          block.getBoundingClientRect().left,
      }),
    );
  }, EDITOR);

  expect(gutters).toHaveLength(2);
  expect(gutters[0]!.numeric).toBe('tabular-nums');
  // Proportional figures gave `1.` an 18.4px box and `2.` a 21.5px one, so the
  // text down one list started at two different x's.
  expect(Math.abs(gutters[0]!.gutter - gutters[1]!.gutter)).toBeLessThan(0.5);
});

test('draws a bullet at one size whatever it nests under (#964)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('three');
  await page.waitForTimeout(300);

  const shapes = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    return [
      ...root.querySelectorAll('.bn-block-content[data-content-type="bulletListItem"]'),
    ].map((block) => {
      const before = getComputedStyle(block, '::before');
      return {
        level: block.getAttribute('data-bullet-level'),
        content: before.content,
        image: before.backgroundImage,
        size: before.backgroundSize,
      };
    });
  }, EDITOR);

  expect(shapes.map((shape) => shape.level)).toEqual(['0', '1', '2']);
  // The glyphs BlockNote cycles do not draw at one size in this face —
  // measured 5x5, 3x4 and 5x5 — so each level draws its shape into the same
  // 5px box instead of typing a character.
  for (const shape of shapes) {
    expect(shape.content, `level ${shape.level}`).toBe('""');
    expect(shape.image, `level ${shape.level}`).not.toBe('none');
  }
});

test('runs one unbroken rule down the side of a quote (#964)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('the first quoted line');
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+Shift+B`);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('the second quoted line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('the third quoted line');
  await page.waitForTimeout(300);

  const edges = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    // The element the rule is DRAWN on is what has to be continuous. It is
    // the block's wrapper, whose box contains the block's own margin — the
    // content element's does not, so reading that one measures a break the
    // rule does not have.
    return [...root.querySelectorAll('[data-quoted-run]')].map((wrapper) => {
      const box = wrapper.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        border: getComputedStyle(wrapper).borderInlineStartWidth,
      };
    });
  }, EDITOR);

  expect(edges).toHaveLength(3);
  // A gap between two of these boxes is a gap in the line: drawn on the
  // content element, a run of three painted three segments with two ~10px
  // breaks and read as a dashed line rather than as one quote.
  for (const edge of edges) {
    expect(edge.border).toBe('2px');
  }
  for (let i = 1; i < edges.length; i += 1) {
    expect(Math.abs(edges[i]!.top - edges[i - 1]!.bottom), `between ${String(i)}`).toBeLessThan(0.5);
  }
});

test('draws inline code on the same surface as a code block (#964)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('prose with `code` in it');
  await page.waitForTimeout(300);

  const surfaces = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-code-panel)';
    root.append(probe);
    const panel = getComputedStyle(probe).color;
    probe.remove();
    const code = root.querySelector('code')!;
    return { panel, chip: getComputedStyle(code).backgroundColor };
  }, EDITOR);

  // `--color-muted` is the recess and goes BELOW the page in dark, so a chip
  // drawn on it had no ground at all while the code block beside it read as a
  // plate. The two are one value in light, so this is what dark divides.
  expect(surfaces.chip).toBe(surfaces.panel);
});
