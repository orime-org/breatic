// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The editors kept across a hidden canvas (inner#1235 A13): one per key,
 * ended by their owner, the tab or the project.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';

import {
  endAllKeptEditors,
  endSpaceKeptEditors,
  endKeptEditor,
  keptEditor,
} from '@web/spaces/canvas/kept-editors';

/**
 * A stand-in editor that knows whether it was ended.
 * @returns The stand-in.
 */
function fakeEditor(): Editor {
  const editor = {
    isDestroyed: false,
    destroy: vi.fn(() => {
      editor.isDestroyed = true;
    }),
  };
  return editor as unknown as Editor;
}

afterEach(() => {
  endAllKeptEditors();
});

describe('keptEditor', () => {
  it('hands back the same editor for the same node until it is ended', () => {
    const first = keptEditor('s1', 'n1', fakeEditor);

    expect(keptEditor('s1', 'n1', fakeEditor)).toBe(first);

    endKeptEditor('s1', 'n1');
    expect(first.isDestroyed).toBe(true);
    expect(keptEditor('s1', 'n1', fakeEditor)).not.toBe(first);
  });

  it('ends the editors of a closed tab and leaves another tab\'s alone', () => {
    const closed = keptEditor('s1', 'n1', fakeEditor);
    const kept = keptEditor('s2', 'n1', fakeEditor);

    endSpaceKeptEditors('s1');

    expect(closed.isDestroyed).toBe(true);
    expect(kept.isDestroyed).toBe(false);
    expect(keptEditor('s2', 'n1', fakeEditor)).toBe(kept);
  });
});
