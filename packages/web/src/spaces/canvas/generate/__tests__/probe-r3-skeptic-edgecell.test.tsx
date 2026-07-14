// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

// TEMPORARY skeptic probe (R3 verify) — DELETE BEFORE FINISHING.
// Attacks the least-covered corners of planDropResidueHeal/residueDeletionAt:
//  S1/S2: drop-move landing immediately ADJACENT to the source gap (left/right)
//         — the heal {gap,gap+1} and the invariant's anchor re-insert must
//         compose in ONE appended tr at unmapped descending coordinates.
//  S3:    LEFT-anchor-carried range `␣▢` dragged out mid-text (mirror of the
//         existing right-anchor test) — the surviving space is the word gap.
//  S4:    paragraph-start chip sharing a space with a second chip; drag the
//         first away — the survivor must keep exactly one left anchor.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { Editor as CoreEditor } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { Document as PMDocument } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text as PMText } from '@tiptap/extension-text';

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
import {
  ReferenceMention,
  referenceMentionContent,
} from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import {
  isSpaceAt,
  planWhitespaceInsertions,
} from '@web/spaces/canvas/generate/reference-mention-whitespace';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

const refA: ReferenceRailItem = {
  refId: 'a->me',
  sourceNodeId: 'a',
  sourceNodeType: 'image',
  sourceNodeName: 'A',
  thumbnail: 'a.png',
};
const refB: ReferenceRailItem = {
  refId: 'b->me',
  sourceNodeId: 'b',
  sourceNodeType: 'image',
  sourceNodeName: 'B',
  thumbnail: 'b.png',
};

function makeCollabEditor(): CoreEditor {
  return new CoreEditor({
    element: document.createElement('div'),
    extensions: [
      PMDocument,
      Paragraph,
      PMText,
      Collaboration.configure({ fragment: new Y.Doc().getXmlFragment('prompt') }),
      ReferenceMention.configure({
        suggestion: makeReferenceSuggestion({ getPool: () => [], emptyLabel: 'No references' }),
      }),
    ],
  });
}

function chipPositions(editor: CoreEditor): number[] {
  const found: number[] = [];
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === REFERENCE_MENTION_NODE) found.push(pos);
  });
  return found;
}

function totalSpaces(editor: CoreEditor): number {
  let count = 0;
  editor.state.doc.descendants((n) => {
    if (n.isText) count += (n.text ?? '').split('').filter((c) => c === ' ').length;
  });
  return count;
}

function hasDoubleSpaceInsideTextNode(editor: CoreEditor): boolean {
  let found = false;
  editor.state.doc.descendants((n) => {
    if (n.isText && / {2}/.test(n.text ?? '')) found = true;
  });
  return found;
}

/** PM-style drop-move of a doc range [from,to) to target (pre-delete coords). */
function dropMoveRange(
  editor: CoreEditor,
  from: number,
  to: number,
  target: number,
): void {
  const slice = editor.state.doc.slice(from, to);
  const tr = editor.state.tr;
  tr.delete(from, to);
  tr.insert(tr.mapping.map(target), slice.content);
  tr.setMeta('uiEvent', 'drop');
  editor.view.dispatch(tr);
}

describe('skeptic probe: adjacent-to-own-gap drops (heal + invariant compose in one tr)', () => {
  it('S1: dropping the chip one slot LEFT of its own gap keeps exactly one space per side', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('aa ').run();
      editor.chain().insertContent(referenceMentionContent(refA)).run();
      editor.chain().insertContent('bb').run();
      // 'aa␣▢␣bb' — chip at 4; drop at 3 (aa|␣▢␣bb → chip lands before the left anchor)
      const p = chipPositions(editor)[0];
      expect(p).toBe(4);
      expect(totalSpaces(editor)).toBe(2);
      dropMoveRange(editor, p, p + 1, p - 1);
      // Correct outcome: same shape, chip flanked by single spaces, 2 spaces total.
      const chips = chipPositions(editor);
      expect(chips).toHaveLength(1);
      expect(isSpaceAt(editor.state.doc, chips[0] - 1)).toBe(true);
      expect(isSpaceAt(editor.state.doc, chips[0] + 1)).toBe(true);
      expect(totalSpaces(editor)).toBe(2);
      expect(hasDoubleSpaceInsideTextNode(editor)).toBe(false);
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      expect(editor.state.doc.textContent.replace(/ +/g, '|')).toBe('aa|bb');
    } finally {
      editor.destroy();
    }
  });

  it('S2: dropping the chip one slot RIGHT of its own gap keeps exactly one space per side', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('aa ').run();
      editor.chain().insertContent(referenceMentionContent(refA)).run();
      editor.chain().insertContent('bb').run();
      // 'aa␣▢␣bb' — chip at 4; drop at 6 (aa␣▢␣|bb → chip lands after its right anchor)
      const p = chipPositions(editor)[0];
      dropMoveRange(editor, p, p + 1, p + 2);
      const chips = chipPositions(editor);
      expect(chips).toHaveLength(1);
      expect(isSpaceAt(editor.state.doc, chips[0] - 1)).toBe(true);
      expect(isSpaceAt(editor.state.doc, chips[0] + 1)).toBe(true);
      expect(totalSpaces(editor)).toBe(2);
      expect(hasDoubleSpaceInsideTextNode(editor)).toBe(false);
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      expect(editor.state.doc.textContent.replace(/ +/g, '|')).toBe('aa|bb');
    } finally {
      editor.destroy();
    }
  });

  it('S3: a LEFT-anchor-carried range `␣▢` dragged to the end keeps the word gap (mirror of the shipped right-anchor test)', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('aa ').run();
      editor.chain().insertContent(referenceMentionContent(refA)).run();
      editor.chain().insertContent('bb').run();
      // 'aa␣▢␣bb' — drag [3,5) = `␣▢` (left anchor travels; range edge cells:
      // first=space → leftStranded false, last=chip → rightStranded true).
      const p = chipPositions(editor)[0];
      dropMoveRange(editor, p - 1, p + 1, editor.state.doc.content.size - 1);
      // The space left of the gap never existed (it travelled); the space at
      // the gap is the residue of the RIGHT anchor... no: rightStranded=true,
      // but deleting it would weld 'aa'+'bb' → mustKeep keeps it as word gap.
      expect(editor.state.doc.textContent.startsWith('aa bb')).toBe(true);
      expect(hasDoubleSpaceInsideTextNode(editor)).toBe(false);
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
    } finally {
      editor.destroy();
    }
  });

  it('S4: dragging the paragraph-start chip of a shared pair leaves the survivor exactly one left anchor', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent(referenceMentionContent(refA)).run();
      editor.chain().insertContent(referenceMentionContent(refB)).run();
      editor.chain().insertContent('cc').run();
      // invariant → '␣▢A␣▢B␣cc' (A at 2, B at 4)
      const [a, b] = chipPositions(editor);
      expect(a).toBe(2);
      expect(b).toBe(4);
      expect(totalSpaces(editor)).toBe(3);
      dropMoveRange(editor, a, a + 1, editor.state.doc.content.size - 1);
      // survivor B keeps ONE left anchor; A lands at the end with fresh anchors.
      const chips = chipPositions(editor);
      expect(chips).toHaveLength(2);
      for (const pos of chips) {
        expect(isSpaceAt(editor.state.doc, pos - 1)).toBe(true);
        expect(isSpaceAt(editor.state.doc, pos + 1)).toBe(true);
      }
      expect(hasDoubleSpaceInsideTextNode(editor)).toBe(false);
      expect(planWhitespaceInsertions(editor.state.doc)).toEqual([]);
      // exactly 4 spaces: B's left+right anchor, A's landed left+right anchor
      expect(totalSpaces(editor)).toBe(4);
    } finally {
      editor.destroy();
    }
  });
});
