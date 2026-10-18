// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A13: a table is drawn in the product's tokens, both themes, with
 * none of the fixed colours BlockNote writes for it.
 */

import { describe, expect, it } from 'vitest';

import { COLOUR_HUES } from '@web/spaces/document/document-colour-run';

import { declarationsOf, ruleBody, selectorEndingIn } from './index-css-rules';

describe('a table in the body', () => {
  it('draws the table whose cells hold blocks with lines round every cell and bold header cells', () => {
    expect(ruleBody('.doc-body [data-node-type=\'docTable\'] table')).toContain('width: auto !important');
    for (const tail of ['td', 'th']) {
      const body = ruleBody(`.doc-body [data-node-type='docTable'] ${tail}`);
      expect(body).toContain('border-style: solid');
      expect(body).toContain('border-width: 1px');
    }
    expect(ruleBody('.doc-body [data-node-type=\'docTable\'] th')).toContain('font-weight: bold');
  });

  it('shows a picture or video in a cell no wider than the cell, and keeps it out of its column\'s width (inner#1619 T7)', () => {
    for (const tail of ['td', 'th']) {
      const body = ruleBody(`.doc-body [data-node-type='docTable'] ${tail} [data-media-box]`);
      expect(body).toContain('contain: inline-size');
      expect(body).toContain('width: min(var(--doc-media-width, 100%), 100%) !important');
    }
  });

  it('pads a cell that holds blocks as any table cell, its blocks\' strips standing outside it (inner#1619 T13)', () => {
    expect(declarationsOf('[data-node-type=\'docTable\']', 'padding-left')).toEqual([]);
    for (const tail of ['td', 'th']) {
      expect(ruleBody(`.doc-body [data-node-type='docTable'] ${tail}`)).toContain('padding: var(--space-3) var(--space-5)');
      // A cell is a small body: its first block stands flush, as the document's does.
      expect(
        ruleBody(`.doc-body [data-node-type='docTable'] ${tail} > .bn-block-outer:first-child > .bn-block > .bn-block-content`),
      ).toContain('--doc-block-lift: 0px');
    }
  });

  it('fills a cell with the same tint a highlight uses, for every hue', () => {
    for (const hue of COLOUR_HUES) {
      for (const cell of [
        `[data-content-type='table'] [data-background-color='${hue}']`,
        `[data-node-type='docTable'] td[data-background-color='${hue}']`,
        `[data-node-type='docTable'] th[data-background-color='${hue}']`,
      ]) {
        expect(ruleBody(cell)).toContain(`background-color: var(--color-palette-${hue}-highlight)`);
      }
    }
  });

  it('draws its lines, its header, its selected cells and its resize line in tokens', () => {
    expect(ruleBody('.doc-body [data-content-type=\'table\'] td')).toContain('border-color: var(--color-border)');
    // The space around a cell's words is on the space scale: 6px above and
    // below, 10px either side.
    expect(ruleBody('.doc-body [data-content-type=\'table\'] td')).toContain('padding: var(--space-3) var(--space-5)');
    expect(ruleBody('.doc-body [data-content-type=\'table\'] th')).toContain('padding: var(--space-3) var(--space-5)');
    expect(ruleBody('.doc-body [data-content-type=\'table\'] th')).toContain('background-color: var(--color-muted)');
    // The table whose cells hold blocks shares every one of these rules.
    for (const tail of ['td', 'th']) {
      expect(selectorEndingIn(`.doc-body [data-node-type='docTable'] ${tail}`)).toBe(
        selectorEndingIn(`.doc-body [data-content-type='table'] ${tail}`),
      );
    }
    expect(ruleBody('.doc-body .selectedCell::after')).toContain('background: var(--color-selection)');
    expect(ruleBody('.column-resize-handle')).toContain('background-color: var(--color-ring)');
  });

  it('paints a selected cell behind its words, the way selected text is painted', () => {
    // The library's tint is a layer over the whole cell at z-index 2; the
    // cell's line of words goes above it, so they keep their own colour. Only
    // the line: the column-resize line is also a child of the cell, and it is
    // drawn by being absolutely placed.
    expect(() => ruleBody('.doc-body .selectedCell > *')).toThrow();
    const body = ruleBody('.doc-body .selectedCell > p');
    expect(body).toContain('position: relative');
    expect(body).toContain('z-index: 3');
    // A cell that holds blocks raises its blocks the same way.
    expect(selectorEndingIn('.selectedCell > .bn-block-outer')).toBe(selectorEndingIn('.selectedCell > p'));
  });

  it('paints the cells a row or column menu acts on the way selected cells are painted (A6)', () => {
    // One rule for both, so the two can never look different.
    expect(selectorEndingIn('.doc-table-target::after')).toBe(selectorEndingIn('.doc-body .selectedCell::after'));
    expect(selectorEndingIn('.doc-table-target > p')).toBe(selectorEndingIn('.selectedCell > p'));
    // The library draws the layer for `.selectedCell` only, so the shared
    // rule draws it whole.
    const layer = ruleBody('.doc-table-target::after');
    expect(layer).toContain('content: \'\'');
    expect(layer).toContain('position: absolute');
    expect(layer).toContain('inset: 0');
    expect(layer).toContain('z-index: 2');
    expect(layer).toContain('pointer-events: none');
  });

  it('draws no selected cells while an editable body does not hold the focus (inner#1127 A21)', () => {
    expect(ruleBody(':not([data-body-holds]) .selectedCell::after')).toContain('content: none');
  });

  it('lets a table whose every column has a stored width grow to the sum of its columns (A12)', () => {
    // The library's own rule pins every table to \`width: auto !important\`,
    // so the width prosemirror-tables writes onto a fully sized table never
    // lands; a floor of the table's own max-content width does.
    const body = ruleBody('table:not(:has(td:not([colwidth]))):not(:has(th:not([colwidth])))');
    expect(body).toContain('min-width: max-content');
    expect(selectorEndingIn('table:not(:has(td:not([colwidth]))):not(:has(th:not([colwidth])))')).toContain(
      '[data-node-type=\'docTable\']',
    );
  });

  it('keeps room under the table for its scrollbar, and none on the other sides', () => {
    // A wide table's scrollbar lies along the bottom of its frame; the room
    // keeps it under the last row rather than over it. The row and column
    // handles are drawn in the library's portal, centred on the table's lines.
    const paddings = declarationsOf('[data-content-type=\'table\'] .tableWrapper', 'padding');
    expect(paddings.map(({ value }) => value)).toEqual(['0 0 0.5rem 0']);
    expect(declarationsOf('[data-node-type=\'docTable\'] .tableWrapper', 'padding').map(({ value }) => value)).toEqual([
      '0 0 0.5rem 0',
    ]);
  });

  it('lets presses through the library box a moved row or column handle leaves behind', () => {
    // The handle is always translated, centred on its line and onto the part
    // of the table in view; the box the library places it in stays where it
    // was and must not take a press.
    expect(ruleBody('div:has(> .doc-table-handle)')).toContain('pointer-events: none');
    expect(ruleBody('.doc-table-handle')).toContain('pointer-events: auto');
  });

  it('draws the edge of a side with more to scroll in tokens, and lets presses through it (A21)', () => {
    const edge = ruleBody('.doc-table-overflow-edge');
    expect(edge).toContain('pointer-events: none');
    expect(edge).toContain('opacity: 0');
    expect(ruleBody('.doc-table-overflow-edge[data-on]')).toContain('opacity: 1');
    for (const side of ['left', 'right']) {
      const body = ruleBody(`.doc-table-overflow-edge[data-overflow-edge='${side}']`);
      expect(body).toContain(`border-${side}: 1px solid var(--color-border)`);
      expect(body).toContain('var(--overflow-shade)');
    }
  });

  it('draws where a dragged row or column lands the way a dragged block\'s line is drawn', () => {
    for (const [name, shadow] of [
      ['row-before', '0 2px 0'],
      ['row-after', '0 -2px 0'],
      ['column-before', '2px 0 0'],
      ['column-after', '-2px 0 0'],
    ]) {
      expect(ruleBody(`.doc-table-drop-${name}`)).toContain(
        `box-shadow: inset ${shadow} var(--color-status-selected)`,
      );
    }
  });
});
