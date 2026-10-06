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
 *
 * A click that moves the caret is read back the same way.
 *
 * Both wait first for the editor's focus to settle: on taking the focus,
 * ProseMirror sets a 20ms timer that writes its own selection back into the page
 * whenever the page's differs from the one it last read (prosemirror-view
 * 1.42.2 `input.ts:835-845`). A click or key a script lands before that timer
 * runs, as a menu closes and hands the focus back, is undone by it (measured:
 * a click on an empty last line lost 11 times in 45; the timer ran as late as
 * 26ms after the focus).
 */
import { expect, type Locator, type Page } from 'playwright/test';
import { DOCUMENT_EDITOR as EDITOR } from './space';

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
 * Wait until the write-back ProseMirror scheduled when the editor last took
 * the focus has run. A timer due no earlier than it, set after it, runs after
 * it: timers run in the order they fall due, and in the order they were set
 * when due together; a timer already overdue still runs before a new one. A focus still on its way (a menu closing hands it back a
 * task later) is the caller's to wait for first.
 * @param p - The page.
 */
async function focusSettled(p: Page): Promise<void> {
  await p.evaluate(async (selector) => {
    const { view } = (document.querySelector(selector) as unknown as {
      editor: { view: { hasFocus: () => boolean; input: { lastFocus: number } } };
    }).editor;
    if (!view.hasFocus()) return;
    // Even once 20ms have passed the write-back may not have run yet: a busy
    // page runs a timer late. One set now still runs after it.
    const left = view.input.lastFocus + 20 - Date.now();
    await new Promise((settle) => setTimeout(settle, Math.max(0, left + 1)));
  }, EDITOR);
}

/**
 * Press a key and wait for the editor to read the browser's selection back.
 * @param p - The page.
 * @param key - The key.
 */
export async function pressAndSettle(p: Page, key: string): Promise<void> {
  await focusSettled(p);
  const before = await selectionOf(p);
  await p.keyboard.press(key);
  await expect.poll(() => selectionOf(p)).not.toBe(before);
}

/**
 * Click where the caret is to go and wait for the editor to read it back.
 * @param p - The page.
 * @param target - What to click.
 */
export async function clickAndSettle(p: Page, target: Locator): Promise<void> {
  await focusSettled(p);
  const before = await selectionOf(p);
  await target.click();
  await expect.poll(() => selectionOf(p)).not.toBe(before);
}
