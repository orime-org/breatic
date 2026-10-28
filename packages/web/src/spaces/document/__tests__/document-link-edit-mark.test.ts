// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The span the toolbar's field draws, under edits from a co-editor.
 *
 * The span answers "which link is this field about", so it has to still cover
 * that link after a peer has written somewhere else in the document.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { showLinkEditSpan } from '@web/spaces/document/document-link-edit-mark';
import { trackLink } from '@web/spaces/document/document-link-tracking';

const HREF = 'https://a.example/docs';
const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * The text drawn as selected.
 * @param editor - The editor to read.
 * @returns The joined text of every drawn node, empty when nothing is drawn.
 */
function markedText(editor: ReturnType<typeof buildDocumentEditor>): string {
  const nodes = editor.prosemirrorView?.dom.querySelectorAll(
    '[data-show-selection]',
  );
  return [...(nodes ?? [])].map((n) => n.textContent ?? '').join('');
}

/**
 * Where the one link in the body sits.
 * @param editor - The editor to read.
 * @returns The span the link mark covers.
 * @throws {Error} When the body holds no link.
 */
function spanOfLink(editor: ReturnType<typeof buildDocumentEditor>): {
  from: number;
  to: number;
} {
  let found: { from: number; to: number } | null = null;
  const { doc, schema } = editor.prosemirrorState;
  doc.descendants((node, pos) => {
    if (found !== null || !node.isText) return found === null;
    if (node.marks.some((m) => m.type === schema.marks.link)) {
      found = { from: pos, to: pos + (node.text?.length ?? 0) };
    }
    return true;
  });
  if (found === null) throw new Error('the body holds no link');
  return found;
}

describe('the span the field draws', () => {
  it('still covers its link after a co-editor has written', () => {
    const local = new Y.Doc();
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(local),
    });
    editor.mount(document.createElement('div'));
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'go ', styles: {} },
          { type: 'link', href: HREF, content: 'HERE' },
          { type: 'text', text: ' end', styles: {} },
        ],
      },
    ] as never);

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));

    showLinkEditSpan(
      editor.prosemirrorView,
      trackLink(editor.prosemirrorState, spanOfLink(editor)),
    );
    expect(markedText(editor)).toBe('HERE');

    // The peer writes at the very start, well clear of the link.
    const group = documentBodyFragment(remote).get(0) as Y.XmlElement;
    const container = group.get(0) as Y.XmlElement;
    const paragraph = container.get(0) as Y.XmlElement;
    (paragraph.get(0) as Y.XmlText).insert(0, 'AA ');
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));

    expect(editor.prosemirrorState.doc.textContent).toBe('AA go HERE end');
    expect(markedText(editor)).toBe('HERE');
  });

  it('covers only the link after a peer writes at its tail', () => {
    // The handle's end names the character that followed the link, so text a
    // peer inserts at that boundary lands before it and the resolved span
    // widens. What the field is about is the link, whatever grew beside it.
    const local = new Y.Doc();
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(local),
    });
    editor.mount(document.createElement('div'));
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'go ', styles: {} },
          { type: 'link', href: HREF, content: 'HERE' },
          { type: 'text', text: ' end', styles: {} },
        ],
      },
    ] as never);

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
    showLinkEditSpan(
      editor.prosemirrorView,
      trackLink(editor.prosemirrorState, spanOfLink(editor)),
    );

    const group = documentBodyFragment(remote).get(0) as Y.XmlElement;
    const container = group.get(0) as Y.XmlElement;
    const paragraph = container.get(0) as Y.XmlElement;
    (paragraph.get(0) as Y.XmlText).insert(7, 'ZZZ', {});
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));

    expect(editor.prosemirrorState.doc.textContent).toBe('go HEREZZZ end');
    expect(markedText(editor)).toBe('HERE');
  });
});
