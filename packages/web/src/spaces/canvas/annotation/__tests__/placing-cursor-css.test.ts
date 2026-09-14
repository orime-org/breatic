// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The comment-bubble pointer the armed annotation tool puts on the board.
 *
 * Read as text rather than run, because the three ways a custom cursor fails
 * all fail SILENTLY — the pointer simply stays what it was, with nothing in
 * the console:
 *
 *   - an SVG sized only by `viewBox` has no intrinsic size, and the browser
 *     drops it
 *   - an image over 32x32 is not scaled down, it is ignored
 *   - a rule with no keyword at the end has nothing to fall back to when the
 *     image cannot be decoded
 *
 * Sources: MDN "Using URL values for the cursor property". None of the three
 * would turn a real-browser check red either — the pointer just never changes
 * — so they are pinned here, where the text can be read.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss from 'postcss';
import { describe, it, expect } from 'vitest';

/** The stylesheet, as text. */
const CSS = readFileSync(resolve(__dirname, '../../../../index.css'), 'utf8');

/** The scope class the canvas wrapper carries while the tool is armed. */
const SCOPE = '.canvas-placing-annotation';

/**
 * Every `cursor` declaration written under the armed-tool scope.
 * @returns The selector and cursor value of each such rule.
 */
function cursorRules(): { selector: string; cursor: string }[] {
  const found: { selector: string; cursor: string }[] = [];
  postcss.parse(CSS).walkRules((rule) => {
    if (!rule.selector.includes(SCOPE)) return;
    for (const node of rule.nodes) {
      if (node.type === 'decl' && node.prop === 'cursor') {
        found.push({ selector: rule.selector, cursor: node.value });
      }
    }
  });
  return found;
}

describe('the pointer the armed annotation tool shows', () => {
  /**
   * The rules to check, refusing to hand back an empty list.
   *
   * Every check below walks these; walking nothing passes every one of them,
   * which is how a suite goes green over a stylesheet that says nothing.
   * @returns The armed-scope cursor rules, at least one.
   * @throws {Error} When the stylesheet carries none.
   */
  function rules(): { selector: string; cursor: string }[] {
    const found = cursorRules();
    if (found.length === 0) {
      throw new Error(`index.css writes no cursor under ${SCOPE}`);
    }
    return found;
  }

  it('is written at all', () => {
    expect(rules().length).toBeGreaterThan(0);
  });

  it('carries an image with a natural size, so the browser keeps it', () => {
    for (const { selector, cursor } of rules()) {
      expect(cursor, selector).toContain('url(');
      // Both attributes, not just `viewBox`: an SVG with only a viewBox is
      // the one that is silently dropped.
      expect(cursor, selector).toMatch(/width='\d+'/);
      expect(cursor, selector).toMatch(/height='\d+'/);
    }
  });

  it('keeps the image within the 32x32 every platform accepts', () => {
    for (const { selector, cursor } of rules()) {
      for (const [, size] of cursor.matchAll(/(?:width|height)='(\d+)'/g)) {
        expect(Number(size), selector).toBeLessThanOrEqual(32);
      }
    }
  });

  it('names a hotspot and a keyword to fall back on', () => {
    for (const { selector, cursor } of rules()) {
      // `url(...) x y, keyword` — the two numbers are the point the pointer
      // aims at, the keyword is what shows if the image cannot be decoded.
      expect(cursor, selector).toMatch(/\)\s+\d+\s+\d+\s*,\s*[a-z-]+\s*$/);
    }
  });

  it('covers the same board the drop listener does, in one rule', () => {
    // Named piece by piece the list was short every time — the pane and the
    // nodes, then the edges, then the rectangle a marquee leaves over the
    // board, each found by a round of its own. `CanvasSpace` asks whether the
    // click landed inside `.react-flow__renderer`; the pointer says where it
    // may land, so it has to mean the same thing or one of them is lying.
    const selectors = rules().map((rule) => rule.selector);
    for (const selector of selectors) {
      for (const part of selector.split(',')) {
        expect(part.trim(), selector).toMatch(
          /^\.canvas-placing-annotation \.react-flow__renderer( \*)?$/,
        );
      }
    }
  });

  it('carries the pointer onto what the board holds, not just its box', () => {
    // The children bring cursors of their own — a node says "drag me", a wire
    // says "click me" — so the descendant half is what actually reaches them.
    const selectors = rules().map((rule) => rule.selector);
    expect(
      selectors.some((s) => s.includes('.react-flow__renderer *')),
    ).toBe(true);
  });
});
