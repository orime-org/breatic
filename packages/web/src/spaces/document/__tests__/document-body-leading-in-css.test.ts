// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The body's leading has one home.
 *
 * Five rules set a line height on the reading surface — the body itself, the
 * three heading levels and the code panel — and each carried its own literal.
 * The one property that most defines a reading surface was the only number in
 * this block with no name, beside `--doc-paragraph-margin`,
 * `--doc-indent-step`, `--doc-block-lift` and `--doc-block-drop`, which were
 * all named for the same reason: a number two rules need cannot be allowed to
 * drift.
 *
 * The cases read the family rather than the five rules by name. A sixth rule
 * that sets a line height on this surface has to take a name too, and naming
 * the five individually here would let that sixth one through.
 *
 * `.chat-markdown` is a separate surface and keeps its own values — the agent's
 * area and the body do not share styling (memory, 2026-08).
 */

import { describe, it, expect } from 'vitest';

import { declarationsOf } from '@web/spaces/document/__tests__/index-css-rules';

/** The scope every rule on the reading surface is written under. */
const BODY = '.doc-body-editor';

/** The five kinds of line the surface sets a height for. */
const KINDS = ['body', 'h1', 'h2', 'h3', 'code'];

describe('the body’s leading', () => {
  it('is named on the surface, once per kind', () => {
    for (const kind of KINDS) {
      const declared = declarationsOf(BODY, `--doc-leading-${kind}`);
      expect(declared.length, `--doc-leading-${kind}`).toBe(1);
    }
  });

  it('is read by name in every rule that sets one', () => {
    const set = declarationsOf(BODY, 'line-height');
    expect(set.length).toBeGreaterThanOrEqual(5);
    for (const { selector, value } of set) {
      expect(value, selector).toMatch(/^var\(--doc-leading-[a-z0-9]+\)$/);
    }
  });
});
