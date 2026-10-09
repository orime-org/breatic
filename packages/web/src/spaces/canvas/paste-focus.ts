// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { isEditableTarget } from '@web/lib/is-editable-target';

/** What the canvas looked like when a paste began, and what it looks like now. */
export interface PasteFocusState {
  /** The selected node ids when the paste began, as one key. */
  selectionBefore: string;
  /** The selected node ids now, as the same kind of key. */
  selectionNow: string;
  /** The selection the canvas last set itself (an earlier paste's copies), if any. */
  ownSelection: string | null;
  /** The element holding the keyboard when the paste began. */
  activeBefore: Element | null;
  /** The element holding the keyboard now. */
  active: Element | null;
  /** The canvas container. */
  canvas: Element | null;
}

/**
 * Whether the reader went on to something else while a paste waited on the
 * server (inner#1349 A12). A paste selects its copies and gives them the
 * keyboard only while the reader is still where the paste left them: typing
 * in a field, moving the keyboard to something else outside the canvas, or a
 * selection of their own each mean they moved on. What the canvas did itself
 * is not the reader moving on: a menu still holding the keyboard while it
 * closes, the keyboard back on the page after it closed, and the selection an
 * earlier paste set.
 * @param state - The canvas then and now.
 * @returns True when the copies should leave the selection and keyboard alone.
 */
export function userMovedOn(state: PasteFocusState): boolean {
  const { active, canvas } = state;
  if (isEditableTarget(active)) return true;
  const elsewhere =
    active !== null &&
    active !== state.activeBefore &&
    active !== active.ownerDocument.body &&
    canvas !== null &&
    !canvas.contains(active);
  if (elsewhere) return true;
  return state.selectionNow !== state.selectionBefore && state.selectionNow !== state.ownSelection;
}

/**
 * The selected node ids as one key, for {@link userMovedOn}.
 * @param nodes - The canvas nodes.
 * @returns The selected ids, sorted and joined.
 */
export function selectionKey(nodes: ReadonlyArray<{ id: string; selected?: boolean }>): string {
  return nodes
    .filter((node) => node.selected === true)
    .map((node) => node.id)
    .sort()
    .join('\n');
}
