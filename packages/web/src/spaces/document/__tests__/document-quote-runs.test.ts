// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A8 · C3: what counts as one run of quote.
 *
 * A quote is a prop on each block rather than a container, so what the reader
 * sees as one quote is however many blocks carry it in a row. "In a row" is
 * READING order — the order the blocks are drawn in, which is the order the
 * user sees them stacked. An indented block follows the one it is indented
 * under, so a quoted parent and its quoted first child are one run even though
 * they sit at different depths.
 *
 * The numbering already divides lists by this same boundary (§3.4: a quoted
 * list starts at one, whatever the list outside it read), so both read it from
 * here.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { quoteRuns } from '@web/spaces/document/document-quote-runs';

let schema: Schema;

beforeAll(() => {
  schema = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  }).pmSchema;
});

/** One block, as the fixtures describe it. */
interface Spec {
  readonly id: string;
  readonly quoted?: boolean;
  readonly children?: readonly Spec[];
}

/**
 * Builds one `blockContainer`, with a child group when the spec nests.
 * @param spec - The block to build.
 * @returns The container node.
 */
function container(spec: Spec): PMNode {
  const content = schema.nodes['paragraph'].create({
    quoted: spec.quoted === true,
  });
  const parts: PMNode[] = [content];
  if (spec.children !== undefined && spec.children.length > 0) {
    parts.push(
      schema.nodes['blockGroup'].create(null, spec.children.map(container)),
    );
  }
  return schema.nodes['blockContainer'].create({ id: spec.id }, parts);
}

/**
 * The runs a document of these blocks holds.
 * @param specs - The top-level blocks, in order.
 * @returns Each run's block ids, in reading order.
 */
function runsOf(specs: readonly Spec[]): string[][] {
  return quoteRuns(docOf(specs)).map((run) => [...run.ids]);
}

/**
 * The block drawn right after each run.
 * @param specs - The top-level blocks, in order.
 * @returns One entry per run, in document order.
 */
function aftersOf(specs: readonly Spec[]): (string | null)[] {
  return quoteRuns(docOf(specs)).map((run) => run.after);
}

/**
 * A document holding these blocks.
 * @param specs - The top-level blocks, in order.
 * @returns The document node.
 */
function docOf(specs: readonly Spec[]): PMNode {
  return schema.nodes['doc'].create(
    null,
    schema.nodes['blockGroup'].create(null, specs.map(container)),
  );
}

/** A quoted block. */
function q(id: string, children?: readonly Spec[]): Spec {
  return { id, quoted: true, ...(children ? { children } : {}) };
}

/** A block carrying no quote. */
function plain(id: string, children?: readonly Spec[]): Spec {
  return { id, ...(children ? { children } : {}) };
}

describe('blocks in a row make one run', () => {
  it('reads three neighbouring quoted blocks as one run', () => {
    expect(runsOf([q('a'), q('b'), q('c')])).toEqual([['a', 'b', 'c']]);
  });

  it('reads a lone quoted block as a run of one', () => {
    expect(runsOf([plain('a'), q('b'), plain('c')])).toEqual([['b']]);
  });

  it('finds no run in a document holding no quote', () => {
    expect(runsOf([plain('a'), plain('b')])).toEqual([]);
  });
});

describe('a block carrying no quote ends the run', () => {
  it('splits two quoted blocks either side of a plain one', () => {
    expect(runsOf([q('a'), plain('b'), q('c')])).toEqual([['a'], ['c']]);
  });

  it('opens a second run after the gap and keeps counting', () => {
    expect(
      runsOf([q('a'), q('b'), plain('c'), q('d'), q('e')]),
    ).toEqual([
      ['a', 'b'],
      ['d', 'e'],
    ]);
  });
});

describe('indentation does not break a run', () => {
  it('joins a quoted block to the quoted block it is indented under', () => {
    expect(runsOf([q('parent', [q('child')])])).toEqual([['parent', 'child']]);
  });

  it('joins a quoted child to the quoted block that follows its parent', () => {
    // Reading order is parent, child, next — and the child is drawn between
    // the two, so all three stack without a gap.
    expect(runsOf([plain('parent', [q('child')]), q('next')])).toEqual([
      ['child', 'next'],
    ]);
  });

  it('ends the run at a plain child between two quoted blocks', () => {
    expect(runsOf([q('parent', [plain('child')]), q('next')])).toEqual([
      ['parent'],
      ['next'],
    ]);
  });

  it('keeps a deeper run going through three levels', () => {
    expect(runsOf([q('one', [q('two', [q('three')])])])).toEqual([
      ['one', 'two', 'three'],
    ]);
  });
});

describe('what is drawn right after a run', () => {
  it('names the block that follows a run at the same level', () => {
    expect(aftersOf([q('a'), q('b'), plain('c')])).toEqual(['c']);
  });

  it('names the block that follows a run ending inside an indent', () => {
    // The run's last block is `child`, one level in; `next` sits back out at
    // the top. Reading order puts them next to each other and the screen
    // stacks them, but they are in different groups — a CSS sibling
    // combinator does not reach from one to the other, which is why this is
    // read off the walk instead.
    expect(aftersOf([q('parent', [q('child')]), plain('next')])).toEqual([
      'next',
    ]);
  });

  it('names nothing for a run the document ends on', () => {
    expect(aftersOf([plain('a'), q('b'), q('c')])).toEqual([null]);
  });

  it('names one block per run', () => {
    expect(aftersOf([q('a'), plain('b'), q('c'), plain('d')])).toEqual([
      'b',
      'd',
    ]);
  });
});
