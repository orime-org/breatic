// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Helpers for the body of a Document Space: the blank beside the column, the
 * comment rail that narrows it, and the selection the editor holds.
 */

import { expect, type Page } from 'playwright/test';

import { DOCUMENT_EDITOR as EDITOR } from './space';

/** Where beside the body column a blank point is taken. */
export type BlankSide = 'left' | 'right' | 'rail';

/**
 * Opens the comment rail through the document menu.
 * @param p - The page.
 */
export async function openCommentRail(p: Page): Promise<void> {
  await p.getByTestId('doc-doc-menu-trigger').click();
  await p.getByTestId('doc-doc-menu-comments').click();
  await expect(p.getByTestId('doc-comment-rail')).toBeVisible();
}

/**
 * A point on the blank space beside the body column, level with its first
 * paragraph, checked to be blank.
 * @param p - The page.
 * @param side - Left or right of the column, or between it and the open comment rail.
 * @returns The point.
 */
export async function blankPoint(p: Page, side: BlankSide = 'left'): Promise<{ x: number; y: number }> {
  const point = await p.evaluate(
    ([selector, where]) => {
      const editor = document.querySelector(selector)!.getBoundingClientRect();
      const line = document.querySelector(`${selector} p`)!.getBoundingClientRect();
      const rail = document.querySelector('[data-testid="doc-comment-rail"]')?.getBoundingClientRect();
      const x =
        where === 'left' ? editor.left - 40 : where === 'right' ? editor.right + 40 : (editor.right + rail!.left) / 2;
      return { x, y: line.top + line.height / 2 };
    },
    [EDITOR, side] as const,
  );
  const blank = await p.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute('data-document-body-blank') ?? false,
    point,
  );
  expect(blank).toBe(true);
  return point;
}

/** The body's selection as the editor holds it, and the page's selected text. */
export interface BodySelection {
  /** The selection's class and, for a node selection, the node's type: `_NodeSelection:divider`. */
  readonly kind: string;
  /** What the page shows selected. */
  readonly text: string;
}

/**
 * Reads the body's selection.
 * @param p - The page.
 * @returns It.
 */
export async function bodySelection(p: Page): Promise<BodySelection> {
  return p.evaluate((selector) => {
    const el = document.querySelector(selector) as unknown as {
      editor: { state: { selection: { constructor: { name: string }; node?: { type: { name: string } } } } };
    };
    const { selection } = el.editor.state;
    return {
      kind: `${selection.constructor.name}:${selection.node?.type.name ?? ''}`,
      text: window.getSelection()?.toString() ?? '',
    };
  }, EDITOR);
}
