// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A3: the box a to-do carries is one we draw, sized to its row.
 *
 * BlockNote renders a bare `<input type="checkbox">` and styles only its
 * geometry, so left alone the box is whatever the browser draws — measured,
 * `appearance: auto`, 12 by 24, square corners, ticked in the operating
 * system's accent colour. `packages/web/CLAUDE.md` rules a control whose look
 * the browser or the OS paints out of this product.
 *
 * Two things are read off the stylesheet here rather than off a browser.
 *
 * The FIRST is that the rules exist at all and name our tokens. A browser
 * would say the same and cost a run of the smoke suite.
 *
 * The SECOND is the arithmetic, and this is the one that has bitten: the
 * holder has to come to 24, which is what BlockNote gives a bullet and a
 * number through `min-width: 24px`, or the text of a to-do starts further in
 * than the text of the list item above it. Measured in a browser at 16px wide
 * with margins of 4 and 8, that was 28 against 24. The three numbers are in
 * three declarations here, so the sum is what this reads.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/** The stylesheet, as it ships. */
const css = readFileSync(
  resolve(import.meta.dirname, '../../../index.css'),
  'utf8',
  // Comments out: a rule commented out still matches the selector search
  // below, so every case here would read a rule the browser never sees.
).replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The body of the one rule whose selector ends in the given text.
 * @param endsWith - The tail of the selector.
 * @returns That rule's declarations.
 * @throws {Error} When no rule, or more than one, matches.
 */
function ruleBody(endsWith: string): string {
  const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((match) =>
    match[1].trim().endsWith(endsWith),
  );
  if (found.length !== 1) {
    throw new Error(`${String(found.length)} rules end in ${endsWith}`);
  }
  return found[0][2];
}

/**
 * One length declared in a rule.
 * @param body - The rule's declarations.
 * @param property - Which one to read.
 * @returns Its value in pixels.
 * @throws {Error} When the rule does not declare it in pixels.
 */
function px(body: string, property: string): number {
  // A zero length carries no unit in CSS, so the suffix is optional.
  const found = new RegExp(`${property}:\\s*(-?[\\d.]+)(px)?[;\\s]`).exec(body);
  if (found === null) {
    throw new Error(`no ${property} in px`);
  }
  return Number(found[1]);
}

const TICK = '[data-content-type=\'checkListItem\'] > div > input';

describe('the box a to-do carries', () => {
  it('is drawn by us, not by the browser', () => {
    expect(ruleBody(TICK)).toContain('appearance: none');
  });

  it('takes its colours and its corner from our tokens', () => {
    const body = ruleBody(TICK);
    expect(body).toContain('var(--color-border)');
    expect(body).toContain('var(--color-background)');
    // The corner `components/ui/checkbox.tsx` uses, through `rounded-chrome`.
    expect(body).toContain('var(--radius-chrome)');
    const checked = ruleBody(
      '[data-content-type=\'checkListItem\'][data-checked=\'true\'] > div > input',
    );
    expect(checked).toContain('var(--color-primary)');
  });

  it('leaves the text where a bullet and a number leave theirs', () => {
    // The gutter belongs to the holder, so the text starts at 24 whatever the
    // box does inside it. It used to be the box's own margins that pushed the
    // text out, which left the box 4px from its own text where a bullet keeps
    // 12 (user 2026-09-07).
    const holder = ruleBody(
      '[data-content-type=\'checkListItem\'] > div',
    );
    // 24 is BlockNote's own `min-width` for a bullet's and a number's marker.
    expect(px(holder, 'min-width')).toBe(24);
    expect(ruleBody(TICK)).toMatch(/margin-inline:\s*0;/);
  });

  it('centres the tick on the box', () => {
    const box = ruleBody(TICK);
    const mark = ruleBody(
      '[data-content-type=\'checkListItem\'][data-checked=\'true\'] > div::after',
    );
    // The tick is placed from the HOLDER's edge while the box sits at its own
    // start margin inside it, so moving one moves the two apart.
    expect(px(mark, 'left')).toBe(
      px(box, 'margin-inline') + (px(box, 'width') - px(mark, 'width')) / 2,
    );
  });

  it('says a viewer cannot tick it', () => {
    // `appearance: none` takes away the grey the browser drew for a disabled
    // control, and BlockNote disables the input for a read-only editor.
    expect(ruleBody(`${TICK}:disabled`)).toContain('cursor: default');
    // The box and its tick dim together: the tick is drawn on the holder, so
    // fading only the input leaves a solid mark inside a faded box.
    const dimmed = ruleBody(
      '[data-content-type=\'checkListItem\'] > div:has(> input:disabled)',
    );
    // A fraction, so `opacity: 1` — which dims nothing — turns this red.
    expect(dimmed).toMatch(/opacity:\s*0?\.\d+/);
    expect(ruleBody(`${TICK}:hover:not(:disabled)`)).toContain(
      'var(--color-ring)',
    );
  });
});

describe('what the stylesheet says about the space below the last block', () => {
  it('says the indentation rule is not drawn', () => {
    // BlockNote paints one from `--bn-colors-side-menu`, a variable declared on
    // an element this Space does not render. Saying so is what keeps it a
    // decision rather than a substitution that happened to fail.
    expect(
      ruleBody('.bn-block-group .bn-block-outer::before'),
    ).toContain('border-left: none');
  });
});
