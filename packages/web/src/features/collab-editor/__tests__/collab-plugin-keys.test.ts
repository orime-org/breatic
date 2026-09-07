// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The collaboration plugins have to stay findable now that TWO libraries mint
 * their keys.
 *
 * `PluginKey` does not guarantee the name it was asked for. `prosemirror-state`
 * keeps one process-wide table of names, and a second key asking for a taken
 * name gets a number appended. `@tiptap/y-tiptap` and `y-prosemirror` both ask
 * for `y-sync` and `y-undo`, and this build now loads both — the document body
 * is on y-prosemirror through BlockNote, the canvas prompt and text-node
 * editors are still on y-tiptap. Whichever loads first takes the bare name and
 * the other gets the suffix, and which one that is comes down to module order.
 *
 * Measured, importing y-prosemirror first: it takes `y-sync$`, and y-tiptap
 * mints `y-sync$1`.
 *
 * That is why the readers hold the KEYS rather than their names. A name lookup
 * for `y-sync$` against a plugin registered as `y-sync$1` misses, and every one
 * of these readers treats a miss as "collaboration is absent" — the undo
 * selection restore stops restoring, the prompt editor stops telling a remote
 * change from a local one. Silently, in all three cases.
 *
 * This file loads y-prosemirror as well, so the collision is the live
 * arrangement here rather than a hypothetical one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Collaboration } from '@tiptap/extension-collaboration';
import { ySyncPluginKey as yProsemirrorSyncKey } from 'y-prosemirror';
import * as Y from 'yjs';

import {
  ySyncPluginKey,
  yUndoPluginKey,
} from '@web/features/collab-editor/collab-plugin-keys';

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((editor) => {
    editor.destroy();
  });
});

/**
 * Opens a collaborative editor of the kind the canvas editors build.
 * @returns The editor.
 */
function open(): Editor {
  const doc = new Y.Doc();
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      Collaboration.configure({ fragment: doc.getXmlFragment('prompt') }),
    ],
  });
  editors.push(editor);
  return editor;
}

describe('the keys the collaboration readers hold', () => {
  it('resolves the plugin state on an editor y-tiptap set up', () => {
    const editor = open();

    // `getState` matches on key IDENTITY, so it answers whatever name this key
    // ended up minted under.
    expect(ySyncPluginKey.getState(editor.state)).toBeDefined();
    expect(yUndoPluginKey.getState(editor.state)).toBeDefined();
  });

  it('is minted under a different name than y-prosemirror’s namesake', () => {
    // The point of the file, and the reason a literal name cannot be written
    // down: both libraries ask for `y-sync`, exactly one of them gets it, and
    // which one comes down to module order. Whichever way round this run
    // landed, one of these two names carries a suffix — so a reader spelling
    // the bare name is right about one library and silently wrong about the
    // other.
    const tiptap = (ySyncPluginKey as unknown as { key: string }).key;
    const prosemirror = (yProsemirrorSyncKey as unknown as { key: string }).key;
    expect(tiptap.startsWith('y-sync$')).toBe(true);
    expect(prosemirror.startsWith('y-sync$')).toBe(true);
    expect(tiptap).not.toBe(prosemirror);
  });
});
