// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 acceptance A12: what pressing the plus on a row does before the insert
 * menu opens.
 *
 * The menu needs a caret it can open at and a place for the query the reader
 * types. An empty paragraph already is that place; every other row needs one
 * made below it, and what that new block carries decides whether the reader's
 * next choice lands where they pointed.
 */

import { describe, it, expect } from 'vitest';

import { insertPlanFor } from '@web/spaces/document/document-insert-plan';

/**
 * A block shaped the way BlockNote hands one to the side menu.
 * @param over - What to set on this block.
 * @returns The block.
 */
function block(over: {
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown[];
  children?: unknown[];
}): Parameters<typeof insertPlanFor>[0] {
  return {
    type: over.type ?? 'paragraph',
    props: over.props ?? { quoted: false },
    content: over.content ?? [],
    children: over.children ?? [],
  } as Parameters<typeof insertPlanFor>[0];
}

describe('what the plus does to the row it was pressed on', () => {
  it('opens in place on an empty paragraph', () => {
    expect(insertPlanFor(block({})).where).toBe('inPlace');
  });

  // An empty heading is as empty on screen as an empty paragraph, and the menu
  // opens in it just as well, so the row the reader pointed at becomes what
  // they choose instead of a leftover empty heading above a new row.
  it('opens in place on an empty heading', () => {
    expect(insertPlanFor(block({ type: 'heading' })).where).toBe('inPlace');
  });

  it('makes a row below one that has text', () => {
    expect(insertPlanFor(block({ content: [{ type: 'text' }] })).where).toBe(
      'below',
    );
  });

  // `SuggestionMenu.ts:257-260` drops every transaction whose selection sits in
  // a code block, so a menu asked to open there never appears. The caret has to
  // leave the block first.
  it('makes a row below an empty code block', () => {
    expect(insertPlanFor(block({ type: 'codeBlock' })).where).toBe('below');
  });

  it('carries the quote the pressed row sits in', () => {
    const plan = insertPlanFor(
      block({ content: [{ type: 'text' }], props: { quoted: true } }),
    );
    expect(plan.where).toBe('below');
    expect(plan.props).toEqual({ quoted: true });
  });

  it('leaves a row outside a quote outside it', () => {
    const plan = insertPlanFor(block({ content: [{ type: 'text' }] }));
    expect(plan.props).toEqual({ quoted: false });
  });
});
