// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The text node editors kept across a hidden canvas (inner#1235 A13): one per
 * node being written in, ended with the writing, the tab or the project.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';

import {
  endAllTextNodeEditors,
  endSpaceTextNodeEditors,
  endTextNodeEditor,
  textNodeEditor,
} from '@web/spaces/canvas/text-node-editors';

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
  endAllTextNodeEditors();
});

describe('textNodeEditor', () => {
  it('hands back the same editor for the same node until it is ended', () => {
    const first = textNodeEditor('s1', 'n1', fakeEditor);

    expect(textNodeEditor('s1', 'n1', fakeEditor)).toBe(first);

    endTextNodeEditor('s1', 'n1');
    expect(first.isDestroyed).toBe(true);
    expect(textNodeEditor('s1', 'n1', fakeEditor)).not.toBe(first);
  });

  it('ends the editors of a closed tab and leaves another tab\'s alone', () => {
    const closed = textNodeEditor('s1', 'n1', fakeEditor);
    const kept = textNodeEditor('s2', 'n1', fakeEditor);

    endSpaceTextNodeEditors('s1');

    expect(closed.isDestroyed).toBe(true);
    expect(kept.isDestroyed).toBe(false);
    expect(textNodeEditor('s2', 'n1', fakeEditor)).toBe(kept);
  });
});
