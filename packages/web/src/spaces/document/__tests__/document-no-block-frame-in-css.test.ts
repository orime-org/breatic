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
 * one ProseMirror falls back to when no plugin answers a modifier-click in a
 * read-only body — and both of those painted a frame around a block the reader
 * never selected. The display logic is gone rather than each path being
 * chased.
 *
 * A stylesheet assertion, because there is nothing left to drive in a browser:
 * the point is that no rule exists, and a rule that comes back would come back
 * silently.
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

/**
 * Every rule whose selector list names the node-selection class.
 * @param css - The stylesheet.
 * @returns One entry per rule: its selector and what it declares.
 */
function rulesNaming(css: string): { selector: string; declares: string }[] {
  const found: { selector: string; declares: string }[] = [];
  let at = css.indexOf(SELECTED);
  while (at !== -1) {
    const opens = css.indexOf('{', at);
    const closes = css.indexOf('}', opens);
    const startsAt = css.lastIndexOf('}', at) + 1;
    const commentEnds = css.lastIndexOf('*/', at) + 2;
    found.push({
      selector: css.slice(Math.max(startsAt, commentEnds), opens).trim(),
      declares: css.slice(opens + 1, closes),
    });
    at = css.indexOf(SELECTED, closes === -1 ? at + 1 : closes);
  }
  return found;
}

describe('a node-selected block', () => {
  it('is given no outline by any rule', () => {
    for (const rule of rulesNaming(stylesheet())) {
      expect(rule.declares, rule.selector).not.toMatch(/outline\s*:/);
    }
  });

  it('is given no background, ring or overlay by any rule', () => {
    for (const rule of rulesNaming(stylesheet())) {
      // The library ships a `#64a0ff` wash with an inset ring on the same
      // block, so the rules that stay are the ones turning that off.
      expect(rule.declares, rule.selector).not.toMatch(
        /box-shadow\s*:(?!\s*none)|background-color\s*:(?!\s*transparent)/,
      );
      expect(rule.declares, rule.selector).not.toMatch(
        /content\s*:(?!\s*none)/,
      );
    }
  });
});
