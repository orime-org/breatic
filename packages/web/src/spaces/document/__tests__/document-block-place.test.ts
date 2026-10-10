// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Selecting a block with no words whole, from the element that draws it
 * (inner#1127 A10, A22).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { NodeSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { selectWordlessBlock, wordlessBlockAt } from '@web/spaces/document/document-block-place';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding a line and a divider.
 * @returns The editor.
 */
function open(): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha' },
    { type: 'divider' },
  ] as never);
  return editor;
}

describe('finding and selecting a wordless block from its element', () => {
  it('finds a divider from inside it, and selects it whole', () => {
    const view = open().prosemirrorView;
    const divider = view.dom.querySelector('[data-content-type="divider"]')!;
    const inside = divider.firstElementChild ?? divider;

    const found = wordlessBlockAt(view, inside);
    expect(found).toBe(divider);
    selectWordlessBlock(view, found!);

    expect(view.state.selection).toBeInstanceOf(NodeSelection);
    expect((view.state.selection as NodeSelection).node.type.name).toBe('divider');
  });

  it('finds nothing on a block with words', () => {
    const view = open().prosemirrorView;
    const line = view.dom.querySelector('[data-content-type="paragraph"]')!;

    expect(wordlessBlockAt(view, line)).toBeNull();
  });

  it('dispatches nothing when the block is already selected', () => {
    const view = open().prosemirrorView;
    const divider = view.dom.querySelector('[data-content-type="divider"]')!;
    selectWordlessBlock(view, divider);
    const dispatch = vi.spyOn(view, 'dispatch');

    selectWordlessBlock(view, divider);

    expect(dispatch).not.toHaveBeenCalled();
  });
});
