// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A21 ① 的跟随那半: holding a link while a co-editor edits around it.
 *
 * The module reads the collaboration binding out of the sync plugin's state,
 * and reaching that state means naming the plugin's key. Two libraries mint a
 * key called `y-sync`, `prosemirror-state` numbers the second one, and asking
 * with the wrong one returns undefined — at which point the module reports "no
 * shared document" for an editor that has one, and the panel silently stops
 * following its link. Nothing throws.
 *
 * So the case here is the one that tells a real binding from a missed lookup:
 * a peer inserts ahead of the tracked span, and the span has to come back
 * moved by what they wrote.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  trackLink,
  resolveTrackedSpan,
} from '@web/spaces/document/document-link-tracking';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding one sentence.
 * @returns The editor and the shared document behind it.
 */
function open(): {
  editor: ReturnType<typeof buildDocumentEditor>;
  doc: Y.Doc;
  } {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'hello world' },
  ] as never);
  return { editor, doc };
}

/**
 * The first text node in the shared document.
 * @param node - Where to look.
 * @returns That node.
 * @throws {Error} When the body holds no text.
 */
function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText {
  for (let i = 0; i < node.length; i += 1) {
    const child: unknown = node.get(i);
    if (child instanceof Y.XmlText) return child;
    if (child instanceof Y.XmlElement) return firstText(child);
  }
  throw new Error('no text node in the body');
}

describe('holding a link across a co-editor’s edit', () => {
  it('takes a handle on an editor bound to a shared document', () => {
    const { editor } = open();

    expect(trackLink(editor.prosemirrorState, { from: 3, to: 8 })).not.toBeNull();
  });

  it('reports the span where it now sits after a peer writes ahead of it', () => {
    const { editor, doc } = open();
    const tracked = trackLink(editor.prosemirrorState, { from: 3, to: 8 });

    const text = firstText(documentBodyFragment(doc));
    doc.transact(() => {
      text.insert(0, 'XX');
    }, 'a-collaborator');

    expect(resolveTrackedSpan(editor.prosemirrorState, tracked!)).toEqual({
      from: 5,
      to: 10,
    });
  });

  it('reports nothing once a peer has deleted the text it covered', () => {
    const { editor, doc } = open();
    const tracked = trackLink(editor.prosemirrorState, { from: 3, to: 8 });

    const text = firstText(documentBodyFragment(doc));
    doc.transact(() => {
      text.delete(0, text.length);
    }, 'a-collaborator');

    expect(resolveTrackedSpan(editor.prosemirrorState, tracked!)).toBeNull();
  });
});
