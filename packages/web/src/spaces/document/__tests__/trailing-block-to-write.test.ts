// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * There is always somewhere to start writing at the end of a document.
 *
 * The last block can be one a caret cannot leave — a code block swallows Enter
 * — so without this a user has no way past it.
 *
 * BlockNote answers it with `TrailingNodeExtension`, and the shape of that
 * answer is what makes it safe in a shared document: the affordance is a WIDGET
 * DECORATION, so it is not part of the content. Nothing is written until the
 * reader presses it, nothing is broadcast, nothing lands on anyone's undo
 * stack, and a viewer never sees one. Those are the three things this pins,
 * because they are the ones a change upstream could take away quietly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const live: ReturnType<typeof buildDocumentEditor>[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  live.splice(0).forEach((editor) => {
    editor.unmount();
  });
  containers.splice(0).forEach((element) => {
    element.remove();
  });
});

/** One render is enough for the decoration to reach the page. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 40);
  });
}

/**
 * Opens a document on the page holding the given blocks.
 * @param blocks - The body, one entry per block.
 * @returns The editor, its container, and the shared document.
 */
async function open(
  blocks: { type: string; content?: string }[],
): Promise<{
  editor: ReturnType<typeof buildDocumentEditor>;
  container: HTMLElement;
  doc: Y.Doc;
}> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  live.push(editor);
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  editor.mount(container);
  editor.replaceBlocks(editor.document, blocks as never);
  await settle();
  return { editor, container, doc };
}

/** The affordance at the end of the document, if one is drawn. */
function trailing(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.bn-trailing-block');
}

describe('somewhere to write at the end of the document', () => {
  it('offers one past a last block a caret cannot follow', async () => {
    const { editor, container } = await open([
      { type: 'codeBlock', content: 'const a = 1' },
    ]);
    const widget = trailing(container);
    expect(widget).not.toBeNull();

    widget!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    await settle();

    const types = (editor.document as { type: string }[]).map(
      (block) => block.type,
    );
    expect(types).toEqual(['codeBlock', 'paragraph']);
  });

  it('writes nothing into the shared document until it is pressed', async () => {
    const { doc, container } = await open([
      { type: 'codeBlock', content: 'const a = 1' },
    ]);
    expect(trailing(container)).not.toBeNull();

    // The decoration is drawn, and the shared document does not know about it.
    const group = documentBodyFragment(doc).get(0) as Y.XmlElement;
    expect(group.length).toBe(1);
  });

  it('offers nothing when the last block is already an empty paragraph', async () => {
    // There is a block to type in, so a second one would be in the way.
    const { container } = await open([
      { type: 'paragraph', content: 'written' },
      { type: 'paragraph' },
    ]);

    expect(trailing(container)).toBeNull();
  });

  it('offers nothing to a viewer', async () => {
    // The server drops a viewer's update without an error, so a write here
    // would be a permanent local divergence with nothing to signal it.
    const { editor, container } = await open([
      { type: 'codeBlock', content: 'const a = 1' },
    ]);
    expect(trailing(container)).not.toBeNull();

    editor.isEditable = false;
    await settle();

    expect(trailing(container)).toBeNull();
  });
});
