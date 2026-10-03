// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A13: a table is drawn in the product's tokens, both themes, with
 * none of the fixed colours BlockNote writes for it.
 */

import { describe, expect, it } from 'vitest';

import { COLOUR_HUES } from '@web/spaces/document/document-colour-run';

import { declarationsOf, ruleBody } from './index-css-rules';

describe('a table in the body', () => {
  it('fills a cell with the same tint a highlight uses, for every hue', () => {
    for (const hue of COLOUR_HUES) {
      expect(ruleBody(`[data-content-type='table'] [data-background-color='${hue}']`)).toContain(
        `background-color: var(--color-palette-${hue}-highlight)`,
      );
    }
  });

  it('draws its lines, its header, its selected cells and its resize line in tokens', () => {
    expect(ruleBody('[data-content-type=\'table\'] td')).toContain('border-color: var(--color-border)');
    expect(ruleBody('[data-content-type=\'table\'] th')).toContain('background-color: var(--color-accent)');
    expect(ruleBody('.selectedCell::after')).toContain('background: var(--color-selection)');
    expect(ruleBody('.column-resize-handle')).toContain('background-color: var(--color-ring)');
  });

  it('gives the library\'s handles no room around the table, since ours float', () => {
    const paddings = declarationsOf('[data-content-type=\'table\'] .tableWrapper', 'padding');
    expect(paddings.map(({ value }) => value)).toEqual(['0']);
  });
});
