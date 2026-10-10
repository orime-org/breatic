// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A11: a reader who may not write sees a media block and plays it,
 * and none of its controls. They hide on the body's own editability, which
 * ProseMirror writes as `contenteditable` on the surface: the controls are
 * drawn by a node view that is not rebuilt when that flips.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss, { type Rule } from 'postcss';
import { describe, it, expect } from 'vitest';

/**
 * The rules of `index.css` whose selector names the media controls.
 * @returns Those rules.
 */
function chromeRules(): Rule[] {
  const css = readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf8');
  const rules: Rule[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector.includes('[data-media-chrome]')) rules.push(rule);
  });
  return rules;
}

describe('the media controls in a body that is not editable (A11)', () => {
  it('are taken off the page', () => {
    const hiding = chromeRules().filter(
      (rule) =>
        /\.doc-body\[contenteditable=['"]false['"]\]/.test(rule.selector) &&
        rule.nodes.some(
          (decl) => decl.type === 'decl' && decl.prop === 'display' && decl.value === 'none',
        ),
    );

    expect(hiding).toHaveLength(1);
  });
});
