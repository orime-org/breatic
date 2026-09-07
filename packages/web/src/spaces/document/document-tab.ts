// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tab and Shift-Tab, for every selection rather than for a caret alone.
 *
 * The move and the question of whether it is possible are the same call:
 * `nestBlock` reads `$from.blockRange($to)` and leaves the document alone when
 * the range has nowhere to go (`nestBlock.ts`, `startIndex === 0`). Asking a
 * separate question first is what put the two out of step — `canNestBlock`
 * resolves the block at `selection.anchor`, which is the end the drag started
 * from, so a backwards drag asked about one block and acted on another.
 *
 * The key is claimed either way. An unclaimed Tab is one the browser answers,
 * and the browser answers it by moving focus out of the editor: measured,
 * focus went from the editor to `BODY` and the next characters the reader
 * typed reached nothing. BlockNote's own source says the same —
 * `KeyboardShortcutsExtension.ts:958`, "Always returning true for tab key
 * presses ensures they're not captured by the browser. Otherwise, they blur
 * the editor".
 */

import { createExtension } from '@blocknote/core';

/** What the editor object offers this file. */
interface TabEditor {
  nestBlock: () => void;
  unnestBlock: () => void;
}

/**
 * The extension that binds Tab for the whole document.
 * @returns The extension, for the assembly to register.
 */
export const documentTabExtension = createExtension(() => ({
  key: 'document-tab',
  keyboardShortcuts: {
    Tab: ({ editor }: { editor: TabEditor }) => {
      editor.nestBlock();
      return true;
    },
    'Shift-Tab': ({ editor }: { editor: TabEditor }) => {
      editor.unnestBlock();
      return true;
    },
  },
}) as never);
