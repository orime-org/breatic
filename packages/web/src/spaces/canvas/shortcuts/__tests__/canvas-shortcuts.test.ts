// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  CANVAS_KEY_SHORTCUTS,
  CANVAS_SHORTCUT_GROUPS,
  DELETE_KEYS,
  visibleShortcutGroups,
} from '@web/spaces/canvas/shortcuts/canvas-shortcuts';
import type { ShortcutSpec } from '@web/spaces/canvas/format-shortcut';
import { matchHistoryShortcut } from '@web/spaces/canvas/canvas-history-shortcut';
import { matchGroupShortcut } from '@web/spaces/canvas/canvas-group-shortcut';
import { matchDuplicateShortcut } from '@web/spaces/canvas/canvas-duplicate-shortcut';
import { brushSizeStep } from '@web/spaces/canvas/mini-tool/drawing-history';

/**
 * Turn a listed chord into the keydown a reader pressing it would send, once
 * with Cmd (macOS) and once with Ctrl (Windows).
 * @param spec - The listed chord.
 * @param platform - Which modifier carries `mod`.
 * @returns The keydown event.
 */
function press(spec: ShortcutSpec, platform: 'mac' | 'win'): KeyboardEvent {
  const key = spec.shift ? spec.key.toUpperCase() : spec.key.toLowerCase();
  return new KeyboardEvent('keydown', {
    key: spec.key.length === 1 ? key : spec.key,
    metaKey: spec.mod === true && platform === 'mac',
    ctrlKey: spec.mod === true && platform === 'win',
    shiftKey: spec.shift === true,
  });
}

describe('CANVAS_KEY_SHORTCUTS', () => {
  for (const platform of ['mac', 'win'] as const) {
    it(`every listed chord is the one its handler answers (${platform})`, () => {
      const k = CANVAS_KEY_SHORTCUTS;
      expect(matchHistoryShortcut(press(k.undo, platform))).toBe('undo');
      expect(matchHistoryShortcut(press(k.redo, platform))).toBe('redo');
      expect(matchHistoryShortcut(press(k.redoAlt, platform))).toBe('redo');
      expect(matchGroupShortcut(press(k.group, platform))).toBe('group');
      expect(matchGroupShortcut(press(k.ungroup, platform))).toBe('ungroup');
      expect(matchDuplicateShortcut(press(k.duplicate, platform))).toBe(true);
      expect(brushSizeStep(press(k.brushSmaller, platform))).toBe(-1);
      expect(brushSizeStep(press(k.brushLarger, platform))).toBe(1);
    });
  }

  it('lists the native clipboard chords that fire the copy and paste events', () => {
    // Copy and paste are handled on the document's `copy` / `paste` events,
    // which the browser raises for exactly these chords.
    expect(CANVAS_KEY_SHORTCUTS.copy).toEqual({ mod: true, key: 'C' });
    expect(CANVAS_KEY_SHORTCUTS.paste).toEqual({ mod: true, key: 'V' });
  });

  it('lists a delete key the canvas delete handler accepts', () => {
    expect(DELETE_KEYS).toContain(CANVAS_KEY_SHORTCUTS.delete.key);
    expect(DELETE_KEYS).toEqual(['Backspace', 'Delete']);
  });
});

describe('CANVAS_SHORTCUT_GROUPS', () => {
  it('lists the groups and rows the canvas really answers, in order', () => {
    expect(
      CANVAS_SHORTCUT_GROUPS.map((g) => [g.id, g.rows.map((r) => r.id)]),
    ).toEqual([
      ['edit', ['undo', 'redo', 'copy', 'paste', 'duplicate', 'delete']],
      ['group', ['group', 'ungroup']],
      ['select', ['marquee', 'toggleSelect', 'nudge', 'nudgeFar']],
      ['view', ['pan', 'zoom']],
      ['drawing', ['brushSize', 'deleteMark']],
      ['exit', ['closePanel', 'exitPick', 'cancelNote']],
    ]);
  });

  it('marks as edit-only exactly the rows a read-only member cannot use', () => {
    const editOnly = CANVAS_SHORTCUT_GROUPS.flatMap((g) => g.rows)
      .filter((r) => r.requiresEdit)
      .map((r) => r.id);
    expect(editOnly).toEqual([
      'undo', 'redo', 'copy', 'paste', 'duplicate', 'delete',
      'group', 'ungroup',
      'nudge', 'nudgeFar',
      'brushSize', 'deleteMark',
      'exitPick', 'cancelNote',
    ]);
  });

  it('a read-only member sees only the rows that work for them, with empty groups dropped', () => {
    expect(
      visibleShortcutGroups(true).map((g) => [g.id, g.rows.map((r) => r.id)]),
    ).toEqual([
      ['select', ['marquee', 'toggleSelect']],
      ['view', ['pan', 'zoom']],
      ['exit', ['closePanel']],
    ]);
  });

  it('an editor sees every group', () => {
    expect(visibleShortcutGroups(false)).toEqual(CANVAS_SHORTCUT_GROUPS);
  });
});

describe('context-menu hints', () => {
  it.each(['NodeContextMenu', 'SelectionContextMenu', 'CanvasContextMenu', 'EdgeContextMenu'])(
    '%s formats its hints from CANVAS_KEY_SHORTCUTS, so the menu, the dialog and the handlers agree',
    (file) => {
      const src = readFileSync(path.join(import.meta.dirname, '..', '..', `${file}.tsx`), 'utf8');
      const calls = src.match(/formatShortcut\(([^)]*)\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).toMatch(/^formatShortcut\(CANVAS_KEY_SHORTCUTS\.\w+\)$/);
    },
  );
});
