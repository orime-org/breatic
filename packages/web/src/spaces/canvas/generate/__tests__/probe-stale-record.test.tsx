// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

// PROBE (adversarial R2, temporary — delete before finishing): does the
// record-and-restore drag mechanism survive a REMOTE Yjs edit landing between
// mousedown and dragstart? The record stores raw positions and is never mapped
// through intervening transactions; the dragstart clamp only guards
// content.size.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';

import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
import {
  PromptEditor,
  type PromptEditorHandle,
} from '@web/spaces/canvas/generate/PromptEditor';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';

beforeAll(() => {
  if (typeof document.elementFromPoint !== 'function') {
    Object.defineProperty(document, 'elementFromPoint', {
      value: () => null,
      configurable: true,
    });
  }
});

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

interface ProbeEditor {
  commands: {
    setTextSelection: (r: { from: number; to: number }) => boolean;
    setNodeSelection: (pos: number) => boolean;
    insertContentAt: (pos: number, content: string) => boolean;
  };
  state: {
    doc: {
      textContent: string;
      content: { size: number };
      textBetween: (from: number, to: number, sep?: string, leaf?: string) => string;
      descendants: (
        cb: (node: { type: { name: string } }, pos: number) => void,
      ) => void;
    };
    selection: { from: number; to: number; constructor: { name: string } };
  };
}

describe('PROBE: stale record vs remote Yjs edit between mousedown and dragstart', () => {
  it('shows whether the restored selection drifts onto remote content', async () => {
    const docA = new Y.Doc();
    const fragment = docA.getXmlFragment('prompt');
    const ref = React.createRef<PromptEditorHandle>();
    render(
      <PromptEditor
        ref={ref}
        fragment={fragment}
        placeholder='Describe'
        onTextChange={vi.fn()}
        onAtMentionsChange={vi.fn()}
        references={[refA, refB]}
        mode='i2i'
        mentionEmptyLabel='No references'
      />,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    const pmEl = document.querySelector('.ProseMirror') as unknown as {
      editor: ProbeEditor;
    };
    const editor = pmEl.editor;
    act(() => {
      editor.commands.insertContentAt(1, 'head');
      ref.current?.insertReference(refA);
      ref.current?.insertReference(refB);
      editor.commands.insertContentAt(
        editor.state.doc.content.size - 1,
        'tail',
      );
    });
    const chipEls = await waitFor(() => {
      const els = [...document.querySelectorAll('[data-reference-mention]')];
      expect(els.length).toBe(2);
      return els as HTMLElement[];
    });
    const positions: number[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) positions.push(pos);
    });
    // Selection spans from doc start through chip B.
    const from = 1;
    const to = positions[1] + 1;
    act(() => {
      editor.commands.setTextSelection({ from, to });
    });
    const textBefore = editor.state.doc.textContent;

    // 1. mousedown on chip A → the plugin records {from, to}.
    act(() => {
      chipEls[0].dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
      );
    });

    // 2. REMOTE collab edit lands: another replica inserts 'zzzz' at the very
    //    start of the paragraph. y-prosemirror dispatches this into the editor.
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const remoteFragment = docB.getXmlFragment('prompt');
    const para = remoteFragment.get(0) as Y.XmlElement;
    // Insert INTO the shared space between chip A and chip B (child index 2 —
    // children: XmlText('head '), chipA, XmlText(' '), chipB, XmlText(' tail')).
    // Chip A's absolute position is untouched, so the dragstart gate passes.
    const midText = para.get(2) as Y.XmlText;
    expect(midText instanceof Y.XmlText).toBe(true);
    act(() => {
      midText.insert(1, 'zzzz');
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
    });
    expect(editor.state.doc.textContent.includes('zzzz')).toBe(true);
    // PM mapped the live selection through the remote tr — the CORRECT range:
    const mapped = { from: editor.state.selection.from, to: editor.state.selection.to };
    // eslint-disable-next-line no-console
    console.log('AFTER REMOTE', {
      mapped,
      text: editor.state.doc.textContent,
      chipsNow: ((): number[] => {
        const p: number[] = [];
        editor.state.doc.descendants((n, pos) => {
          if (n.type.name === REFERENCE_MENTION_NODE) p.push(pos);
        });
        return p;
      })(),
    });

    // 3. dragstart on chip A's outer wrapper (the drag source).
    const wrapper = chipEls[0].closest('[data-node-view-wrapper]')
      ?.parentElement as HTMLElement;
    const dragstart = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragstart, 'dataTransfer', {
      value: {
        clearData: (): void => undefined,
        setData: (): void => undefined,
        effectAllowed: 'copyMove',
        files: [],
      },
    });
    act(() => {
      wrapper.dispatchEvent(dragstart);
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const sel = editor.state.selection;
    // Diagnostics
    // eslint-disable-next-line no-console
    console.log('PROBE RESULT', {
      textBefore,
      textAfterRemote: editor.state.doc.textContent,
      record: { from, to },
      mappedCorrect: mapped,
      selectionAfterDragstart: { from: sel.from, to: sel.to },
      selectedText: editor.state.doc.textBetween(sel.from, sel.to, ' ', '▢'),
      chipPositionsNow: ((): number[] => {
        const p: number[] = [];
        editor.state.doc.descendants((n, pos) => {
          if (n.type.name === REFERENCE_MENTION_NODE) p.push(pos);
        });
        return p;
      })(),
    });
    // The restore should have kept the correctly-mapped selection. If it
    // snapped back to the stale record, this fails — proving the drift.
    expect({ from: sel.from, to: sel.to }).toEqual(mapped);
  });
});
