// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 S1 · S2 · S3：vocabulary this build does not know survives a visit.
 *
 * A newer build of ours writes a node type or a mark this one has never heard
 * of. The binding rebuilds every node by calling `schema.node(...)`, which
 * throws, and its untouched error handler answers by DELETING the element from
 * the shared Yjs document and broadcasting that deletion as this client's own
 * edit. The other side loses content it can display perfectly well, and
 * nothing anywhere raises.
 *
 * Every case below builds a REMOTE update rather than calling an editor API.
 * Going through the editor would route the content through `blockToNode`,
 * which never reaches the binding code the patch lives in — the test would
 * pass while the path it exists to cover stays broken.
 *
 * Five structural slots, because they fail differently and only one of them
 * takes the stand-in unwrapped:
 *
 * ```
 * doc          content: "blockGroup"                 ← names one exact type
 *  blockGroup    content: "blockGroupChild+"         ← a group, but blockContainer is its only member
 *   blockContainer content: "blockContent blockGroup?"
 *     ^ slot 1: blockContent (a group — the stand-in joins it by declaration)
 *     ^ slot 2: blockGroup?  ← names one exact type
 *      paragraph  inline content
 * ```
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentFallbackExtension } from '@web/spaces/document/document-unsupported-blocknote';

/**
 * Builds a paragraph element carrying the given text.
 * @param text - What the paragraph says.
 * @returns The element, ready to insert.
 */
function paragraph(text: string): Y.XmlElement {
  const el = new Y.XmlElement('paragraph');
  el.setAttribute('backgroundColor', 'default');
  el.setAttribute('textColor', 'default');
  el.setAttribute('textAlignment', 'left');
  const content = new Y.XmlText();
  content.insert(0, text);
  el.insert(0, [content]);
  return el;
}

/**
 * Wraps content in a blockContainer with an id.
 * @param id - The block id.
 * @param children - What the container holds.
 * @returns The container element.
 */
function container(id: string, children: Y.XmlElement[]): Y.XmlElement {
  const el = new Y.XmlElement('blockContainer');
  el.setAttribute('id', id);
  el.insert(0, children);
  return el;
}

/**
 * Wraps containers in a blockGroup.
 * @param children - The containers.
 * @returns The group element.
 */
function group(children: Y.XmlElement[]): Y.XmlElement {
  const el = new Y.XmlElement('blockGroup');
  el.insert(0, children);
  return el;
}

/**
 * Applies a hand-built shape as a REMOTE update and mounts the editor over it.
 *
 * The shape is built in one doc and shipped to another as bytes, which is what
 * a peer on a newer build actually does. Building it in the same doc the
 * editor binds to would skip the decoding path entirely.
 * @param build - Fills the fragment with the shape under test.
 * @returns The receiving doc's fragment, after the editor has seen it.
 */
function visit(build: (fragment: Y.XmlFragment) => void): {
  before: string;
  after: string;
  standIns: readonly string[];
} {
  const remote = new Y.Doc();
  build(documentBodyFragment(remote));
  const update = Y.encodeStateAsUpdate(remote);

  const local = new Y.Doc();
  Y.applyUpdate(local, update);
  const fragment = documentBodyFragment(local);
  const before = fragment.toString();

  const editor = buildDocumentEditor({
    fragment,
    extensions: [documentFallbackExtension()],
  });
  editor.mount(document.createElement('div'));

  // What this client actually shows. The shared document staying untouched is
  // only half the contract: a stand-in that never reaches the local document
  // leaves the user looking at a hole where a peer sees content, and the Yjs
  // side alone cannot tell the two apart.
  const standIns: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (
      node.type.name === 'unsupportedBlock' ||
      node.type.name === 'unsupportedInline'
    ) {
      standIns.push(String(node.attrs['originalName']));
    }
    return true;
  });

  return { before, after: fragment.toString(), standIns };
}

describe('an element name this build does not know', () => {
  it('survives in the blockContent slot', () => {
    const { before, after, standIns } = visit((f) => {
      f.insert(0, [
        group([
          container('a', [paragraph('keep me')]),
          container('b', [new Y.XmlElement('futureBlockType')]),
        ]),
      ]);
    });
    expect(after).toContain('futureblocktype');
    expect(after).toBe(before);
    expect(standIns).toEqual(['futureBlockType']);
  });

  it('survives as a direct child of a blockGroup', () => {
    const { before, after, standIns } = visit((f) => {
      f.insert(0, [
        group([
          container('a', [paragraph('keep me')]),
          new Y.XmlElement('futureTopLevelContainer'),
        ]),
      ]);
    });
    expect(after).toContain('futuretoplevelcontainer');
    expect(after).toBe(before);
    expect(standIns).toEqual(['futureTopLevelContainer']);
  });

  it('survives at the fragment root, where nothing can stand in for it', () => {
    const { before, after, standIns } = visit((f) => {
      f.insert(0, [
        group([container('a', [paragraph('keep me')])]),
        new Y.XmlElement('futureRootThing'),
      ]);
    });
    // The shared document is what has to survive, and it does.
    expect(after).toContain('futurerootthing');
    expect(after).toBe(before);
    // It does NOT reach the local document, and no wrapping can change that:
    // `doc` holds ONE `blockGroup`, so a second top-level node has no legal
    // position no matter what it is wrapped in. This client shows the document
    // one element short while every peer that knows the name shows it whole —
    // and a build that learns the name later shows it too, because the bytes
    // were never touched. Measured rather than assumed: the patch does produce
    // a wrapped stand-in here, and ProseMirror drops it for want of a slot.
    expect(standIns).toEqual([]);
  });

  it('survives in a blockContainer\'s child-group slot', () => {
    const { before, after, standIns } = visit((f) => {
      f.insert(0, [
        group([
          container('a', [paragraph('keep me'), new Y.XmlElement('futureChildGroup')]),
        ]),
      ]);
    });
    expect(after).toContain('futurechildgroup');
    expect(after).toBe(before);
    expect(standIns).toEqual(['futureChildGroup']);
  });

  it('survives inside a paragraph', () => {
    const { before, after, standIns } = visit((f) => {
      const p = paragraph('keep me');
      p.insert(1, [new Y.XmlElement('futureInlineThing')]);
      f.insert(0, [group([container('a', [p])])]);
    });
    expect(after).toContain('futureinlinething');
    expect(after).toBe(before);
    expect(standIns).toEqual(['futureInlineThing']);
  });
});

describe('a mark this build does not know', () => {
  /**
   * Builds a paragraph whose text carries the given attributes.
   * @param text - The text.
   * @param attrs - The mark attributes to stamp on it.
   * @returns The paragraph element.
   */
  function markedParagraph(
    text: string,
    attrs: Record<string, unknown>,
  ): Y.XmlElement {
    const el = new Y.XmlElement('paragraph');
    el.setAttribute('backgroundColor', 'default');
    el.setAttribute('textColor', 'default');
    el.setAttribute('textAlignment', 'left');
    const content = new Y.XmlText();
    content.insert(0, text, attrs);
    el.insert(0, [content]);
    return el;
  }

  it('keeps the text and the mark', () => {
    const { before, after } = visit((f) => {
      f.insert(0, [
        group([
          container('a', [markedParagraph('marked', { futureMark: true })]),
        ]),
      ]);
    });
    expect(after).toContain('marked');
    expect(after).toBe(before);
  });

  it('keeps two unknown marks on one span', () => {
    const { before, after } = visit((f) => {
      f.insert(0, [
        group([
          container('a', [
            markedParagraph('marked', { futureOne: true, futureTwo: 'x' }),
          ]),
        ]),
      ]);
    });
    expect(after).toContain('futureOne');
    expect(after).toContain('futureTwo');
    expect(after).toBe(before);
  });

  it('keeps an unknown mark inside a code block', () => {
    const { before, after } = visit((f) => {
      const code = new Y.XmlElement('codeBlock');
      code.setAttribute('language', 'text');
      const content = new Y.XmlText();
      content.insert(0, 'code', { futureMark: true });
      code.insert(0, [content]);
      f.insert(0, [group([container('a', [code])])]);
    });
    expect(after).toContain('futureMark');
    expect(after).toBe(before);
  });
});
