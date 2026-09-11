// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one way a style is written to the body.
 *
 * Every control that puts a style on the selection comes through here — the
 * five marks the bar draws and both colour rows — so the rule that decides
 * what a press covers is stated once. That rule is the same walk the readings
 * use (`styleTheRuns`): the selection IS the range, and within it the runs of
 * text are what a style lands on.
 *
 * A caret is the exception, and not a rule of its own: it covers no range at
 * all, and its whole effect is the mark the next character will carry. That is
 * what BlockNote's `addStyles` and `removeStyles` do there, so a caret press
 * goes to them.
 */

import {
  markTypeOf,
  styleTheRuns,
} from '@web/spaces/document/document-style-range';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';

/**
 * Puts a style on every run the selection covers.
 * @param editor - The editor.
 * @param name - The style's name, which is also its mark's.
 * @param value - `true` for one of the five marks, a hue for a colour row.
 */
export function putStyle(
  editor: ToolEditor,
  name: string,
  value: true | string,
): void {
  const state = editor.prosemirrorState;
  const mark = markTypeOf(state, name);
  if (mark === undefined) {
    return;
  }
  const attrs = value === true ? null : { stringValue: value };
  const tr = styleTheRuns(state, mark, mark.create(attrs));
  if (tr === undefined) {
    editor.addStyles({ [name]: value } as never);
    return;
  }
  editor.prosemirrorView?.dispatch(tr);
}

/**
 * Takes the given styles off every run the selection covers.
 *
 * Several at once because the colour panel's reset button clears both rows,
 * and one transaction there is one press to undo.
 * @param editor - The editor.
 * @param names - The styles' names.
 */
export function dropStyles(
  editor: ToolEditor,
  ...names: readonly string[]
): void {
  const state = editor.prosemirrorState;
  if (state.selection.empty) {
    // `removeStyles` reads the keys and ignores the values.
    editor.removeStyles(
      Object.fromEntries(names.map((name) => [name, true])) as never,
    );
    return;
  }
  const tr = state.tr;
  for (const name of names) {
    const mark = markTypeOf(state, name);
    if (mark !== undefined) {
      styleTheRuns(state, mark, undefined, tr);
    }
  }
  editor.prosemirrorView?.dispatch(tr);
}
