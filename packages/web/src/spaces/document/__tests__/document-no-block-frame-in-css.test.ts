// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * This Space draws no frame around a node-selected block (user 2026-09-18).
 *
 * The frame was added 2026-08-16 for A5 of the selection design, because
 * Cmd-clicking a block node-selected it and nothing showed. That gesture was
 * removed on 2026-09-18 (A11.3), so nothing a reader does makes a selection
 * for it to draw. What was left were the selections the machinery makes for
 * its own reasons — the one `blockDragStart` puts on a row it carries, and the
 * one ProseMirror falls back to when a modifier-click LANDS ON A LINK in a
 * read-only body (this Space declines those presses so BlockNote's link
 * handler can take them, and that handler declines in turn while the body is
 * not editable — `clickHandler.ts:26-28` — leaving nobody to answer) — and
 * both of those painted a frame around a block the reader never selected. The
 * display logic is gone rather than each path being chased.
 *
 * A STYLESHEET ASSERTION, because the path the remaining rules answer cannot
 * be driven here: the library's marker reaches a block only while the class is
 * on (or inside) its `.bn-block-content`, which is where `selectClickedNode`
 * leaves it — measured 2026-09-18 on a modifier-click, back when that gesture
 * still made a node selection. The drag puts it on `div.bn-block-outer`
 * instead, which no marker selector of theirs matches, so the smoke that
 * measures a dragged row (`document-editor-styles.spec.ts`) pins the promise
 * and not these rules. What this file holds is that the rules are still here
 * and still draw nothing; a rule coming back would come back silently.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/** The class ProseMirror puts on a node-selected element. */
const SELECTED = 'ProseMirror-selectednode';

/** The stylesheet, read per case so a rule coming back cannot pass unseen. */
function stylesheet(): string {
  return readFileSync(
    resolve(import.meta.dirname, '../../../index.css'),
    'utf8',
  );
}

/** One declaration inside a rule. */
interface Declaration {
  /** The property, longhand spelling and all. */
  readonly property: string;
  /** What it is set to. */
  readonly value: string;
}

/** A rule of the stylesheet that names the class. */
interface Rule {
  /** Its selector list, as written. */
  readonly selector: string;
  /** What it sets. */
  readonly declarations: readonly Declaration[];
}

/**
 * Every rule whose selector list names the node-selection class.
 * @param css - The stylesheet.
 * @returns One entry per rule.
 */
function rulesNaming(css: string): Rule[] {
  const found: Rule[] = [];
  let at = css.indexOf(SELECTED);
  while (at !== -1) {
    const opens = css.indexOf('{', at);
    const closes = css.indexOf('}', opens);
    const startsAt = css.lastIndexOf('}', at) + 1;
    const commentEnds = css.lastIndexOf('*/', at) + 2;
    found.push({
      selector: css.slice(Math.max(startsAt, commentEnds), opens).trim(),
      declarations: css
        .slice(opens + 1, closes)
        .split(';')
        .map((one) => one.split(':'))
        .filter((parts) => parts.length > 1)
        .map(([property, ...rest]) => ({
          property: (property ?? '').trim(),
          value: rest.join(':').trim(),
        })),
    });
    at = css.indexOf(SELECTED, closes === -1 ? at + 1 : closes);
  }
  return found;
}

/**
 * What a declaration may be set to on a node-selected block.
 *
 * A WHITELIST OF VALUES, not a blacklist of properties. Naming the properties
 * that draw a frame leaves every longhand spelling of them open —
 * `outline-width` / `outline-color` / `background` / `border-inline-start` all
 * draw one and none of them is `outline:` or `background-color:`. Asking
 * instead that whatever is set amounts to nothing shown leaves no spelling to
 * find.
 */
const SHOWS_NOTHING = /^(none|transparent|0)$/;

describe('a node-selected block', () => {
  it('has the rules that turn the library’s own marker off', () => {
    // WITHOUT THIS CASE THE TWO BELOW ARE VACUOUS: they walk the rules naming
    // the class, and deleting every such rule leaves nothing to walk — which
    // is exactly the regression they are supposed to catch, since the library
    // ships a `#64a0ff` wash with a 4px inset ring on that block and these
    // rules are what turns it off. Measured 2026-09-18: deleting the rule left
    // the file green.
    const selectors = rulesNaming(stylesheet()).map((rule) => rule.selector);
    expect(selectors).toHaveLength(1);
    expect(selectors[0]).toContain(`.${SELECTED}::after`);
    expect(selectors[0]).toContain(`.${SELECTED} > *::after`);
  });

  it('is drawn nothing by any of them', () => {
    for (const rule of rulesNaming(stylesheet())) {
      for (const { property, value } of rule.declarations) {
        expect(value, `${rule.selector} { ${property} }`).toMatch(
          SHOWS_NOTHING,
        );
      }
    }
  });
});
