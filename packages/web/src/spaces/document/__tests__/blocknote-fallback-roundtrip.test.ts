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
import { TextSelection } from '@tiptap/pm/state';
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

  // The whole suite shares one process, so an editor left standing keeps its
  // listeners and observers alive for every file after this one.
  editor.unmount();

  return { before, after: fragment.toString(), standIns };
}

/**
 * The same visit, with one keystroke typed into a block that IS known.
 *
 * Mounting alone leaves the shared document untouched, so a stand-in that
 * cannot be written back looks identical to one that can. The write-back only
 * happens once something changes: from the first local edit, y-prosemirror
 * reconciles the whole fragment against the local document, and every stand-in
 * is then written back over the element it stood in for.
 * @param build - Fills the fragment with the shape under test.
 * @returns The shared document before mounting and after the keystroke.
 */
function visitAndType(build: (fragment: Y.XmlFragment) => void): {
  before: string;
  after: string;
} {
  const remote = new Y.Doc();
  build(documentBodyFragment(remote));

  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
  const fragment = documentBodyFragment(local);
  const before = fragment.toString();

  const editor = buildDocumentEditor({
    fragment,
    extensions: [documentFallbackExtension()],
  });
  editor.mount(document.createElement('div'));

  const view = editor.prosemirrorView!;
  // Into the first paragraph the shape carries, which every case below has:
  // an edit somewhere the editor understands, of the kind a reader makes
  // without ever going near the element a peer sent.
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at === -1 && node.type.name === 'paragraph') at = pos + 1;
    return at === -1;
  });
  expect(at, 'the shape carries a paragraph to type into').toBeGreaterThan(-1);
  view.dispatch(view.state.tr.insertText('!', at));

  const after = fragment.toString();
  editor.unmount();
  return { before, after };
}

/**
 * The same visit, with one key pressed in a block that IS known.
 *
 * Typing and pressing a key reach the write-back by different routes: typing
 * changes a block's text and leaves every block where it was, while a key
 * bound to a structural command moves blocks between parents. The second
 * shape is the one that runs the children out of step.
 * @param build - Fills the fragment with the shape under test.
 * @param inText - Text of the node to put the caret in.
 * @param key - The key to press, in ProseMirror's chord notation.
 * @returns The shared document before mounting and after the key.
 */
function visitAndPress(
  build: (fragment: Y.XmlFragment) => void,
  inText: string,
  key: string,
): { before: string; after: string } {
  const remote = new Y.Doc();
  build(documentBodyFragment(remote));

  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
  const fragment = documentBodyFragment(local);
  const before = fragment.toString();

  const editor = buildDocumentEditor({
    fragment,
    extensions: [documentFallbackExtension()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);

  const view = editor.prosemirrorView!;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text === inText) at = pos + 1;
    return at === -1;
  });
  expect(at, `the shape carries "${inText}"`).toBeGreaterThan(-1);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));

  const [modifier, base] = key.includes('+') ? key.split('+') : [null, key];
  const event = new KeyboardEvent('keydown', {
    key: base as string,
    shiftKey: modifier === 'Shift',
    bubbles: true,
  });
  view.someProp('handleKeyDown', (handler) => handler(view, event));

  const after = fragment.toString();
  editor.unmount();
  return { before, after };
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

describe('an unknown element after this client edits something else', () => {
  // The write-back is where a stand-in either carries the element home or
  // replaces it. Everything above stops at mounting, which never reaches it.

  /**
   * An unknown element with an attribute and a child a peer can read.
   * @param name - The element name this build does not know.
   * @returns That element.
   */
  function furnished(name: string): Y.XmlElement {
    const el = new Y.XmlElement(name);
    el.setAttribute('colour', 'crimson');
    el.insert(0, [paragraph('inner text a peer can read')]);
    return el;
  }

  it('keeps a blockGroup child whole, attribute and children', () => {
    const { before, after } = visitAndType((f) => {
      f.insert(0, [
        group([
          container('a', [paragraph('keep me')]),
          furnished('futureTopLevelContainer'),
        ]),
      ]);
    });

    expect(before).toContain('colour="crimson"');
    expect(after).toContain('futuretoplevelcontainer');
    expect(after).toContain('colour="crimson"');
    expect(after).toContain('inner text a peer can read');
  });

  it('keeps a blockContent child whole, attribute and children', () => {
    const { before, after } = visitAndType((f) => {
      f.insert(0, [
        group([
          container('a', [paragraph('keep me')]),
          container('b', [furnished('futureBlockType')]),
        ]),
      ]);
    });

    expect(before).toContain('colour="crimson"');
    expect(after).toContain('futureblocktype');
    expect(after).toContain('colour="crimson"');
    expect(after).toContain('inner text a peer can read');
  });

  // A second element at the FRAGMENT ROOT is the one place a stand-in cannot
  // reach, and this records what happens to it rather than asserting a
  // guarantee the shape cannot give. The document's top node holds
  // `content: "blockGroup"` — exactly one, measured in `@blocknote/core`'s doc
  // spec — so a local document has nowhere to put a second root child. It
  // survives mounting, which the case above this describe block covers; from
  // the first edit the write-back has only the local document to go on, and
  // there the element was never represented.
  //
  // Reaching this needs a newer build of OUR OWN code writing a second child
  // to the fragment root, which would mean changing that top node's content
  // rule. No build does, and this is the boundary of what the stand-in
  // mechanism covers.
  it('loses a second fragment-root element once this client edits', () => {
    const { before, after } = visitAndType((f) => {
      f.insert(0, [
        group([container('a', [paragraph('keep me')])]),
        furnished('futureRootThing'),
      ]);
    });

    expect(before).toContain('futurerootthing');
    expect(after).not.toContain('futurerootthing');
    // What the reader was editing is untouched, which is what keeps this a
    // boundary rather than a fault: the keystroke landed and the known blocks
    // came through whole.
    expect(after).toContain('!keep me');
  });

  // Typing leaves the block structure alone, so the write-back walks the
  // children in step and `meta.mapping` answers for the stand-in's slot. An
  // edit that MOVES blocks does not: the walk runs out of matching pairs and
  // falls to `matchNodeName`, which compares an element's name against the
  // stand-in's own — never equal, by construction. Tab is the shortest way
  // there, and C1 puts it on every block.
  it('keeps a blockGroup child whole when Tab moves the block after it', () => {
    const { before, after } = visitAndPress(
      (f) => {
        f.insert(0, [
          group([
            container('a', [paragraph('first')]),
            furnished('futureTopLevelContainer'),
            container('c', [paragraph('third')]),
          ]),
        ]);
      },
      'third',
      'Tab',
    );

    expect(before).toContain('colour="crimson"');
    expect(after).toContain('futuretoplevelcontainer');
    expect(after).toContain('colour="crimson"');
    expect(after).toContain('inner text a peer can read');
  });

  it('keeps a blockContent child whole when Tab moves the block after it', () => {
    const { before, after } = visitAndPress(
      (f) => {
        f.insert(0, [
          group([
            container('a', [paragraph('first'), furnished('futureNested')]),
            container('c', [paragraph('third')]),
          ]),
        ]);
      },
      'third',
      'Tab',
    );

    expect(before).toContain('colour="crimson"');
    expect(after).toContain('futurenested');
    expect(after).toContain('colour="crimson"');
    expect(after).toContain('inner text a peer can read');
  });

  it('keeps it whole when Shift-Tab moves a block back out', () => {
    const { before, after } = visitAndPress(
      (f) => {
        f.insert(0, [
          group([
            container('a', [
              paragraph('first'),
              group([
                furnished('futureOutdent'),
                container('c', [paragraph('third')]),
              ]),
            ]),
          ]),
        ]);
      },
      'third',
      'Shift+Tab',
    );

    expect(before).toContain('colour="crimson"');
    expect(after).toContain('futureoutdent');
    expect(after).toContain('colour="crimson"');
    expect(after).toContain('inner text a peer can read');
  });
});

describe('where in the parent the unknown element sits', () => {
  // The stand-in is asked to join a slot the parent's content rule describes,
  // and that rule is answered POSITION BY POSITION. Asking only about the
  // start of the expression is what once deleted a whole list item — the
  // user's text with it — because a block-level stand-in cannot open one.

  /**
   * Builds a block, with a stand-in for the name the schema does not know.
   * @param type - The block node's name.
   * @param text - Its text, if any.
   * @returns The container element.
   */
  const block = (type: string, text = ''): Y.XmlElement => {
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', `id-${type}-${text || 'empty'}`);
    const content = new Y.XmlElement(type);
    if (text) content.insert(0, [new Y.XmlText(text)]);
    container.insert(0, [content]);
    return container;
  };

  it('stands in for a block that follows the content of a list item', () => {
    // `blockContainer` is `blockContent blockGroup?`, so the second position
    // takes a group. The stand-in joins it wrapped, and the item's own text
    // is untouched.
    const { before, after, standIns } = visit((f) => {
      const group = new Y.XmlElement('blockGroup');
      const item = new Y.XmlElement('blockContainer');
      item.setAttribute('id', 'the-item');
      const content = new Y.XmlElement('bulletListItem');
      content.insert(0, [new Y.XmlText('written by a person')]);
      item.insert(0, [content, new Y.XmlElement('somethingNewer')]);
      group.insert(0, [item]);
      f.insert(0, [group]);
    });

    expect(after).toBe(before);
    expect(after).toContain('written by a person');
    expect(standIns).toEqual(['somethingNewer']);
  });

  it('loses only the unknown element when the first slot refuses one', () => {
    // A code block holds `text*`, so nothing can stand in for a node inside
    // it. The block and its characters stay; the one element goes.
    const { after, standIns } = visit((f) => {
      const group = new Y.XmlElement('blockGroup');
      const item = new Y.XmlElement('blockContainer');
      item.setAttribute('id', 'the-code');
      const content = new Y.XmlElement('codeBlock');
      content.insert(0, [new Y.XmlText('const a = 1')]);
      content.insert(1, [new Y.XmlElement('somethingNewer')]);
      item.insert(0, [content]);
      group.insert(0, [item]);
      f.insert(0, [group]);
    });

    expect(after).toContain('const a = 1');
    expect(standIns).toEqual([]);
  });

  it('takes the type it was replaced by into account for the next sibling', () => {
    // Two unknown blocks in a row. The second is asked whether it fits AFTER
    // the first — and what sits there by then is the stand-in, not the name
    // the document carried.
    const { before, after, standIns } = visit((f) => {
      const group = new Y.XmlElement('blockGroup');
      group.insert(0, [block('paragraph', 'kept')]);
      const first = new Y.XmlElement('blockContainer');
      first.setAttribute('id', 'first-unknown');
      first.insert(0, [new Y.XmlElement('somethingNewer')]);
      const second = new Y.XmlElement('blockContainer');
      second.setAttribute('id', 'second-unknown');
      second.insert(0, [new Y.XmlElement('somethingElse')]);
      group.insert(1, [first, second]);
      f.insert(0, [group]);
    });

    expect(after).toBe(before);
    expect(after).toContain('kept');
    expect(standIns).toEqual(['somethingNewer', 'somethingElse']);
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

  it('stands in for the title element older Spaces were seeded with', () => {
    // The one unknown name that really is out there. Document Spaces created
    // before this build carry a `title` element at the fragment root, and it
    // is the whole reason the stand-ins have to reach the local document
    // rather than only survive in the shared one: a reader of one of those
    // Spaces sees the block, named, instead of a document that opens one
    // element short.
    const { before, after, standIns } = visit((f) => {
      const title = new Y.XmlElement('title');
      title.insert(0, [new Y.XmlText('Old document name')]);
      f.push([title]);
    });
    expect(standIns).toEqual(['title']);
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
