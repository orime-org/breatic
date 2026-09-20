// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the bubble bar writes a style to the body.
 *
 * The five marks and both colour rows come through here, so the rule that
 * decides what a press covers is stated once: the selection IS the range, and
 * within it the runs of text are what a style lands on (`styleTheRuns`, the
 * same walk the readings use).
 *
 * The rule holds for writers that never see this module —  tiptap's own
 * chords, `applyLink` — through `document-marks-on-text.ts`, which reads the
 * document every writer produces.
 */

import type { ColourHue } from '@web/spaces/document/document-colour-run';
import type { Selection } from '@tiptap/pm/state';

import {
  markTypeOf,
  styleTheRuns,
} from '@web/spaces/document/document-style-range';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';

/**
 * Puts a style on, or takes it off, every run the selection covers.
 *
 * Several styles at once because the colour panel's reset button clears both
 * rows, and one transaction there is one press to undo.
 * @param editor - The editor.
 * @param value - `true` for one of the five marks, a {@link ColourHue} for a
 *   colour row, or nothing to take the styles off.
 * @param names - The styles' names, each also its mark's.
 * @param range - The range to write over, where the press names one. Left out,
 *   it is the reader's own selection.
 */
export function writeStyle(
  editor: ToolEditor,
  value: true | ColourHue | undefined,
  names: readonly string[],
  range?: Selection,
): void {
  const state = editor.prosemirrorState;
  if ((range ?? state.selection).empty) {
    // THE BLOCK HANDLE'S PATH NEVER REACHES THE TWO CALLS BELOW. They are
    // BlockNote's `setMark` / `unsetMark`, which take no range at all and act
    // on the editor's own selection and stored marks — so a block-scoped press
    // landing here would change what the READER types next and leave the block
    // untouched. An explicit range that is empty is an empty block, which has
    // no run to style, so nothing is written.
    if (range !== undefined) {
      return;
    }
    // A caret covers no range, and its whole effect is the mark the next
    // character will carry. That is what these two do.
    const pairs = Object.fromEntries(
      names.map((name) => [name, value ?? true]),
    ) as never;
    if (value === undefined) {
      editor.removeStyles(pairs);
    } else {
      editor.addStyles(pairs);
    }
    return;
  }
  // `transact` sends a transaction only where something was written into it,
  // which is what keeps a press with nothing to do off the undo stack.
  editor.transact((tr) => {
    for (const name of names) {
      // The names are compile-time constants from the tool list, and the
      // caret branch above hands them straight to BlockNote, which throws on
      // one its schema does not know. Skipping one here would hide the same
      // build error on the other half of the same press.
      const mark = markTypeOf(state, name)!;
      const attrs = value === true ? null : { stringValue: value };
      styleTheRuns(
        state,
        mark,
        value === undefined ? undefined : mark.create(attrs),
        tr,
        range,
      );
    }
  });
}
