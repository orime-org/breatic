// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

// TEMPORARY adversarial probe — DELETE BEFORE FINISHING.

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
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

const imgRef: ReferenceRailItem = {
  refId: 'a->me',
  sourceNodeId: 'a',
  sourceNodeType: 'image',
  sourceNodeName: 'A',
  thumbnail: 'a.png',
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

function onlyChipPos(editor: CoreEditor): number {
  let found = -1;
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === REFERENCE_MENTION_NODE) found = pos;
  });
  return found;
}

/** Render the doc with chips as ▢ so exact space layout is visible. */
function shape(editor: CoreEditor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, '|', '▢');
}

function dropMoveRange(editor: CoreEditor, from: number, to: number, target: number): void {
  const slice = editor.state.doc.slice(from, to);
  const tr = editor.state.tr;
  tr.delete(from, to);
  tr.insert(tr.mapping.map(target), slice.content);
  tr.setMeta('uiEvent', 'drop');
  editor.view.dispatch(tr);
}

describe('PROBE: pair heal vs user-typed double spaces when a drag edge is TEXT', () => {
  it('P1 LEFT edge is text: dragging "bb ▢" out of "aa··bb·▢·cc" — does the heal eat one of the user double spaces before bb?', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('aa  bb ').run(); // user double space between aa and bb
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('cc').run();
      expect(shape(editor)).toBe('aa  bb ▢ cc'); // pre-drag ground truth
      const p = onlyChipPos(editor);
      // drag range = 'bb ▢' (starts with TEXT, ends with CHIP)
      dropMoveRange(editor, p - 3, p + 1, editor.state.doc.content.size - 1);
      // Ideal: only X's stranded right anchor goes -> 'aa  cc…' (user double kept)
      // Suspected bug: pair branch deletes BOTH -> 'aa cc…'
      console.log('P1 result shape:', JSON.stringify(shape(editor)));
      expect(shape(editor).startsWith('aa  cc')).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it('P2 RIGHT edge is text: dragging "▢ bb" out of "aa·▢·bb··cc" — does the heal eat one of the user double spaces before cc?', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('aa ').run();
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('bb  cc').run(); // user double space between bb and cc
      expect(shape(editor)).toBe('aa ▢ bb  cc');
      const p = onlyChipPos(editor);
      // drag range = '▢ bb' (starts with CHIP, ends with TEXT)
      dropMoveRange(editor, p, p + 4, editor.state.doc.content.size - 1);
      console.log('P2 result shape:', JSON.stringify(shape(editor)));
      expect(shape(editor).startsWith('aa  cc')).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});

describe('PROBE: mapping + boundary correctness checks (expected to pass)', () => {
  it('P3 leftward drop (insert precedes the gap): chip lands cleanly, source pair collapses to one', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('cc dd ').run();
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('ee').run();
      expect(shape(editor)).toBe('cc dd ▢ ee');
      const p = onlyChipPos(editor);
      // drop before 'dd' (target pos 4 = between 'cc ' and 'dd')
      dropMoveRange(editor, p, p + 1, 4);
      console.log('P3 result shape:', JSON.stringify(shape(editor)));
      expect(shape(editor)).toBe('cc ▢ dd ee');
    } finally {
      editor.destroy();
    }
  });

  it('P4 multi-paragraph: chip dragged from P1 end into P2 — P1 stranded pair goes entirely, P2 gains anchors', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('aa ').run();
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor
        .chain()
        .command(({ tr, state }) => {
          // append a second paragraph "bb"
          const para = state.schema.nodes.paragraph.createChecked(
            null,
            state.schema.text('bb'),
          );
          tr.insert(tr.doc.content.size, para);
          return true;
        })
        .run();
      expect(shape(editor)).toBe('aa ▢ |bb');
      const p = onlyChipPos(editor);
      // drop at end of P2
      dropMoveRange(editor, p, p + 1, editor.state.doc.content.size - 1);
      console.log('P4 result shape:', JSON.stringify(shape(editor)));
      expect(shape(editor)).toBe('aa|bb ▢ ');
    } finally {
      editor.destroy();
    }
  });

  it('P5 adjacent two-chip drag (interior shared space): source pair collapses to a single word gap', () => {
    const editor = makeCollabEditor();
    try {
      const chipB: ReferenceRailItem = { ...imgRef, refId: 'b->me', sourceNodeId: 'b', sourceNodeName: 'B' };
      editor.chain().insertContent('aa ').run();
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent(referenceMentionContent(chipB)).run();
      editor.chain().insertContent('bb').run();
      expect(shape(editor)).toBe('aa ▢ ▢ bb');
      const positions: number[] = [];
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === REFERENCE_MENTION_NODE) positions.push(pos);
      });
      // drag [A ␣ B] range (chip edges both sides)
      dropMoveRange(editor, positions[0], positions[1] + 1, editor.state.doc.content.size - 1);
      console.log('P5 result shape:', JSON.stringify(shape(editor)));
      expect(shape(editor)).toBe('aa bb ▢ ▢ ');
    } finally {
      editor.destroy();
    }
  });

  it('P6 drop onto own source point is a no-op (gap maps through the insert)', () => {
    const editor = makeCollabEditor();
    try {
      editor.chain().insertContent('aa ').run();
      editor.chain().insertContent(referenceMentionContent(imgRef)).run();
      editor.chain().insertContent('bb').run();
      expect(shape(editor)).toBe('aa ▢ bb');
      const p = onlyChipPos(editor);
      dropMoveRange(editor, p, p + 1, p);
      console.log('P6 result shape:', JSON.stringify(shape(editor)));
      expect(shape(editor)).toBe('aa ▢ bb');
    } finally {
      editor.destroy();
    }
  });
});
