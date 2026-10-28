// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #113 acceptance A5: a command off the block handle acts on the hovered block
 * itself, and on nothing indented under it.
 *
 * A block in BlockNote is a `blockContainer`, whose content is
 * `blockContent blockGroup?` (`BlockContainer.ts:27`) — the nested blocks live
 * inside it. A range over the container therefore covers the whole subtree,
 * which the reader would see as every indented row changing along with the one
 * they pointed at.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { blocksUnder } from '@web/spaces/document/document-block-ticks';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding one parent block with two blocks indented under it.
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
    {
      type: 'bulletListItem',
      content: 'parent',
      children: [
        { type: 'bulletListItem', content: 'first child' },
        { type: 'bulletListItem', content: 'second child' },
      ],
    },
  ] as never);
  return editor;
}

describe('the range a block handle command acts on', () => {
  it('covers the hovered block and none of its children', () => {
    const editor = open();
    const parentId = (editor.document[0] as { id: string }).id;
    const doc = editor.prosemirrorState.doc;

    const covered = blocksUnder(doc, selectionOverBlockContent(doc, parentId));

    expect(covered).toHaveLength(1);
    expect(covered[0]?.node.textContent).toBe('parent');
  });

  it('leaves the reader’s own selection alone', () => {
    const editor = open();
    const parentId = (editor.document[0] as { id: string }).id;
    const before = editor.prosemirrorState.selection;

    selectionOverBlockContent(editor.prosemirrorState.doc, parentId);

    expect(editor.prosemirrorState.selection.from).toBe(before.from);
    expect(editor.prosemirrorState.selection.to).toBe(before.to);
  });

  it('answers for a block with nothing indented under it', () => {
    const editor = open();
    const childId = (
      editor.document[0] as { children: { id: string }[] }
    ).children[0]!.id;
    const doc = editor.prosemirrorState.doc;

    const covered = blocksUnder(doc, selectionOverBlockContent(doc, childId));

    expect(covered).toHaveLength(1);
    expect(covered[0]?.node.textContent).toBe('first child');
  });
});
