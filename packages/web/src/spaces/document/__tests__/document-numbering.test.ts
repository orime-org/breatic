// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 C3–C9b: the numbers the reader sees, computed from the document
 * alone.
 *
 * Two counting rules live here, and they answer to different things (§3.4):
 * a numbered heading counts within the headings of its own level, ignoring
 * indentation entirely; every other numbered item counts within ONE list,
 * and a list is "the blocks at one indentation level under one parent, in one
 * run of quoted-or-not". Change indentation and you change which list an item
 * belongs to; put it in a quote and you take it out of the list around it.
 *
 * A block that is both — an ordered item the user made a heading — draws its
 * number from the headings, so the list it sits in numbers the items around it
 * as though it were not there (user 2026-09-02).
 *
 * Every assertion below reads the LITERAL string the function hands the
 * decoration layer, because the two shapes differ in their punctuation and a
 * test that normalised them away would agree with a bug that dropped it
 * (§6.3): a list item gets `"1."`, a numbered heading gets `"1.1"` — dots
 * between levels, none at the end.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { computeNumbering } from '@web/spaces/document/document-numbering';
import { quoteRuns } from '@web/spaces/document/document-quote-runs';
import { runBlockType } from '@web/spaces/document/document-block-run';

/** One block, as the fixtures describe it. */
interface Spec {
  readonly id: string;
  readonly type: 'paragraph' | 'heading' | 'numberedListItem' | 'bulletListItem';
  readonly props?: Readonly<Record<string, unknown>>;
  /** Blocks nested one indentation level under this one. */
  readonly children?: readonly Spec[];
}

let schema: Schema;

beforeAll(() => {
  // Never mounted: the schema is assembled at creation, and the whole suite
  // runs in one process (`singleFork`), where a mounted editor would keep its
  // listeners and observers alive for every file after this one.
  schema = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  }).pmSchema;
});

/**
 * Builds one `blockContainer`, with a child group when the spec nests.
 * @param spec - The block to build.
 * @returns The container node.
 * @throws {RangeError} When the spec names a type the schema does not hold.
 */
function container(spec: Spec): PMNode {
  const content = schema.nodes[spec.type]?.create(spec.props ?? {});
  if (content === undefined) {
    throw new RangeError(`no node type ${spec.type}`);
  }
  const parts: PMNode[] = [content];
  if (spec.children !== undefined && spec.children.length > 0) {
    const group = schema.nodes['blockGroup']?.create(
      null,
      spec.children.map(container),
    );
    if (group !== undefined) {
      parts.push(group);
    }
  }
  return schema.nodes['blockContainer'].create({ id: spec.id }, parts);
}

/**
 * Builds a whole document out of top-level specs.
 * @param specs - The top-level blocks, in order.
 * @returns The doc node.
 */
function docOf(specs: readonly Spec[]): PMNode {
  const group = schema.nodes['blockGroup'].create(null, specs.map(container));
  return schema.nodes['doc'].create(null, group);
}

/**
 * The numbers for a document, keyed by block id.
 * @param specs - The top-level blocks, in order.
 * @returns Block id to the string the reader sees.
 */
function numbersFor(specs: readonly Spec[]): Map<string, string> {
  const doc = docOf(specs);
  return computeNumbering(doc, quoteRuns(doc));
}

/** A numbered list item. */
function li(id: string, props: Record<string, unknown> = {}): Spec {
  return { id, type: 'numberedListItem', props };
}

/** A numbered heading at the given level. */
function h(
  id: string,
  level: number,
  props: Record<string, unknown> = {},
): Spec {
  return { id, type: 'heading', props: { level, numbered: true, ...props } };
}

describe('C3 — a quote takes its blocks out of the list around them', () => {
  it('numbers the quoted run on its own and closes the outer run over it', () => {
    const n = numbersFor([
      li('one'),
      li('two', { quoted: true }),
      li('three'),
      li('four'),
    ]);
    expect(n.get('one')).toBe('1.');
    expect(n.get('two')).toBe('1.');
    expect(n.get('three')).toBe('2.');
    expect(n.get('four')).toBe('3.');
  });

  it('reads one unbroken list once the quote is taken off again', () => {
    const n = numbersFor([li('one'), li('two'), li('three'), li('four')]);
    expect([...n.values()]).toEqual(['1.', '2.', '3.', '4.']);
  });
});

describe('C4 — one indentation level is one list', () => {
  it('restarts inside the indented run and resumes outside it', () => {
    const n = numbersFor([
      li('top1'),
      { ...li('top2'), children: [li('in1'), li('in2')] },
      li('top3'),
    ]);
    expect(n.get('top1')).toBe('1.');
    expect(n.get('top2')).toBe('2.');
    expect(n.get('in1')).toBe('1.');
    expect(n.get('in2')).toBe('2.');
    expect(n.get('top3')).toBe('3.');
  });
});

describe('C5 — a heading shows the whole level path', () => {
  it('writes one, two and three levels with dots between and none at the end', () => {
    const n = numbersFor([h('a', 1), h('b', 2), h('c', 3)]);
    expect(n.get('a')).toBe('1');
    expect(n.get('b')).toBe('1.1');
    expect(n.get('c')).toBe('1.1.1');
  });
});

describe('C6 — only numbered headings are counted', () => {
  it('skips the heading that carries no number', () => {
    const n = numbersFor([
      h('first', 1),
      h('second', 1),
      { id: 'third', type: 'heading', props: { level: 1 } },
      h('under-third', 2),
    ]);
    expect(n.get('first')).toBe('1');
    expect(n.get('second')).toBe('2');
    expect(n.has('third')).toBe(false);
    expect(n.get('under-third')).toBe('2.1');
  });
});

describe('C7 — a document that opens on a level-two heading', () => {
  it('shows 1.1 for it and 1 for the first real level-one heading after it', () => {
    const n = numbersFor([h('deep', 2), h('top', 1)]);
    expect(n.get('deep')).toBe('1.1');
    expect(n.get('top')).toBe('1');
  });
});

describe('C8 — a number the user pinned stays put', () => {
  it('holds at the pinned value and counts on from it', () => {
    const n = numbersFor([li('a'), li('b', { number: 7 }), li('c')]);
    expect(n.get('a')).toBe('1.');
    expect(n.get('b')).toBe('7.');
    expect(n.get('c')).toBe('8.');
  });
});

describe('C9 — a heading’s number ignores indentation', () => {
  it('counts an indented level-two heading with the level-two headings above it', () => {
    const n = numbersFor([
      h('one', 1),
      h('two-a', 2),
      { ...h('holder', 1), children: [{ ...h('two-b', 2) }] },
    ]);
    expect(n.get('two-a')).toBe('1.1');
    expect(n.get('two-b')).toBe('2.1');
  });

  it('gives the same heading the same number at either indentation', () => {
    const flat = numbersFor([h('one', 1), h('two-a', 2), h('two-b', 2)]);
    const nested = numbersFor([
      h('one', 1),
      { ...h('two-a', 2), children: [h('two-b', 2)] },
    ]);
    expect(nested.get('two-b')).toBe(flat.get('two-b'));
    expect(nested.get('two-b')).toBe('1.2');
  });
});

describe('C9b — a numbered heading leaves its list’s numbering', () => {
  it('lets the items around it close over the gap', () => {
    const n = numbersFor([li('first'), h('middle', 1), li('third')]);
    expect(n.get('first')).toBe('1.');
    expect(n.get('middle')).toBe('1');
    expect(n.get('third')).toBe('2.');
  });

  it('leaves the item after it first in the list, when it opened the list', () => {
    // demo §4.3: a sub-list of two, the first turned into a heading.
    const n = numbersFor([
      { ...li('top'), children: [h('became-heading', 1), li('second')] },
    ]);
    expect(n.get('top')).toBe('1.');
    expect(n.get('became-heading')).toBe('1');
    expect(n.get('second')).toBe('1.');
  });

  it('leaves a list further down untouched', () => {
    const n = numbersFor([
      h('intro', 1),
      { id: 'prose', type: 'paragraph' },
      li('a'),
      li('b'),
    ]);
    expect(n.get('intro')).toBe('1');
    expect(n.get('a')).toBe('1.');
    expect(n.get('b')).toBe('2.');
  });

  it('starts the quoted list at one, whatever the list outside it read', () => {
    const n = numbersFor([
      li('outer1'),
      li('outer2'),
      h('quoted-head', 1, { quoted: true }),
      li('quoted-a', { quoted: true }),
      li('quoted-b', { quoted: true }),
    ]);
    expect(n.get('outer1')).toBe('1.');
    expect(n.get('outer2')).toBe('2.');
    expect(n.get('quoted-head')).toBe('1');
    expect(n.get('quoted-a')).toBe('1.');
    expect(n.get('quoted-b')).toBe('2.');
  });
});

describe('blocks that carry no number', () => {
  it('leaves paragraphs, bullets and unnumbered headings out of the map', () => {
    const n = numbersFor([
      { id: 'p', type: 'paragraph' },
      { id: 'b', type: 'bulletListItem' },
      { id: 'h', type: 'heading', props: { level: 1 } },
    ]);
    expect([...n.keys()]).toEqual([]);
  });

  it('does not let a paragraph between two list items break the run', () => {
    const n = numbersFor([li('a'), { id: 'p', type: 'paragraph' }, li('b')]);
    expect(n.get('a')).toBe('1.');
    expect(n.get('b')).toBe('2.');
  });
});

describe('the numbers a row press leaves behind', () => {
  // The cases above build a document and read it. These press a row on a live
  // editor first, which is what C3 and C9b ①② ask for: their subject is a
  // block the reader TURNED INTO something, and a fixture that starts out as
  // the result skips the step under test.
  const live: ReturnType<typeof buildDocumentEditor>[] = [];

  afterEach(() => {
    live.splice(0).forEach((editor) => {
      editor.unmount();
    });
  });

  /**
   * Opens a mounted editor over the given blocks.
   * @param blocks - What to put in it.
   * @returns The editor.
   */
  function openLive(
    blocks: readonly Readonly<Record<string, unknown>>[],
  ): ReturnType<typeof buildDocumentEditor> {
    const editor = buildDocumentEditor({
      fragment: documentBodyFragment(new Y.Doc()),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);
    live.push(editor);
    editor.replaceBlocks(editor.document, blocks as never);
    return editor;
  }

  /**
   * Presses Enter through the keymap.
   * @param editor - The editor to press Enter in.
   */
  function pressEnter(editor: ReturnType<typeof buildDocumentEditor>): void {
    const view = editor.prosemirrorView;
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    view.someProp('handleKeyDown', (handler) => handler(view, event));
  }

  /** Every block id in reading order, nested blocks included. */
  function idsInOrder(
    blocks: readonly { id: string; children?: readonly unknown[] }[],
  ): string[] {
    return blocks.flatMap((block) => [
      block.id,
      ...idsInOrder(
        (block.children ?? []) as readonly {
          id: string;
          children?: readonly unknown[];
        }[],
      ),
    ]);
  }

  /** What each block shows, in reading order. */
  function shown(
    editor: ReturnType<typeof buildDocumentEditor>,
  ): (string | undefined)[] {
    const doc = editor.prosemirrorState.doc;
    const numbers = computeNumbering(doc, quoteRuns(doc));
    return idsInOrder(
      editor.document as unknown as { id: string; children?: unknown[] }[],
    ).map((id) => numbers.get(id));
  }

  it('C3 — puts the list back exactly as it was when the quote comes off', () => {
    const editor = openLive([
      { type: 'numberedListItem', content: 'one' },
      { type: 'numberedListItem', content: 'two' },
      { type: 'numberedListItem', content: 'three' },
      { type: 'numberedListItem', content: 'four' },
    ]);
    const before = editor.prosemirrorState.doc.toString();
    const second = (editor.document as unknown as { id: string }[])[1]!;

    editor.setTextCursorPosition(second.id, 'end');
    runBlockType(editor, 'quote');
    expect(shown(editor)).toEqual(['1.', '1.', '2.', '3.']);

    runBlockType(editor, 'quote');
    expect(shown(editor)).toEqual(['1.', '2.', '3.', '4.']);
    // The round trip, which the numbers alone do not settle: a press that
    // rebuilt the blocks could hand back the same numbers over a different
    // document.
    expect(editor.prosemirrorState.doc.toString()).toBe(before);
  });

  it('C3 — an Enter inside the quote leaves both runs counting their own', () => {
    // The other half of C3's criterion. The quoted run grows from one block to
    // two, both starting over at 1, while the list outside it stays one run
    // and closes over both of them.
    const editor = openLive([
      { type: 'numberedListItem', content: 'one' },
      { type: 'numberedListItem', content: 'two' },
      { type: 'numberedListItem', content: 'three' },
      { type: 'numberedListItem', content: 'four' },
    ]);
    const second = (editor.document as unknown as { id: string }[])[1]!;

    editor.setTextCursorPosition(second.id, 'end');
    runBlockType(editor, 'quote');
    pressEnter(editor);

    expect(shown(editor)).toEqual(['1.', '1.', '2.', '2.', '3.']);
    const quoted = (
      editor.document as unknown as { props: Record<string, unknown> }[]
    ).filter((block) => block.props['quoted'] === true);
    expect(quoted).toHaveLength(2);
  });

  it('C9b ① — lets the items close over one turned into a heading', () => {
    const editor = openLive([
      { type: 'numberedListItem', content: 'first' },
      { type: 'numberedListItem', content: 'middle' },
      { type: 'numberedListItem', content: 'third' },
    ]);
    const middle = (editor.document as unknown as { id: string }[])[1]!;

    editor.setTextCursorPosition(middle.id, 'end');
    runBlockType(editor, 'heading-1');

    expect(shown(editor)).toEqual(['1.', '1', '2.']);
  });

  it('C9b ② — leaves the item after it first, when it opened the list', () => {
    // demo §4.3: a sub-list of two, the first turned into a heading.
    const editor = openLive([
      {
        type: 'numberedListItem',
        content: 'top',
        children: [
          { type: 'numberedListItem', content: 'became-heading' },
          { type: 'numberedListItem', content: 'second' },
        ],
      },
    ]);
    const opener = (
      editor.document as unknown as { children: { id: string }[] }[]
    )[0]!.children[0]!;

    editor.setTextCursorPosition(opener.id, 'end');
    runBlockType(editor, 'heading-1');

    expect(shown(editor)).toEqual(['1.', '1', '1.']);
  });
});
