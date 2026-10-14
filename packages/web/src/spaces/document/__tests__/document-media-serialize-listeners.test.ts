// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Serializing a media block leaves nothing listening on the window.
 *
 * The body draws its media blocks with its own node view; the library's
 * `render` is reached only to serialize — pasted HTML is turned into blocks
 * and back into HTML, and outside HTML falls back to it. That render hangs
 * its resize handlers on the window and only its `destroy` takes them off,
 * which no serializer calls.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { AllSelection } from '@tiptap/pm/state';
import { selectedFragmentToHTML } from '@blocknote/core';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const OURS = 'https://cdn.example/';

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  vi.restoreAllMocks();
});

/**
 * Opens a body with one empty line.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    media: { assetUrlPrefix: () => OURS, onLeftOut: () => {}, start: () => {} },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [{ type: 'paragraph' }] as never);
  return editor;
}

/**
 * Counts the window listeners added and not taken off while `run` runs.
 * @param run - What to watch.
 * @returns How many are left.
 */
function windowListenersLeftBy(run: () => void): number {
  const live = new Set<unknown>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    live.add(`${type}:${String(listener)}`);
    add(type, listener, options);
  });
  vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {
    live.delete(`${type}:${String(listener)}`);
    remove(type, listener, options);
  });
  run();
  vi.restoreAllMocks();
  return live.size;
}

describe('serializing a media block', () => {
  it.each(['image', 'video'] as const)('to paste HTML holding a %s leaves no window listener', (type) => {
    const editor = open();
    const tag = type === 'image' ? 'img' : 'video';

    const left = windowListenersLeftBy(() => {
      editor.pasteHTML(`<p>a</p><${tag} src="${OURS}x"></${tag}>`);
    });

    expect((editor.document as { type: string }[]).map((b) => b.type)).toContain(type);
    expect(left).toBe(0);
  });

  it('to outside HTML leaves no window listener', () => {
    const editor = open();
    editor.replaceBlocks(editor.document, [{ type: 'image', props: { url: `${OURS}x.png`, name: 'x' } }] as never);
    const view = editor.prosemirrorView!;

    const left = windowListenersLeftBy(() => {
      view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
      selectedFragmentToHTML(view, editor);
    });

    expect(left).toBe(0);
  });
});
