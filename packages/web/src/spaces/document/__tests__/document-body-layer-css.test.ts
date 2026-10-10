// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document body's rules sit in `@layer components` (inner#1127).
 *
 * An unlayered rule beats every utility a component writes on its own
 * element, and the body now holds elements that carry utilities (the media
 * toolbar, its resize knobs, the caption field and caption, the picture and
 * its skeleton, the audio and video player, the upload placeholders). Two
 * kinds of rule stay outside, each meeting an unlayered rule that
 * `@tiptap/core` injects (`style.ts`), to which any layered rule loses:
 * the `::selection` rules and the gap cursor's colour.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss, { type AtRule, type Node as CssNode, type Rule } from 'postcss';
import { describe, it, expect } from 'vitest';

/** A selector naming the body's own class, not `.doc-body-editor` and the like. */
const BODY = /\.doc-body(?![-\w])/;

/** The rules allowed outside the layer, and why each is listed above. */
const OUTSIDE = /::selection|\.ProseMirror-gapcursor::after/;

/**
 * Every top-level `.doc-body` rule with the layer it sits in.
 * @returns The selector and its layer, or null when unlayered.
 */
function bodyRules(): { selector: string; layer: string | null }[] {
  const sheet = readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf8');
  const found: { selector: string; layer: string | null }[] = [];
  postcss.parse(sheet).walkRules((rule: Rule) => {
    if (!BODY.test(rule.selector) || rule.parent?.type === 'rule') return;
    let layer: string | null = null;
    for (let at: CssNode | undefined = rule.parent; at !== undefined; at = at.parent as CssNode | undefined) {
      if (at.type === 'atrule' && (at as AtRule).name === 'layer') layer = (at as AtRule).params;
    }
    found.push({ selector: rule.selector, layer });
  });
  return found;
}

describe('the document body stylesheet', () => {
  it('puts every body rule in the components layer but the two kinds that meet TipTap\'s rules', () => {
    const rules = bodyRules();
    expect(rules.length).toBeGreaterThan(90);
    const misplaced = rules.filter(
      (r) => (OUTSIDE.test(r.selector) ? r.layer !== null : r.layer !== 'components'),
    );
    expect(misplaced).toEqual([]);
  });

  it('keeps the selection rules and the gap cursor rule outside every layer', () => {
    const outside = bodyRules().filter((r) => r.layer === null);
    expect(outside.map((r) => r.selector.replace(/\s+/g, ' '))).toEqual([
      '.doc-body ::selection',
      '.doc-body[contenteditable=\'true\']:not([data-body-holds]) ::selection, .doc-body[contenteditable=\'true\']:not([data-body-holds])::selection',
      '.doc-body .ProseMirror-gapcursor::after',
      '.doc-body .doc-empty-line-in-selection ::selection',
    ]);
  });
});
