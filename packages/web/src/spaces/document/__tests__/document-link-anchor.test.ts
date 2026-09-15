// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the link controls are measured against.
 *
 * The reference is asked for a rectangle whenever the browser is about to
 * paint, which is long after it was made, and in between the document can have
 * thrown away every node the span was rendered as: writing an address builds a
 * new mark, and ProseMirror rebuilds the anchor rather than reusing one whose
 * attributes changed. A reference holding a DOM Range from when it was built
 * then measures nodes the document no longer has.
 *
 * Rectangles themselves are not asked about here — jsdom has no layout and
 * answers zero for all of them. What is asked is which nodes the measurement
 * is taken from.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { panelReference } from '@web/spaces/document/document-link-anchor';
import { applyLink, type LinkRange } from '@web/spaces/document/document-link';

const HREF = 'https://one.example/';
const OTHER = 'https://two.example/';
const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor over one paragraph holding a single link.
 * @returns The editor.
 */
function openWithLink(): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: [{ type: 'link', href: HREF, content: 'one' }] },
  ] as never);
  return editor;
}

/**
 * Where the one link in the body sits.
 * @param editor - The editor to read.
 * @returns The span.
 */
function linkSpan(editor: ReturnType<typeof buildDocumentEditor>): LinkRange {
  const { doc, schema } = editor.prosemirrorState;
  let found: LinkRange | null = null;
  doc.descendants((node, pos) => {
    if (node.isText && node.marks.some((m) => m.type === schema.marks.link)) {
      found = { from: pos, to: pos + (node.text?.length ?? 0) };
    }
    return true;
  });
  if (found === null) throw new Error('the body holds no link');
  return found;
}

describe('the reference a link control is measured against', () => {
  it('reads the document again on every rectangle it is asked for', () => {
    const editor = openWithLink();
    const reference = panelReference(editor, linkSpan(editor))!;
    expect(reference).not.toBeNull();
    reference.getBoundingClientRect();

    const view = editor.prosemirrorView!;
    const resolved = vi.spyOn(view, 'domAtPos');
    reference.getBoundingClientRect();
    reference.getClientRects();

    expect(
      resolved.mock.calls.length,
      'a reference that answers from a Range it built once never asks again',
    ).toBeGreaterThan(0);
  });

  it('measures nodes the document still holds after a write rebuilds them', () => {
    const editor = openWithLink();
    const span = linkSpan(editor);
    const reference = panelReference(editor, span)!;
    reference.getBoundingClientRect();

    // Changing the address gives the run a different mark, and a mark view
    // whose mark is not `eq` is destroyed and built again.
    applyLink(editor, span, OTHER);

    const view = editor.prosemirrorView!;
    const resolved = vi.spyOn(view, 'domAtPos');
    reference.getBoundingClientRect();

    expect(resolved.mock.results.length).toBeGreaterThan(0);
    resolved.mock.results.forEach((result) => {
      const at = result.value as { node: Node };
      expect(at.node.isConnected, 'measured against a node the document dropped').toBe(true);
    });
  });
});
