// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { isEditableTarget } from '@web/lib/is-editable-target';

/** What the canvas looked like when a paste began, and what it looks like now. */
export interface PasteFocusState {
  /** The selected node ids when the paste began, as one key. */
  selectionBefore: string;
  /** The selected node ids now, as the same kind of key. */
  selectionNow: string;
  /** The element holding the keyboard now. */
  active: Element | null;
  /** The canvas container. */
  canvas: Element | null;
}

/**
 * Whether the reader went on to something else while a paste waited on the
 * server (inner#1349 A12). A paste selects its copies and gives them the
 * keyboard only while the reader is still where the paste left them: typing
 * in a field, holding the keyboard outside the canvas, or a selection of
 * their own each mean they moved on. The keyboard back on the page, as after
 * a menu closes, is not moving on.
 * @param state - The canvas then and now.
 * @returns True when the copies should leave the selection and keyboard alone.
 */
export function userMovedOn(state: PasteFocusState): boolean {
  const { active, canvas } = state;
  if (isEditableTarget(active)) return true;
  if (active !== null && active !== active.ownerDocument.body && canvas !== null && !canvas.contains(active)) {
    return true;
  }
  return state.selectionBefore !== state.selectionNow;
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
