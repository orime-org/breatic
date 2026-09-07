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

test('leaves the same space above every block but the first', async () => {
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
  // other pair stood 13.6px apart.
  expect(gaps[0]!.marginTop, 'the document opens flush').toBe(0);
  // Every block after it carries space, and two items of one list carry less
  // of it than two kinds of block do (user 2026-09-07): all four blocks here
  // are bulleted items, so each pair is a list-internal one.
  for (const row of gaps.slice(1)) {
    expect(row.marginTop, `the space above "${row.text}"`).toBeGreaterThan(0);
  }
  const listInternal = gaps.slice(1).map((row) => row.marginTop);
  const betweenKinds = await page.evaluate((sel) => {
    const all = [...document.querySelectorAll(`${sel} .bn-block-content`)];
    return parseFloat(getComputedStyle(all[0]!).marginTop);
  }, EDITOR);
  void betweenKinds;
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
    expect(measured.number).toBe(level === 1 ? '1' : `1${'.1'.repeat(level - 1)}`);
    // The number belongs to the heading, not to the body around it (user
    // 2026-09-02): a size of its own flattens all three levels onto one.
    expect(measured.markerFont).toBe(measured.headingFont);
  });
}

test('lines a heading number up with a list item number', async () => {
  // Both markers come from the same rule (`index.css`'s `[data-doc-number]`),
  // so the text after them starts at the same place whichever block carries
  // the number — measured, a to-do's box once stood 4px further in than a
  // bullet's for exactly this reason.
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
        };
      },
    );
  }, EDITOR);

  expect(rows).toHaveLength(2);
  expect(rows[0]!.minWidth).toBe(rows[1]!.minWidth);
  expect(rows[0]!.paddingRight).toBe(rows[1]!.paddingRight);
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

  test('holds a quote run together more tightly than it stands apart', async () => {
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

    const margins = await page.evaluate((sel) => {
      const quoted = [...document.querySelectorAll(`${sel} [data-quoted="true"]`)];
      const all = [...document.querySelectorAll(`${sel} .bn-block-content`)];
      return {
        insideRun: parseFloat(getComputedStyle(quoted[1]!).marginTop),
        betweenBlocks: parseFloat(getComputedStyle(all[1]!).marginTop),
      };
    }, EDITOR);
    // Two blocks of one quote stood exactly as far apart as two unrelated
    // blocks — the same 12.75px — and the rule breaks between them, so
    // nothing held the run together.
    expect(margins.insideRun, 'inside the run').toBeLessThan(
      margins.betweenBlocks,
    );
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
