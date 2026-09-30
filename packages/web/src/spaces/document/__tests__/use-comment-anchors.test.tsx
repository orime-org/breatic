// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ToolEditor } from '@web/spaces/document/document-tool-button';
import {
  useCommentAnchors,
  type DraftAnchor,
} from '@web/spaces/document/use-comment-anchors';

/**
 * An editor whose view lays out every position but the ones given.
 * @param unlaid - Positions `coordsAtPos` throws for.
 * @returns The editor.
 */
function editorWith(unlaid: ReadonlySet<number>): ToolEditor {
  const view = {
    dom: null,
    state: { doc: { descendants: (): void => undefined } },
    coordsAtPos: (pos: number): { top: number } => {
      if (unlaid.has(pos)) throw new RangeError('not laid out');
      return { top: pos * 10 };
    },
  };
  return {
    prosemirrorView: view,
    onChange: () => () => undefined,
  } as unknown as ToolEditor;
}

describe('useCommentAnchors', () => {
  it('keeps saying the draft was measured where it last was when its new place is not laid out', () => {
    const editor = editorWith(new Set([9]));
    const column = { current: document.createElement('div') };
    const first: DraftAnchor = { id: 'draft', from: 5 };
    const moved: DraftAnchor = { id: 'draft', from: 9 };
    const { result, rerender } = renderHook(
      ({ draft }: { draft: DraftAnchor }) =>
        useCommentAnchors(editor, [], column, draft),
      { initialProps: { draft: first } },
    );
    expect(result.current.measuredFor).toBe(first);

    rerender({ draft: moved });

    expect(result.current.measuredFor).toBe(first);
    expect(result.current.tops.get('draft')).toBe(50);
  });
});
