// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import {
  ReferenceMention,
  referenceMentionContent,
} from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import {
  planWhitespaceInsertions,
  resolveDeletionUnit,
  chipDeletionUnit,
} from '@web/spaces/canvas/generate/reference-mention-whitespace';

const chipA: ReferenceRailItem = {
  refId: 'a->me',
  sourceNodeId: 'a',
  sourceNodeType: 'image',
  sourceNodeName: 'A',
  thumbnail: 'a.png',
};
const chipB: ReferenceRailItem = {
  refId: 'b->me',
  sourceNodeId: 'b',
  sourceNodeType: 'image',
  sourceNodeName: 'B',
  thumbnail: 'b.png',
};

/**
 * A bare editor carrying the ReferenceMention schema; used only to obtain a live
 * schema for hand-building precise docs (the pure planners take a doc, not an
 * editor, so no transactions / normalization run here).
 * @returns The editor (caller destroys).
 */
function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      ReferenceMention.configure({
        suggestion: makeReferenceSuggestion({
          getPool: () => [],
          emptyLabel: 'No references',
        }),
      }),
    ],
  });
}

/**
 * Builds a chip node from a pool item using the shared attr builder.
 * @param schema - The editor schema.
 * @param item - The reference pool item.
 * @returns The reference-mention chip node.
 */
function chip(schema: Schema, item: ReferenceRailItem): PMNode {
  return schema.node(REFERENCE_MENTION_NODE, referenceMentionContent(item).attrs);
}

/**
 * Builds a single-paragraph doc from inline nodes.
 * @param schema - The editor schema.
 * @param inline - The paragraph's inline children.
 * @returns The doc node.
 */
function docOf(schema: Schema, inline: PMNode[]): PMNode {
  return schema.node('doc', null, [schema.node('paragraph', null, inline)]);
}

/**
 * Runs `fn` with a live schema, destroying the throwaway editor after.
 * @param fn - Receives the schema, returns a value.
 * @returns Whatever `fn` returns.
 */
function withSchema<T>(fn: (schema: Schema) => T): T {
  const editor = makeEditor();
  try {
    return fn(editor.schema);
  } finally {
    editor.destroy();
  }
}

describe('planWhitespaceInsertions — additive whitespace invariant', () => {
  it('two adjacent chips: fills leading, shared-between, and trailing gaps (descending, deduped)', () => {
    withSchema((s) => {
      // para[ chipA(1-2), chipB(2-3) ]; content.size = 3.
      const doc = docOf(s, [chip(s, chipA), chip(s, chipB)]);
      // left of A = 1, shared A|B = 2 (deduped), right of B = 3.
      expect(planWhitespaceInsertions(doc)).toEqual([3, 2, 1]);
    });
  });

  it('chip then text: fills left + right of the chip only', () => {
    withSchema((s) => {
      // para[ chipA(1-2), 'hi'(2-4) ]
      const doc = docOf(s, [chip(s, chipA), s.text('hi')]);
      expect(planWhitespaceInsertions(doc)).toEqual([2, 1]);
    });
  });

  it('text then chip: fills left + right of the chip', () => {
    withSchema((s) => {
      // para[ 'hi'(1-3), chipA(3-4) ]
      const doc = docOf(s, [s.text('hi'), chip(s, chipA)]);
      expect(planWhitespaceInsertions(doc)).toEqual([4, 3]);
    });
  });

  it('is idempotent: a single spaced chip yields no insertions', () => {
    withSchema((s) => {
      // para[ ' ', chipA, ' ' ]
      const doc = docOf(s, [s.text(' '), chip(s, chipA), s.text(' ')]);
      expect(planWhitespaceInsertions(doc)).toEqual([]);
    });
  });

  it('is idempotent for adjacent chips sharing one middle space', () => {
    withSchema((s) => {
      // para[ ' ', chipA, ' ', chipB, ' ' ] — the single middle space serves both
      const doc = docOf(s, [
        s.text(' '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB),
        s.text(' '),
      ]);
      expect(planWhitespaceInsertions(doc)).toEqual([]);
    });
  });

  it('does not touch a user space already present (no duplication)', () => {
    withSchema((s) => {
      // para[ 'x ', chipA, ' y' ] — chip already flanked by spaces
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(planWhitespaceInsertions(doc)).toEqual([]);
    });
  });

  it('returns [] for plain text', () => {
    withSchema((s) => {
      expect(planWhitespaceInsertions(docOf(s, [s.text('hello')]))).toEqual([]);
    });
  });

  it('returns [] for an empty paragraph', () => {
    withSchema((s) => {
      expect(planWhitespaceInsertions(s.node('doc', null, [s.node('paragraph')]))).toEqual([]);
    });
  });
});

describe('resolveDeletionUnit — chip + exclusive owned spaces delete as one unit', () => {
  it('S1 `文␣▢|␣文` Backspace → deletes both exclusive spaces + chip (no residue)', () => {
    withSchema((s) => {
      // para[ 'x '(1-3), chipC(3-4), ' y'(4-6) ]; cursor pos 4 (between chip and right space)
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(resolveDeletionUnit(doc, 4, 'backward')).toEqual({ from: 2, to: 5 });
    });
  });

  it('S2 `文␣▢␣|` Backspace at trailing → deletes owned space + chip + owned space', () => {
    withSchema((s) => {
      // para[ 'x '(1-3), chipC(3-4), ' '(4-5) ]; cursor at end = 5
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' ')]);
      expect(resolveDeletionUnit(doc, 5, 'backward')).toEqual({ from: 2, to: 5 });
    });
  });

  it('S3 `文␣|▢` Backspace on the left owned space → deletes the chip unit (not "un-deletable")', () => {
    withSchema((s) => {
      // para[ 'x '(1-3), chipC(3-4), ' '(4-5) ]; cursor pos 3 (between left space and chip)
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' ')]);
      expect(resolveDeletionUnit(doc, 3, 'backward')).toEqual({ from: 2, to: 5 });
    });
  });

  it('S4 段首 `␣|▢␣文` Backspace → deletes leading owned space + chip + owned space', () => {
    withSchema((s) => {
      // para[ ' '(1-2), chipC(2-3), ' y'(3-5) ]; cursor pos 2
      const doc = docOf(s, [s.text(' '), chip(s, chipA), s.text(' y')]);
      expect(resolveDeletionUnit(doc, 2, 'backward')).toEqual({ from: 1, to: 4 });
    });
  });

  it('forward `文|␣▢` Delete → deletes owned space + chip', () => {
    withSchema((s) => {
      // para[ 'x '(1-3), chipC(3-4), ' y'(4-6) ]; cursor pos 2 (after x, before space)
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(resolveDeletionUnit(doc, 2, 'forward')).toEqual({ from: 2, to: 5 });
    });
  });

  it('S6 two chips `▢A␣|▢B` Backspace → deletes A + its leading space, KEEPS the shared space for B', () => {
    withSchema((s) => {
      // para[ ' '(1-2), chipA(2-3), ' '(3-4 shared), chipB(4-5), ' '(5-6) ]; cursor pos 4
      const doc = docOf(s, [
        s.text(' '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB),
        s.text(' '),
      ]);
      // targets A (left of the shared space); shared space [3,4] stays for B.
      expect(resolveDeletionUnit(doc, 4, 'backward')).toEqual({ from: 1, to: 3 });
    });
  });

  it('chipDeletionUnit keeps BOTH shared spaces when a chip is flanked by two other chips', () => {
    withSchema((s) => {
      // para[ ' ', A, ' ', B(mid), ' ', chipC2, ' ' ] — B shares both sides
      const chipC2: ReferenceRailItem = { ...chipA, refId: 'c', sourceNodeId: 'c', sourceNodeName: 'C' };
      const doc = docOf(s, [
        s.text(' '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB), // at pos 4, shared space on both sides
        s.text(' '),
        chip(s, chipC2),
        s.text(' '),
      ]);
      // B at pos 4: left space [3,4] shared with A, right space [5,6] shared with C → neither included
      expect(chipDeletionUnit(doc, 4)).toEqual({ from: 4, to: 5 });
    });
  });

  it('returns null for a plain-text delete (native deletion proceeds)', () => {
    withSchema((s) => {
      const doc = docOf(s, [s.text('hello')]);
      expect(resolveDeletionUnit(doc, 3, 'backward')).toBeNull();
      expect(resolveDeletionUnit(doc, 3, 'forward')).toBeNull();
    });
  });
});

// Property-based coverage of the additive invariant (critical path: Yjs collab).
// A live editor carries the appendTransaction, so after ANY random edit sequence
// the invariant must hold (planner finds nothing to add) and re-normalizing is a
// no-op (idempotent). This is the property the example tests above sample.
describe('planWhitespaceInsertions — property: invariant + idempotency', () => {
  const opArb = fc.oneof(
    fc.record({ t: fc.constant('chip' as const), id: fc.constantFrom('a', 'b', 'c') }),
    fc.record({
      t: fc.constant('text' as const),
      s: fc.string({ unit: fc.constantFrom('a', 'b', ' '), maxLength: 4 }),
    }),
  );

  it('every chip is flanked by spaces after ANY random edit sequence (and re-normalizing is a no-op)', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 15 }), (ops) => {
        const editor = makeEditor();
        try {
          for (const op of ops) {
            if (op.t === 'chip') {
              editor
                .chain()
                .insertContent(
                  referenceMentionContent({
                    ...chipA,
                    refId: op.id,
                    sourceNodeId: op.id,
                    sourceNodeName: op.id,
                  }),
                )
                .run();
            } else if (op.s.length > 0) {
              editor.chain().insertContent(op.s).run();
            }
          }
          // appendTransaction keeps the invariant → nothing left to add,
          // and a second call is still empty (idempotent).
          expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
          expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
        } finally {
          editor.destroy();
        }
      }),
      { numRuns: 40 },
    );
  });
});
