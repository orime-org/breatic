// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A10: a selected media block is framed in the selection colour,
 * on the media itself, with no band behind the rest of its row.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postcss from 'postcss';
import { describe, it, expect } from 'vitest';

import { MEDIA_IN_SELECTION_CLASS } from '@web/spaces/document/document-selection-paint';

describe('a selected media block in the stylesheet', () => {
  it('outlines the media frame in the selection colour, one pixel wide, and paints no background', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf8');
    const decls = new Map<string, string>();
    postcss.parse(css).walkRules((rule) => {
      if (rule.selector.includes(`.${MEDIA_IN_SELECTION_CLASS}`)) {
        rule.walkDecls((decl) => {
          decls.set(`${rule.selector}|${decl.prop}`, decl.value);
        });
      }
    });

    const entries = [...decls.entries()];
    const outline = entries.find(([key]) => key.includes('[data-media-frame]') && key.endsWith('|outline'));
    expect(outline?.[1]).toBe('1px solid var(--color-status-selected)');
    expect(entries.some(([key]) => key.endsWith('|background-color'))).toBe(false);
  });
});
