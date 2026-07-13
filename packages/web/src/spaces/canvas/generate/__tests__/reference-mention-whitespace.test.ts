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
  planCascadeDeletion,
  isStoppable,
  findNextStoppable,
  nearestStoppable,
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

describe('resolveDeletionUnit — D: deletion direction always matches chip position', () => {
  // In D the cursor only rests at STOPPABLE positions, so deletes are tested from
  // those. A delete whose direction crosses an owned space INTO a chip removes the
  // chip unit (owned spaces + chip); otherwise native. The reverse-direction
  // branches are GONE, so a delete that would remove a chip on the OPPOSITE side
  // (the `文␣|▢` Backspace / `▢|␣文` Delete the user flagged as weird) returns null.

  it('form ③ `文␣▢␣|文` Backspace → removes the chip unit (owned space + chip + owned space)', () => {
    withSchema((s) => {
      // `x [A] y`: x[1,2] ' '[2,3] chipA[3,4] ' '[4,5] y[5,6]; cursor pos 5 = chip␣|y
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(resolveDeletionUnit(doc, 5, 'backward')).toEqual({ from: 2, to: 5 });
    });
  });

  it('form ① `文|␣▢␣文` Delete → removes the chip unit', () => {
    withSchema((s) => {
      // `x [A] y`; cursor pos 2 = x|␣A
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(resolveDeletionUnit(doc, 2, 'forward')).toEqual({ from: 2, to: 5 });
    });
  });

  it('trailing chip `文␣▢␣|` Backspace → removes the chip unit', () => {
    withSchema((s) => {
      // `x [A] `: x[1,2] ' '[2,3] chipA[3,4] ' '[4,5]; cursor at end pos 5
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' ')]);
      expect(resolveDeletionUnit(doc, 5, 'backward')).toEqual({ from: 2, to: 5 });
    });
  });

  it('leading chip `|␣▢␣文` Delete → removes the chip unit', () => {
    withSchema((s) => {
      // ` [A] y`: ' '[1,2] chipA[2,3] ' '[3,4] y[4,5]; cursor at para start pos 1
      const doc = docOf(s, [s.text(' '), chip(s, chipA), s.text(' y')]);
      expect(resolveDeletionUnit(doc, 1, 'forward')).toEqual({ from: 1, to: 4 });
    });
  });

  it('form ② `文␣A|␣B␣文` Backspace → removes A + its leading space, KEEPS the shared space for B', () => {
    withSchema((s) => {
      // ` [A] [B] `: ' '[1,2] A[2,3] ' '[3,4 shared] B[4,5] ' '[5,6]; cursor pos 3 = A|␣B
      const doc = docOf(s, [
        s.text(' '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB),
        s.text(' '),
      ]);
      expect(resolveDeletionUnit(doc, 3, 'backward')).toEqual({ from: 1, to: 3 });
    });
  });

  it('form ② `文␣A|␣B␣文` Delete → removes B + its trailing space, KEEPS the shared space for A', () => {
    withSchema((s) => {
      // ` [A] [B] `; cursor pos 3 = A|␣B; forward delete targets B
      const doc = docOf(s, [
        s.text(' '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB),
        s.text(' '),
      ]);
      // shared space [3,4] stays for A; B[4,5] + trailing [5,6] go → {4,6}
      expect(resolveDeletionUnit(doc, 3, 'forward')).toEqual({ from: 4, to: 6 });
    });
  });

  it('chipDeletionUnit absorbs ONE shared space when a chip is DOUBLE-shared (heals A—C to a single shared space)', () => {
    withSchema((s) => {
      // para[ ' ', A, ' ', B(mid), ' ', chipC2, ' ' ] — B shares a space on BOTH sides
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
      // B at pos 4: deleting only the chip would leave A and C with TWO spaces between
      // them (the additive planner cannot heal it). So absorb the RIGHT shared space
      // [5,6] too; the LEFT shared space [3,4] stays as A and C's single shared space.
      expect(chipDeletionUnit(doc, 4)).toEqual({ from: 4, to: 6 });
    });
  });

  it('resolveDeletionUnit on a DOUBLE-shared middle chip: both stoppable delete directions heal to one space', () => {
    withSchema((s) => {
      // ` [A] [B] [C] `: ' '[1,2] A[2,3] sh1[3,4] B[4,5] sh2[5,6] C[6,7] ' '[7,8]
      const chipC2: ReferenceRailItem = { ...chipA, refId: 'c', sourceNodeId: 'c', sourceNodeName: 'C' };
      const doc = docOf(s, [
        s.text(' '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB),
        s.text(' '),
        chip(s, chipC2),
        s.text(' '),
      ]);
      // Backspace at B|␣C (pos 5) and Delete at A|␣B (pos 3) both target B → {4,6}.
      expect(resolveDeletionUnit(doc, 5, 'backward')).toEqual({ from: 4, to: 6 });
      expect(resolveDeletionUnit(doc, 3, 'forward')).toEqual({ from: 4, to: 6 });
    });
  });

  it('REGRESSION `文␣|▢` Backspace does NOT delete the chip (reverse-direction branch removed — the user bug)', () => {
    withSchema((s) => {
      // `x [A] y`; cursor pos 3 = x␣|A (unstoppable in D). Before D this deleted the chip backwards.
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(resolveDeletionUnit(doc, 3, 'backward')).toBeNull();
    });
  });

  it('REGRESSION `▢|␣文` Delete does NOT delete the chip (reverse-direction branch removed)', () => {
    withSchema((s) => {
      // `x [A] y`; cursor pos 4 = A|␣y (unstoppable in D).
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(resolveDeletionUnit(doc, 4, 'forward')).toBeNull();
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

describe('planCascadeDeletion — edge-removal cascade deletes chips WITH owned spaces', () => {
  /**
   * Maps each chip's source id to its doc position.
   * @param doc - The document node.
   * @returns sourceNodeId → position.
   */
  function chipPositions(doc: PMNode): Record<string, number> {
    const out: Record<string, number> = {};
    doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) {
        out[n.attrs.sourceNodeId as string] = pos;
      }
    });
    return out;
  }

  it('lone stale chip: removes the chip + both owned spaces (no residue, matches keyboard)', () => {
    withSchema((s) => {
      const doc = docOf(s, [s.text('sky '), chip(s, chipA), s.text(' ocean')]);
      const p = chipPositions(doc);
      expect(planCascadeDeletion(doc, new Set([p.a]))).toEqual([
        { from: p.a - 1, to: p.a + 2 },
      ]);
    });
  });

  it('two adjacent chips BOTH stale: deletes both + all spaces, no orphan (the adversarial case)', () => {
    withSchema((s) => {
      const doc = docOf(s, [
        s.text('sky '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB),
        s.text(' ocean'),
      ]);
      const p = chipPositions(doc);
      // merged into one range: ` [A] [B] ` → skyocean
      expect(planCascadeDeletion(doc, new Set([p.a, p.b]))).toEqual([
        { from: p.a - 1, to: p.b + 2 },
      ]);
    });
  });

  it('one of two adjacent chips stale: KEEPS the shared space for the survivor', () => {
    withSchema((s) => {
      const doc = docOf(s, [
        s.text('sky '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB),
        s.text(' ocean'),
      ]);
      const p = chipPositions(doc);
      // deletes ` [A]` but keeps the shared space → sky [B] ocean
      expect(planCascadeDeletion(doc, new Set([p.a]))).toEqual([
        { from: p.a - 1, to: p.a + 1 },
      ]);
    });
  });

  it('returns [] for an empty stale set', () => {
    withSchema((s) => {
      const doc = docOf(s, [s.text('sky '), chip(s, chipA), s.text(' ocean')]);
      expect(planCascadeDeletion(doc, new Set())).toEqual([]);
    });
  });

  it('cascading a DOUBLE-shared middle chip (both neighbours survive) absorbs one shared space (no orphan double space)', () => {
    withSchema((s) => {
      // ` [A] [B] [C] `; only B is stale, A and C survive
      const chipC2: ReferenceRailItem = { ...chipA, refId: 'c', sourceNodeId: 'c', sourceNodeName: 'C' };
      const doc = docOf(s, [
        s.text(' '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB), // pos 4
        s.text(' '),
        chip(s, chipC2),
        s.text(' '),
      ]);
      // deletes B + the right shared space [5,6]; the left shared space [3,4] stays
      // as A and C's single shared space (matches the keyboard chipDeletionUnit path)
      expect(planCascadeDeletion(doc, new Set([4]))).toEqual([{ from: 4, to: 6 }]);
    });
  });

  it('cascading a RUN of >=2 ADJACENT stale chips flanked by survivors heals A—D to one space (R3)', () => {
    withSchema((s) => {
      // ` [A] [B] [C] [D] `: ' '[1,2] A[2,3] sh[3,4] B[4,5] sh[5,6] C[6,7] sh[7,8] D[8,9] ' '[9,10]
      const chipC2: ReferenceRailItem = { ...chipA, refId: 'c', sourceNodeId: 'c', sourceNodeName: 'C' };
      const chipD2: ReferenceRailItem = { ...chipA, refId: 'd', sourceNodeId: 'd', sourceNodeName: 'D' };
      const doc = docOf(s, [
        s.text(' '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB), // pos 4
        s.text(' '),
        chip(s, chipC2), // pos 6
        s.text(' '),
        chip(s, chipD2),
        s.text(' '),
      ]);
      // B and C both stale (adjacent run), A and D survive. Delete B + B|C shared +
      // C + C|D shared → {4,8}; A|B shared [3,4] stays as A and D's single shared space
      // (per-chip run-length-1 heal alone would leave {4,7} → double space between A and D).
      expect(planCascadeDeletion(doc, new Set([4, 6]))).toEqual([{ from: 4, to: 8 }]);
    });
  });

  it('cascading two DISJOINT stale chips each heals independently (two ranges, each absorbing one shared)', () => {
    withSchema((s) => {
      // ` [A] [B] [C] [D] [E] `: A@2 B@4 C@6 D@8 E@10; B and D stale, A/C/E survive
      const mk = (id: string, name: string): ReferenceRailItem => ({
        ...chipA,
        refId: id,
        sourceNodeId: id,
        sourceNodeName: name,
      });
      const doc = docOf(s, [
        s.text(' '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB), // pos 4
        s.text(' '),
        chip(s, mk('c', 'C')), // pos 6
        s.text(' '),
        chip(s, mk('d', 'D')), // pos 8
        s.text(' '),
        chip(s, mk('e', 'E')), // pos 10
        s.text(' '),
      ]);
      // D range {8,10} then B range {4,6} (descending), each absorbing its right shared
      expect(planCascadeDeletion(doc, new Set([4, 8]))).toEqual([
        { from: 8, to: 10 },
        { from: 4, to: 6 },
      ]);
    });
  });
});

describe('isStoppable — D cursor model (owned space is transparent to the cursor)', () => {
  it('single chip: stoppable on the FAR side of each owned space, not the chip side', () => {
    withSchema((s) => {
      // `x [A] y`: x[1,2] ' '[2,3] chipA[3,4] ' '[4,5] y[5,6]
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(isStoppable(doc, 1)).toBe(true); //   paragraph start (before x)
      expect(isStoppable(doc, 2)).toBe(true); // ① x|␣chip
      expect(isStoppable(doc, 3)).toBe(false); // ✗ ␣|chip (before chip — 文本␣|▢)
      expect(isStoppable(doc, 4)).toBe(false); // ✗ chip|␣ (after chip — ▢|␣文本)
      expect(isStoppable(doc, 5)).toBe(true); // ③ chip␣|y
      expect(isStoppable(doc, 6)).toBe(true); //   paragraph end (after y)
    });
  });

  it('adjacent chips (shared space): stops between them (② chip|␣chip), never ③-shaped ▢␣|▢', () => {
    withSchema((s) => {
      // `x [A][B] y`: x[1,2] ' '[2,3] A[3,4] shared[4,5] B[5,6] ' '[6,7] y[7,8]
      const doc = docOf(s, [
        s.text('x '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB),
        s.text(' y'),
      ]);
      expect(isStoppable(doc, 2)).toBe(true); // ① x|␣A
      expect(isStoppable(doc, 3)).toBe(false); // ✗ ␣|A
      expect(isStoppable(doc, 4)).toBe(true); // ② A|␣B (shared space — stop before it)
      expect(isStoppable(doc, 5)).toBe(false); // ✗ A␣|B (shared space AFTER — does not exist)
      expect(isStoppable(doc, 6)).toBe(false); // ✗ B|␣
      expect(isStoppable(doc, 7)).toBe(true); // ③ B␣|y
    });
  });

  it('leading chip: paragraph start is stoppable (form ① at start)', () => {
    withSchema((s) => {
      // ` [A] y`: ' '[1,2] A[2,3] ' '[3,4] y[4,5]
      const doc = docOf(s, [s.text(' '), chip(s, chipA), s.text(' y')]);
      expect(isStoppable(doc, 1)).toBe(true); // ① start|␣A
      expect(isStoppable(doc, 2)).toBe(false); // ✗ ␣|A
      expect(isStoppable(doc, 3)).toBe(false); // ✗ A|␣
      expect(isStoppable(doc, 4)).toBe(true); // ③ A␣|y
    });
  });

  it('trailing chip: paragraph end is stoppable (form ③ at end)', () => {
    withSchema((s) => {
      // `x [A] `: x[1,2] ' '[2,3] A[3,4] ' '[4,5]
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' ')]);
      expect(isStoppable(doc, 2)).toBe(true); // ① x|␣A
      expect(isStoppable(doc, 3)).toBe(false); // ✗ ␣|A
      expect(isStoppable(doc, 4)).toBe(false); // ✗ A|␣
      expect(isStoppable(doc, 5)).toBe(true); // ③ A␣| end
    });
  });

  it('plain text: every inline gap is stoppable', () => {
    withSchema((s) => {
      const doc = docOf(s, [s.text('hello')]); // h..o at [1,2]..[5,6]
      for (let p = 1; p <= 6; p += 1) expect(isStoppable(doc, p)).toBe(true);
    });
  });
});

describe('findNextStoppable — arrow keys cross a chip in one step', () => {
  it('forward from `x|␣chip` jumps past the whole chip to `chip␣|y` (① → ③)', () => {
    withSchema((s) => {
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(findNextStoppable(doc, 2, 'forward')).toBe(5);
    });
  });

  it('backward from `chip␣|y` jumps back past the chip to `x|␣chip`', () => {
    withSchema((s) => {
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(findNextStoppable(doc, 5, 'backward')).toBe(2);
    });
  });

  it('adjacent chips: forward stops between them (②) then past both', () => {
    withSchema((s) => {
      const doc = docOf(s, [
        s.text('x '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB),
        s.text(' y'),
      ]);
      expect(findNextStoppable(doc, 2, 'forward')).toBe(4); // x|␣A → A|␣B
      expect(findNextStoppable(doc, 4, 'forward')).toBe(7); // A|␣B → B␣|y
    });
  });

  it('adjacent chips: backward mirrors forward', () => {
    withSchema((s) => {
      const doc = docOf(s, [
        s.text('x '),
        chip(s, chipA),
        s.text(' '),
        chip(s, chipB),
        s.text(' y'),
      ]);
      expect(findNextStoppable(doc, 7, 'backward')).toBe(4); // B␣|y → A|␣B
      expect(findNextStoppable(doc, 4, 'backward')).toBe(2); // A|␣B → x|␣A
    });
  });

  it('returns null at a textblock boundary (native handles cross-paragraph moves)', () => {
    withSchema((s) => {
      const doc = docOf(s, [s.text('hi')]); // h[1,2] i[2,3]; content end = 3
      expect(findNextStoppable(doc, 3, 'forward')).toBeNull();
      expect(findNextStoppable(doc, 1, 'backward')).toBeNull();
    });
  });
});

describe('nearestStoppable — snap a programmatic / pointer landing to a stoppable position', () => {
  it('snaps `␣|chip` (before chip) left to `text|␣chip`', () => {
    withSchema((s) => {
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(nearestStoppable(doc, 3)).toBe(2);
    });
  });

  it('snaps `chip|␣` (after chip) to the nearer side (right, form ③)', () => {
    withSchema((s) => {
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(nearestStoppable(doc, 4)).toBe(5);
    });
  });

  it('returns the position unchanged when already stoppable', () => {
    withSchema((s) => {
      const doc = docOf(s, [s.text('x '), chip(s, chipA), s.text(' y')]);
      expect(nearestStoppable(doc, 2)).toBe(2);
    });
  });
});

describe('3+ adjacent chips (double-shared middle) — R1 adversarial coverage', () => {
  /**
   * Builds `[A][B][C]` sharing one space between each pair, flanked by spaces:
   * ` [A] [B] [C] ` → ' '[1,2] A[2,3] sh1[3,4] B[4,5] sh2[5,6] C[6,7] ' '[7,8].
   * @param s - The editor schema.
   * @returns The three-chip doc.
   */
  function threeChipDoc(s: Schema): PMNode {
    const chipC: ReferenceRailItem = { ...chipA, refId: 'c', sourceNodeId: 'c', sourceNodeName: 'C' };
    return docOf(s, [
      s.text(' '),
      chip(s, chipA),
      s.text(' '),
      chip(s, chipB),
      s.text(' '),
      chip(s, chipC),
      s.text(' '),
    ]);
  }

  it('isStoppable: the double-shared middle chip B rests ONLY at A|␣B and B|␣C', () => {
    withSchema((s) => {
      const doc = threeChipDoc(s);
      expect(isStoppable(doc, 1)).toBe(true); //   start|␣A
      expect(isStoppable(doc, 2)).toBe(false); // ✗ ␣|A
      expect(isStoppable(doc, 3)).toBe(true); // ② A|␣B (left shared space)
      expect(isStoppable(doc, 4)).toBe(false); // ✗ A␣|B (does not exist)
      expect(isStoppable(doc, 5)).toBe(true); // ② B|␣C (right shared space)
      expect(isStoppable(doc, 6)).toBe(false); // ✗ B␣|C (does not exist)
      expect(isStoppable(doc, 7)).toBe(false); // ✗ C|␣ trailing
      expect(isStoppable(doc, 8)).toBe(true); // ③ C␣| end
    });
  });

  it('findNextStoppable: one chip crossed per press across the whole run', () => {
    withSchema((s) => {
      const doc = threeChipDoc(s);
      expect(findNextStoppable(doc, 3, 'forward')).toBe(5); // A|␣B → B|␣C (cross B)
      expect(findNextStoppable(doc, 5, 'forward')).toBe(8); // B|␣C → C␣| end (cross C)
      expect(findNextStoppable(doc, 5, 'backward')).toBe(3); // B|␣C → A|␣B (cross B)
      expect(findNextStoppable(doc, 1, 'forward')).toBe(3); // start|␣A → A|␣B (cross A)
    });
  });
});

describe('multi-paragraph (Enter creates real paragraphs) — R2 adversarial coverage', () => {
  /**
   * Builds a two-paragraph doc `a [A] ` / ` [B] b` (Enter → default splitBlock):
   * para1 a[1,2] ␣[2,3] A[3,4] ␣[4,5] (content 1..5); para2 ␣[7,8] B[8,9] ␣[9,10] b[10,11]
   * (content 7..11).
   * @param s - The editor schema.
   * @returns The two-paragraph doc.
   */
  function twoParaDoc(s: Schema): PMNode {
    return s.node('doc', null, [
      s.node('paragraph', null, [s.text('a '), chip(s, chipA), s.text(' ')]),
      s.node('paragraph', null, [s.text(' '), chip(s, chipB), s.text(' b')]),
    ]);
  }

  it('isStoppable is per-textblock (each paragraph start / end is stoppable)', () => {
    withSchema((s) => {
      const doc = twoParaDoc(s);
      expect(isStoppable(doc, 2)).toBe(true); // ① a|␣A (para1)
      expect(isStoppable(doc, 5)).toBe(true); // ③ A␣| para1 end
      expect(isStoppable(doc, 7)).toBe(true); // ① para2 start|␣B
      expect(isStoppable(doc, 10)).toBe(true); // ③ B␣|b (para2)
    });
  });

  it('findNextStoppable crosses a chip WITHIN a paragraph but stops at the textblock boundary', () => {
    withSchema((s) => {
      const doc = twoParaDoc(s);
      expect(findNextStoppable(doc, 2, 'forward')).toBe(5); // cross A → para1 end
      expect(findNextStoppable(doc, 5, 'forward')).toBeNull(); // boundary → native crosses paragraphs
      expect(findNextStoppable(doc, 7, 'forward')).toBe(10); // para2: cross B
      expect(findNextStoppable(doc, 7, 'backward')).toBeNull(); // para2 start boundary
    });
  });

  it('nearestStoppable snaps within the same textblock only', () => {
    withSchema((s) => {
      const doc = twoParaDoc(s);
      expect(nearestStoppable(doc, 3)).toBe(2); // ␣|A (para1) snaps left to a|␣A
      expect(nearestStoppable(doc, 9)).toBe(10); // B|␣b (para2) snaps right to B␣|b
    });
  });

  it('planCascadeDeletion does NOT heal across a paragraph boundary (per-textblock ranges)', () => {
    withSchema((s) => {
      const doc = twoParaDoc(s);
      // A@3 (para1) and B@8 (para2) both stale — each deletes within its own paragraph;
      // a paragraph boundary is not a surviving-shared space, so no cross-block absorb.
      expect(planCascadeDeletion(doc, new Set([3, 8]))).toEqual([
        { from: 7, to: 10 },
        { from: 2, to: 5 },
      ]);
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
