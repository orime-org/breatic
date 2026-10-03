// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pressing a key that moves the browser's own selection, in a Document Space.
 *
 * The browser moves its selection for an arrow key and ProseMirror reads it
 * back on `selectionchange`, which fires later. A script pressing the next key
 * in the same instant runs ahead of that read — measured, a Backspace pressed
 * straight after five arrows acted on a caret that had not arrived yet, and a
 * Cmd+B pressed straight after three Shift+ArrowLeft bolded one letter of the
 * three — so the press waits until the editor's selection has moved.
 */
import { expect, type Page } from 'playwright/test';

/** The body's editable element. */
const EDITOR = '[data-testid="document-space"] .ProseMirror';

/**
 * The editor's own selection, as text.
 * @param p - The page.
 * @returns The selection's JSON.
 */
function selectionOf(p: Page): Promise<string> {
  return p.evaluate(
    (selector) =>
      JSON.stringify(
        (document.querySelector(selector) as unknown as {
          editor: { state: { selection: { toJSON: () => unknown } } };
        }).editor.state.selection.toJSON(),
      ),
    EDITOR,
  );
}

/**
 * Press a key and wait for the editor to read the browser's selection back.
 * @param p - The page.
 * @param key - The key.
 */
export async function pressAndSettle(p: Page, key: string): Promise<void> {
  const before = await selectionOf(p);
  await p.keyboard.press(key);
  await expect.poll(() => selectionOf(p)).not.toBe(before);
}
