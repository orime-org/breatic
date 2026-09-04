// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 步骤 4 的前半：the three stand-ins exist in the assembled schema.
 *
 * The patched binding finds them by name — `schema.nodes.unsupportedBlock`,
 * `schema.nodes.unsupportedInline`, `schema.marks.unsupportedMark` — so a
 * rename or a missing registration makes the patch fall straight through to
 * the untouched repair below it, which deletes the element from the shared
 * document and broadcasts that deletion. Nothing raises. These assertions are
 * the only thing standing between that and a silent data loss.
 *
 * The mark's two switches are asserted because both are load-bearing and
 * neither is visible from the round-trip tests:
 *
 * - `excludes: ''` — one span of text can carry several unknown marks at once,
 *   which is the only way a round trip can be lossless. The default would let
 *   a second one displace the first.
 * - the non-formatting group — a `plain` block (the code block) allows only
 *   that group, and BlockNote's own FixUpSchema strips marks a node type does
 *   not allow. Without it, an unknown mark inside a code block is dropped.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment, setLocale, t } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentLocaleRedrawExtension } from '@web/spaces/document/document-locale-redraw';
import { documentFallbackExtension } from '@web/spaces/document/document-unsupported-blocknote';

/**
 * Builds the schema the way production does, fallbacks included.
 * @returns The assembled ProseMirror schema.
 */
function schemaWithFallbacks(): ReturnType<
  typeof buildDocumentEditor
>['pmSchema'] {
  const doc = new Y.Doc();
  // Never mounted: the schema is assembled at creation, and the whole suite
  // shares one process, where a mounted editor keeps its listeners alive for
  // every file after this one.
  return buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [documentFallbackExtension()],
  }).pmSchema;
}

describe('the cross-version fallbacks', () => {
  it('registers a block stand-in the patched binding can find by name', () => {
    const type = schemaWithFallbacks().nodes['unsupportedBlock'];
    expect(type).toBeDefined();
    // `blockContent` is the group a block's own node belongs to; the two
    // container positions are reached by wrapping, not by group membership.
    expect(type?.spec.group).toContain('blockContent');
    expect(type?.spec.atom).toBe(true);
  });

  it('registers an inline stand-in the patched binding can find by name', () => {
    const type = schemaWithFallbacks().nodes['unsupportedInline'];
    expect(type).toBeDefined();
    expect(type?.isInline).toBe(true);
    expect(type?.spec.atom).toBe(true);
  });

  it('registers a mark stand-in that never displaces another mark', () => {
    const type = schemaWithFallbacks().marks['unsupportedMark'];
    expect(type).toBeDefined();
    expect(type?.spec.excludes).toBe('');
  });

  it('puts the mark in the group a code block allows', () => {
    const type = schemaWithFallbacks().marks['unsupportedMark'];
    // A `plain` block allows only this group. The name is asserted literally
    // rather than through the library's constant: reading the constant here
    // would make the assertion agree with whatever the library says today,
    // including a rename that silently drops the mark from code blocks.
    expect(String(type?.spec.group).split(' ')).toContain('annotation');
  });

  it('gives every stand-in the attributes a lossless round trip needs', () => {
    const schema = schemaWithFallbacks();
    expect(
      Object.keys(schema.nodes['unsupportedBlock']?.spec.attrs ?? {}),
    ).toContain('originalName');
    expect(
      Object.keys(schema.nodes['unsupportedInline']?.spec.attrs ?? {}),
    ).toContain('originalName');
    // The mark is the one that gets written back, so it keeps the value too.
    const markAttrs = Object.keys(
      schema.marks['unsupportedMark']?.spec.attrs ?? {},
    );
    expect(markAttrs).toContain('originalName');
    expect(markAttrs).toContain('originalValue');
  });
});

describe('the fallbacks in BlockNote’s own registry', () => {
  // The second half of registration. BlockNote keeps a block schema and an
  // inline content schema beside the ProseMirror one, and every route that
  // hands out a block object looks a node up in them — `nodeToBlock.ts:427`
  // and `:358` throw for a type they cannot find. `getTextCursorPosition`
  // converts the block at the cursor along with its previous, next and parent,
  // and `SourceBlockWithPreview` calls it on every selection change, so a
  // stand-in absent from those registries raises out of `view.dispatch` when
  // the caret merely arrives beside one.
  /**
   * Opens a document of three paragraphs whose middle block is a stand-in.
   * @returns The editor, mounted.
   */
  function openAroundFallback(): ReturnType<typeof buildDocumentEditor> {
    // The redraw extension comes along because the label is a decoration and
    // a decoration is recomputed on dispatch — switching language dispatches
    // nothing on its own. The cache registers both, so this pair is what a
    // reader actually has.
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(new Y.Doc()),
      extensions: [documentFallbackExtension(), documentLocaleRedrawExtension()],
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'before' },
      { type: 'paragraph', content: 'middle' },
      { type: 'paragraph', content: 'after' },
    ] as never);

    const view = editor.prosemirrorView!;
    let at = -1;
    let size = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === 'middle') {
        at = pos;
        size = node.nodeSize;
      }
      return at === -1;
    });
    const stand = view.state.schema.nodes['unsupportedBlock']!;
    view.dispatch(
      view.state.tr.replaceWith(
        at,
        at + size,
        stand.create({ originalName: 'somethingNewer' }),
      ),
    );
    return editor;
  }

  /**
   * A position inside the block holding the given text.
   * @param editor - The editor.
   * @param text - The text to look for.
   * @returns That position.
   */
  function caretIn(
    editor: ReturnType<typeof buildDocumentEditor>,
    text: string,
  ): number {
    let at = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (at === -1 && node.isTextblock && node.textContent === text) {
        at = pos + 1;
      }
      return at === -1;
    });
    return at;
  }

  const held: ReturnType<typeof buildDocumentEditor>[] = [];

  afterEach(() => {
    held.splice(0).forEach((editor) => {
      editor.unmount();
    });
  });

  it('lets the caret into the block before one', () => {
    const editor = openAroundFallback();
    held.push(editor);

    expect(() => {
      const view = editor.prosemirrorView!;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, caretIn(editor, 'before')),
        ),
      );
    }).not.toThrow();
  });

  it('lets the caret into the block after one', () => {
    const editor = openAroundFallback();
    held.push(editor);

    expect(() => {
      const view = editor.prosemirrorView!;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, caretIn(editor, 'after')),
        ),
      );
    }).not.toThrow();
  });

  it('lets one be selected', () => {
    const editor = openAroundFallback();
    held.push(editor);
    let at = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (at === -1 && node.type.name === 'unsupportedBlock') at = pos;
      return at === -1;
    });

    expect(() => {
      const view = editor.prosemirrorView!;
      view.dispatch(
        view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)),
      );
    }).not.toThrow();
  });

  it('reads the document back with one in it, name and all', () => {
    const editor = openAroundFallback();
    held.push(editor);

    const blocks = editor.document as unknown as {
      type: string;
      props: Record<string, unknown>;
    }[];

    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'unsupportedBlock',
      'paragraph',
    ]);
    expect(blocks[1]?.props['originalName']).toBe('somethingNewer');
  });

  it('shows a localised label on the block, so the gap is visible', () => {
    // The stand-in holds nothing this build can draw, so without a label it
    // renders as a blank box and the reader has no way to know something is
    // there. index.css paints it through `content: attr(data-label)`.
    const editor = openAroundFallback();
    held.push(editor);
    const root = editor.prosemirrorView!.dom;

    expect(
      root
        .querySelector('[data-unsupported-block]')
        ?.getAttribute('data-label'),
    ).toBe(t('spaces.document.unsupported.label'));
  });

  it('shows the same label on an inline stand-in', () => {
    const editor = openAroundFallback();
    held.push(editor);
    const view = editor.prosemirrorView!;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at === -1 && node.isTextblock && node.textContent === 'before') {
        at = pos + 1;
      }
      return at === -1;
    });
    view.dispatch(
      view.state.tr.insert(
        at,
        view.state.schema.nodes['unsupportedInline']!.create({
          originalName: 'newerInline',
        }),
      ),
    );

    expect(
      view.dom
        .querySelector('[data-unsupported-inline]')
        ?.getAttribute('data-label'),
    ).toBe(t('spaces.document.unsupported.label'));
  });

  it('follows a language switch, which dispatches nothing of its own', async () => {
    const editor = openAroundFallback();
    held.push(editor);
    const root = editor.prosemirrorView!.dom;
    /** What the label currently reads. */
    const label = (): string =>
      root
        .querySelector('[data-unsupported-block]')
        ?.getAttribute('data-label') ?? '';

    const before = label();
    expect(before).not.toBe('');

    setLocale('ja');
    try {
      await waitFor(() => {
        expect(label()).toBe(t('spaces.document.unsupported.label'));
      });
      expect(label()).not.toBe(before);
    } finally {
      setLocale('en');
    }
  });
});
