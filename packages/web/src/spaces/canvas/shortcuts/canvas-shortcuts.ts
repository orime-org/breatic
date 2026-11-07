// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { ShortcutSpec } from '@web/spaces/canvas/format-shortcut';

/**
 * The canvas key chords, read by the keyboard shortcuts dialog and by every
 * context-menu hint. The handlers that answer them are
 * `matchHistoryShortcut`, `matchGroupShortcut`, `matchDuplicateShortcut`,
 * `brushSizeStep`, `DELETE_KEYS`, the document's `copy` / `paste` events, and
 * `useEscapeInSpace` with each panel's own Escape handling.
 */
export const CANVAS_KEY_SHORTCUTS = {
  undo: { mod: true, key: 'Z' },
  redo: { mod: true, shift: true, key: 'Z' },
  redoAlt: { mod: true, key: 'Y' },
  copy: { mod: true, key: 'C' },
  paste: { mod: true, key: 'V' },
  duplicate: { mod: true, key: 'D' },
  delete: { key: 'Delete' },
  group: { mod: true, key: 'G' },
  ungroup: { mod: true, shift: true, key: 'G' },
  brushSmaller: { key: '[' },
  brushLarger: { key: ']' },
  escape: { key: 'Esc' },
} as const satisfies Record<string, ShortcutSpec>;

/** The keys that delete the canvas selection. */
export const DELETE_KEYS: readonly string[] = ['Backspace', 'Delete'];

/** A pointer gesture, optionally with modifier keys held, named by a locale key. */
export interface ShortcutGesture {
  gestureKey: string;
  mod?: boolean;
  shift?: boolean;
}

/** One line of the shortcuts dialog. An action the canvas already names elsewhere uses that key. */
export interface ShortcutRow {
  id: string;
  labelKey: string;
  /** Alternatives, shown separated by a slash. */
  keys: ReadonlyArray<ShortcutSpec | ShortcutGesture>;
  /** Whether only a member who can edit the canvas gets anything from it. */
  requiresEdit: boolean;
}

/** One titled group of the shortcuts dialog. */
export interface ShortcutGroup {
  id: string;
  titleKey: string;
  rows: ReadonlyArray<ShortcutRow>;
}

const K = CANVAS_KEY_SHORTCUTS;

/** Everything the canvas answers from the keyboard and pointer, grouped for the dialog. */
export const CANVAS_SHORTCUT_GROUPS: ReadonlyArray<ShortcutGroup> = [
  {
    id: 'edit',
    titleKey: 'canvas.shortcuts.group.edit',
    rows: [
      { id: 'undo', labelKey: 'viewportToolbar.undo', keys: [K.undo], requiresEdit: true },
      { id: 'redo', labelKey: 'viewportToolbar.redo', keys: [K.redo, K.redoAlt], requiresEdit: true },
      { id: 'copy', labelKey: 'canvas.contextMenu.copy', keys: [K.copy], requiresEdit: true },
      { id: 'paste', labelKey: 'canvas.contextMenu.paste', keys: [K.paste], requiresEdit: true },
      { id: 'duplicate', labelKey: 'canvas.contextMenu.duplicate', keys: [K.duplicate], requiresEdit: true },
      { id: 'delete', labelKey: 'canvas.shortcuts.row.delete', keys: [K.delete], requiresEdit: true },
    ],
  },
  {
    id: 'group',
    titleKey: 'canvas.shortcuts.group.group',
    rows: [
      { id: 'group', labelKey: 'canvas.group.group', keys: [K.group], requiresEdit: true },
      { id: 'ungroup', labelKey: 'canvas.group.ungroup', keys: [K.ungroup], requiresEdit: true },
    ],
  },
  {
    id: 'select',
    titleKey: 'canvas.shortcuts.group.select',
    rows: [
      { id: 'marquee', labelKey: 'canvas.shortcuts.row.marquee', keys: [{ gestureKey: 'canvas.shortcuts.gesture.dragEmpty' }], requiresEdit: false },
      { id: 'toggleSelect', labelKey: 'canvas.shortcuts.row.toggleSelect', keys: [{ gestureKey: 'canvas.shortcuts.gesture.click', mod: true }], requiresEdit: false },
      { id: 'nudge', labelKey: 'canvas.shortcuts.row.nudge', keys: [{ gestureKey: 'canvas.shortcuts.gesture.arrowKeys' }], requiresEdit: true },
      { id: 'nudgeFar', labelKey: 'canvas.shortcuts.row.nudgeFar', keys: [{ gestureKey: 'canvas.shortcuts.gesture.arrowKeys', shift: true }], requiresEdit: true },
    ],
  },
  {
    id: 'view',
    titleKey: 'canvas.shortcuts.group.view',
    rows: [
      {
        id: 'pan',
        labelKey: 'canvas.shortcuts.row.pan',
        keys: [{ gestureKey: 'canvas.shortcuts.gesture.scroll' }, { gestureKey: 'canvas.shortcuts.gesture.spaceDrag' }],
        requiresEdit: false,
      },
      {
        id: 'zoom',
        labelKey: 'canvas.shortcuts.row.zoom',
        keys: [{ gestureKey: 'canvas.shortcuts.gesture.pinch' }, { gestureKey: 'canvas.shortcuts.gesture.wheel', mod: true }],
        requiresEdit: false,
      },
    ],
  },
  {
    id: 'drawing',
    titleKey: 'canvas.shortcuts.group.drawing',
    rows: [
      { id: 'brushSize', labelKey: 'canvas.shortcuts.row.brushSize', keys: [K.brushSmaller, K.brushLarger], requiresEdit: true },
      { id: 'deleteMark', labelKey: 'canvas.shortcuts.row.deleteMark', keys: [K.delete], requiresEdit: true },
    ],
  },
  {
    id: 'exit',
    titleKey: 'canvas.shortcuts.group.exit',
    rows: [
      { id: 'closePanel', labelKey: 'canvas.shortcuts.row.closePanel', keys: [K.escape], requiresEdit: false },
      { id: 'exitPick', labelKey: 'canvas.shortcuts.row.exitPick', keys: [K.escape], requiresEdit: true },
      { id: 'cancelNote', labelKey: 'canvas.shortcuts.row.cancelNote', keys: [K.escape], requiresEdit: true },
    ],
  },
];

const READ_ONLY_GROUPS: ReadonlyArray<ShortcutGroup> = CANVAS_SHORTCUT_GROUPS
  .map((group) => ({ ...group, rows: group.rows.filter((row) => !row.requiresEdit) }))
  .filter((group) => group.rows.length > 0);

/**
 * The groups a user should see: a read-only member only gets the rows that
 * do something for them, and a group left empty is dropped.
 * @param readOnly - Whether the user cannot edit the canvas.
 * @returns The groups to show.
 */
export function visibleShortcutGroups(readOnly: boolean): ReadonlyArray<ShortcutGroup> {
  return readOnly ? READ_ONLY_GROUPS : CANVAS_SHORTCUT_GROUPS;
}
