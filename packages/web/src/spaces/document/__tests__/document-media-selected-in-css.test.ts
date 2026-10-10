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

describe('a selected or hovered media block in the stylesheet', () => {
  it('outlines the media frame in the link colour, one pixel wide, and paints no background', () => {
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
    expect(outline?.[1]).toBe('1px solid var(--color-content-link)');
    expect(entries.some(([key]) => key.endsWith('|background-color'))).toBe(false);
  });

  it('draws the same frame on the block the pointer is on', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf8');
    let hovered: string | undefined;
    let selected: string | undefined;
    postcss.parse(css).walkRules((rule) => {
      rule.walkDecls('outline', (decl) => {
        rule.selectors.forEach((selector) => {
          if (selector.includes('[data-hovered=\'true\']') && selector.includes('[data-media-frame]')) hovered = decl.value;
          if (selector.includes(`.${MEDIA_IN_SELECTION_CLASS}`) && selector.includes('[data-media-frame]')) selected = decl.value;
        });
      });
    });

    expect(hovered).toBeDefined();
    expect(hovered).toBe(selected);
  });

  it('draws the same frame on the block the reader selected, only in a body the reader can edit', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf8');
    let own: { selector: string; outline: string } | undefined;
    postcss.parse(css).walkRules((rule) => {
      rule.walkDecls('outline', (decl) => {
        const selector = rule.selectors.find((s) => s.includes('[data-selected=\'true\']') && s.includes('[data-media-frame]'));
        if (selector !== undefined) own = { selector, outline: decl.value };
      });
    });

    expect(own?.outline).toBe('1px solid var(--color-content-link)');
    // A viewer's body hides the knobs and the toolbar and never takes the
    // focus that would let the selection go.
    expect(own?.selector).toContain('[contenteditable=\'true\']');
  });

  it('draws each corner knob as an 8px dot in the middle of its 24px target', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../../index.css'), 'utf8');
    const decls = new Map<string, string>();
    postcss.parse(css).walkRules((rule) => {
      if (rule.selector === '.doc-body [data-media-knob]::after') {
        rule.walkDecls((decl) => {
          decls.set(decl.prop, decl.value);
        });
      }
    });

    expect(decls.get('inset')).toBe('8px');
    expect(decls.get('border')).toBe('1px solid var(--color-content-link)');
  });
});
