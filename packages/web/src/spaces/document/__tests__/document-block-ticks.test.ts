// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A5 · A7 的判据那半：which rows the menu ticks, and which one the
 * slot shows as this block's face.
 *
 * The rules (§3.1): the eight content rows are mutually exclusive except that
 * an ordered list coexists with any one heading, and Quote sits across all of
 * them. In BlockNote's flat model all three facts live on the block's own
 * content node — its type, its `level`, and the `numbered` and `quoted` props
 * — so none of the ancestor walking the nested model needed survives.
 *
 * Two behaviours carry over unchanged from what was delivered:
 *
 * - A row ticks only when EVERY block the selection covers is that row, and an
 *   empty selection ticks nothing (over an empty set "every block is" holds
 *   for all nine at once).
 * - The face is the exclusive row, so a heading inside a quote shows as a
 *   heading; Quote takes no part in it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  CONTENT_ROWS,
  faceOf,
  tickedOver,
} from '@web/spaces/document/document-block-ticks';

let schema: Schema;

beforeAll(() => {
  schema = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  }).pmSchema;
});

/** One block, as the fixtures describe it. */
interface Spec {
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

/**
 * Builds a document out of one block per spec, each holding one word.
 * @param specs - The blocks, in order.
 * @returns The doc node.
 */
function docOf(specs: readonly Spec[]): PMNode {
  const containers = specs.map((spec, index) => {
    const content = schema.nodes[spec.type]!.create(
      spec.props ?? {},
      schema.text(`b${String(index)}`),
    );
    return schema.nodes['blockContainer']!.create(
      { id: `b${String(index)}` },
      content,
    );
  });
  return schema.nodes['doc']!.create(
    null,
    schema.nodes['blockGroup']!.create(null, containers),
  );
}

/**
 * A selection covering every block in the document.
 * @param doc - The document.
 * @returns The selection.
 */
function overAll(doc: PMNode): TextSelection {
  return TextSelection.create(doc, 1, doc.content.size - 1);
}

/**
 * A selection inside the first block only.
 * @param doc - The document.
 * @returns The selection.
 */
function inFirst(doc: PMNode): TextSelection {
  return TextSelection.create(doc, 3, 3);
}

/** The rows ticked for a document holding one block. */
function ticksOfOne(spec: Spec): string[] {
  const doc = docOf([spec]);
  return [...tickedOver(doc, overAll(doc))].sort();
}

describe('each of the eight content rows ticks for its own block', () => {
  const CASES = [
    { spec: { type: 'paragraph' }, row: 'paragraph' },
    { spec: { type: 'heading', props: { level: 1 } }, row: 'heading-1' },
    { spec: { type: 'heading', props: { level: 2 } }, row: 'heading-2' },
    { spec: { type: 'heading', props: { level: 3 } }, row: 'heading-3' },
    { spec: { type: 'codeBlock' }, row: 'code-block' },
    { spec: { type: 'bulletListItem' }, row: 'bullet-list' },
    { spec: { type: 'numberedListItem' }, row: 'ordered-list' },
    { spec: { type: 'checkListItem' }, row: 'task-list' },
  ] as const;

  CASES.forEach(({ spec, row }) => {
    it(`ticks ${row} and nothing else`, () => {
      expect(ticksOfOne(spec)).toEqual([row]);
    });
  });
});

describe('A5 — an ordered item that is also a heading ticks both', () => {
  ([1, 2, 3] as const).forEach((level) => {
    it(`ticks ordered-list and heading-${String(level)} together`, () => {
      expect(
        ticksOfOne({ type: 'heading', props: { level, numbered: true } }),
      ).toEqual(['heading-' + String(level), 'ordered-list'].sort());
    });
  });

  it('leaves ordered-list unticked until the heading carries a number', () => {
    expect(ticksOfOne({ type: 'heading', props: { level: 1 } })).toEqual([
      'heading-1',
    ]);
  });
});

describe('A7 — Quote ticks alongside whichever row the block is', () => {
  const EIGHT = [
    { type: 'paragraph', row: 'paragraph' },
    { type: 'heading', props: { level: 1 }, row: 'heading-1' },
    { type: 'heading', props: { level: 2 }, row: 'heading-2' },
    { type: 'heading', props: { level: 3 }, row: 'heading-3' },
    { type: 'codeBlock', row: 'code-block' },
    { type: 'bulletListItem', row: 'bullet-list' },
    { type: 'numberedListItem', row: 'ordered-list' },
    { type: 'checkListItem', row: 'task-list' },
  ] as const;

  EIGHT.forEach(({ type, row, ...rest }) => {
    it(`ticks quote and ${row} together`, () => {
      const props = { ...(rest as { props?: object }).props, quoted: true };
      expect(ticksOfOne({ type, props })).toEqual([row, 'quote'].sort());
    });
  });
});

describe('a row ticks only when every block in the selection is it', () => {
  it('ticks nothing across two different types', () => {
    const doc = docOf([{ type: 'paragraph' }, { type: 'codeBlock' }]);
    expect([...tickedOver(doc, overAll(doc))]).toEqual([]);
  });

  it('ticks the shared row across two blocks that agree', () => {
    const doc = docOf([
      { type: 'bulletListItem' },
      { type: 'bulletListItem' },
    ]);
    expect([...tickedOver(doc, overAll(doc))]).toEqual(['bullet-list']);
  });

  it('ticks quote only when both blocks carry it', () => {
    const doc = docOf([
      { type: 'paragraph', props: { quoted: true } },
      { type: 'paragraph' },
    ]);
    expect([...tickedOver(doc, overAll(doc))]).toEqual(['paragraph']);
  });
});

describe('a selection covering no block ticks nothing', () => {
  it('leaves every row unticked rather than ticking all nine', () => {
    // "every block is this row" holds for all nine at once over an empty set.
    const doc = docOf([{ type: 'paragraph' }]);
    expect([...tickedOver(doc, TextSelection.create(doc, 0, 0))]).toEqual([]);
  });
});

describe('the face the slot shows', () => {
  it('never offers Quote as a face', () => {
    expect(CONTENT_ROWS).not.toContain('quote');
    expect(CONTENT_ROWS).toHaveLength(8);
  });

  it('shows the heading, not the quote it sits in', () => {
    const doc = docOf([
      { type: 'heading', props: { level: 2, quoted: true } },
    ]);
    expect(faceOf(doc, inFirst(doc))).toBe('heading-2');
  });

  it('shows the heading, not the ordered list it belongs to', () => {
    // What the reader sees on that line is a heading: the heading's size, and
    // a heading path where a list marker would be.
    const doc = docOf([
      { type: 'heading', props: { level: 1, numbered: true } },
    ]);
    expect(faceOf(doc, inFirst(doc))).toBe('heading-1');
  });

  it('falls back to paragraph when the selection is over nothing', () => {
    const doc = docOf([{ type: 'paragraph' }]);
    expect(faceOf(doc, TextSelection.create(doc, 0, 0))).toBe('paragraph');
  });
});
