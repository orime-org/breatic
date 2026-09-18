// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A11.1: a drop the handle started is answered here, always.
 *
 * Declining one hands it back to ProseMirror, which writes the slice
 * `SideMenu.onDragStart` parsed out of the clipboard when the pointer went
 * down — the stale row design §8 exists to keep out — and puts a node
 * selection on it, which is what A11.2 removes. So the only question this
 * plugin answers is whether the drag was a row drag; everything after that is
 * ours whether or not a move can be written.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { EditorView } from '@tiptap/pm/view';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  rowHasLanded,
  rowIsFlying,
} from '@web/spaces/document/document-drag-drop';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  rowHasLanded();
  vi.restoreAllMocks();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as this file reads it. */
interface Seen {
  id: string;
}

/** An open editor and the row a test can reach for. */
interface Opened {
  editor: ReturnType<typeof buildDocumentEditor>;
  first: string;
}

/**
 * Opens an editor holding two rows.
 * @returns The editor and the id of its first row.
 */
function open(): Opened {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha' },
    { type: 'paragraph', content: 'beta' },
  ] as never);
  return { editor, first: (editor.document[0] as unknown as Seen).id };
}

/**
 * The plugin's own drop handler, as ProseMirror would call it.
 * @param view - The view the plugin is registered in.
 * @returns The handler.
 * @throws {Error} When no registered plugin offers one.
 */
function dropHandlerOf(
  view: EditorView,
): (view: EditorView, event: DragEvent) => boolean {
  for (const plugin of view.state.plugins) {
    const handler = plugin.props.handleDrop;
    if (handler !== undefined) {
      return handler as unknown as (view: EditorView, event: DragEvent) => boolean;
    }
  }
  throw new Error('no plugin offers handleDrop');
}

/**
 * A drop event over the middle of the page.
 * @returns The event, with a `preventDefault` that can be read back.
 */
function aDrop(): DragEvent {
  return {
    clientX: 100,
    clientY: 100,
    preventDefault: vi.fn(),
  } as unknown as DragEvent;
}

/**
 * Every row's text, in order.
 * @param editor - The editor to read.
 * @returns One string per row.
 */
function rowsOf(editor: ReturnType<typeof buildDocumentEditor>): string[] {
  return editor.transact((tr) => {
    const seen: string[] = [];
    tr.doc.descendants((node) => {
      if (node.type.name !== 'blockContainer') return true;
      seen.push(node.textContent);
      return true;
    });
    return seen;
  });
}

describe('who answers a drop', () => {
  it('declines a drop no row drag started, so a text drag is ProseMirror’s', () => {
    const { editor } = open();

    const answered = dropHandlerOf(editor.prosemirrorView)(
      editor.prosemirrorView,
      aDrop(),
    );

    expect(answered).toBe(false);
  });

  it('answers a row drag whose row a co-editor deleted mid-flight', () => {
    const { editor } = open();
    rowIsFlying('a-row-that-is-gone', undefined);
    vi.spyOn(editor.prosemirrorView, 'posAtCoords').mockReturnValue({
      pos: 1,
      inside: -1,
    });
    const event = aDrop();

    const answered = dropHandlerOf(editor.prosemirrorView)(
      editor.prosemirrorView,
      event,
    );

    expect(answered).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(rowsOf(editor)).toEqual(['alpha', 'beta']);
  });
});
