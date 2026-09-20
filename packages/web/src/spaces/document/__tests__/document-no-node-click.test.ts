// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 A11.3: a modifier-click puts the caret down, it does not select a block.
 *
 * The one press this has to keep its hands off is a modifier-click on a link,
 * which is how a reader opens one in a new tab everywhere else. Answering it
 * here would stop the link handler from ever being asked
 * (`prosemirror-view/src/input.ts`: `handleSingleClick` calls `preventDefault`
 * on the first prop that answers true).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { EditorView } from '@tiptap/pm/view';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding one row.
 * @returns The editor.
 */
function open(): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha' },
  ] as never);
  return editor;
}

/** What `handleClick` is called with. */
type ClickHandler = (view: EditorView, pos: number, event: MouseEvent) => boolean;

/**
 * The plugin's own click handler, as ProseMirror would call it.
 * @param view - The view the plugin is registered in.
 * @returns The handler.
 * @throws {Error} When no registered plugin offers one.
 */
function clickHandlerOf(view: EditorView): ClickHandler {
  for (const plugin of view.state.plugins) {
    const handler = plugin.props.handleClick;
    if (handler !== undefined) return handler as unknown as ClickHandler;
  }
  throw new Error('no plugin offers handleClick');
}

/**
 * A press held with the platform's node modifier.
 * @param target - What the pointer was over.
 * @returns The press.
 */
function modifierClick(target: Element): MouseEvent {
  return {
    target,
    metaKey: true,
    ctrlKey: true,
  } as unknown as MouseEvent;
}

describe('a modifier-click in the body', () => {
  it('answers a press on plain words, so no block is selected', () => {
    const editor = open();
    const words = document.createElement('span');

    const answered = clickHandlerOf(editor.prosemirrorView)(
      editor.prosemirrorView,
      2,
      modifierClick(words),
    );

    expect(answered).toBe(true);
    expect(editor.prosemirrorView.state.selection.empty).toBe(true);
  });

  it('leaves a press on a link to the link', () => {
    const editor = open();
    const anchor = document.createElement('a');
    anchor.setAttribute('data-inline-content-type', 'link');
    anchor.setAttribute('href', 'https://example.com');
    const inside = document.createElement('span');
    anchor.appendChild(inside);

    const answered = clickHandlerOf(editor.prosemirrorView)(
      editor.prosemirrorView,
      2,
      modifierClick(inside),
    );

    expect(answered).toBe(false);
  });
});
