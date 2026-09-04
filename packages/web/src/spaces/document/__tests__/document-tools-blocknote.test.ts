// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A19: the bubble bar's five inline tools, on BlockNote.
 *
 * Each tool answers three questions — is it on, can it run here, run it — and
 * the flat model answers them through three different doors. Being ON comes
 * from `getActiveStyles()`, because a style is a property of the selection
 * rather than a mark the caller names. Running and dry-running go through
 * `exec` / `canExec`, which take a bare ProseMirror command.
 *
 * The pressed state is worth its own cases: it drives `aria-pressed` and the
 * button's variant, and nothing pinned it before this file.
 *
 * The last group is R7 — no control that looks usable and does nothing when
 * pressed. It records what the tools say for each shape of cursor or
 * selection; the rows are not a judgement on how the body ought to behave,
 * which belongs to the slice that owns editing. The reverse — that a dark
 * button would also do nothing — is NOT asserted: R7 does not forbid one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  MARK_TOOLS,
  INLINE_TOOLS,
} from '@web/spaces/document/document-tools';

const ALL_TOOLS = [...MARK_TOOLS, ...INLINE_TOOLS];

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding one sentence, with a range of it selected.
 * @param block - The block to write.
 * @returns The editor.
 */
function open(
  block: Record<string, unknown> = { type: 'paragraph', content: 'hello world' },
): ReturnType<typeof buildDocumentEditor> {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [block] as never);
  return editor;
}

/** Selects the given range in the open editor. */
function select(
  editor: ReturnType<typeof buildDocumentEditor>,
  from: number,
  to: number,
): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
  );
}

describe('every inline tool', () => {
  it('covers the five the bar draws, each named after a style', () => {
    // The style schema names and the tool ids are the same five words, which
    // is what lets the pressed state read straight off `getActiveStyles()`.
    expect(ALL_TOOLS.map((tool) => tool.id).sort()).toEqual([
      'bold',
      'code',
      'italic',
      'strike',
      'underline',
    ]);
  });

  it('reads as off over plain text, and on once run', () => {
    const editor = open();
    select(editor, 3, 8);

    for (const tool of ALL_TOOLS) {
      expect(tool.isActive(editor)).toBe(false);
    }

    for (const tool of ALL_TOOLS) {
      select(editor, 3, 8);
      tool.run(editor);
      expect(tool.isActive(editor)).toBe(true);
    }
  });

  it('turns back off when run a second time', () => {
    const editor = open();

    for (const tool of ALL_TOOLS) {
      select(editor, 3, 8);
      tool.run(editor);
      expect(tool.isActive(editor)).toBe(true);
      select(editor, 3, 8);
      tool.run(editor);
      expect(tool.isActive(editor)).toBe(false);
    }
  });

  it('can run over a range of text', () => {
    const editor = open();
    select(editor, 3, 8);

    for (const tool of ALL_TOOLS) {
      expect(tool.canRun(editor)).toBe(true);
    }
  });

  it('cannot run where there is no text to mark', () => {
    // A code block holds text the marks do not apply to; the bar greys the
    // buttons rather than letting a press do nothing.
    const editor = open({ type: 'codeBlock', content: 'const a = 1' });
    select(editor, 3, 8);

    for (const tool of ALL_TOOLS) {
      expect(tool.canRun(editor)).toBe(false);
    }
  });
});

/** Where the caret or selection sits, and what the tools must say there. */
interface Placement {
  readonly name: string;
  readonly block: Record<string, unknown>;
  readonly place: (editor: ReturnType<typeof buildDocumentEditor>) => void;
  readonly marks: boolean;
}

/** Puts the caret inside the open editor's first block. */
function caretInFirstBlock(
  editor: ReturnType<typeof buildDocumentEditor>,
): void {
  const view = editor.prosemirrorView!;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (!node.isText) return true;
    at = pos + 1;
    return false;
  });
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at)),
  );
}

const PLACEMENTS: readonly Placement[] = [
  {
    name: 'the caret in a paragraph',
    block: { type: 'paragraph', content: 'body' },
    place: caretInFirstBlock,
    marks: true,
  },
  {
    name: 'the caret in a heading',
    block: { type: 'heading', content: 'sec' },
    place: caretInFirstBlock,
    marks: true,
  },
  {
    name: 'the caret in a code block',
    block: { type: 'codeBlock', content: 'x' },
    place: caretInFirstBlock,
    // A code block refuses marks — the editor's own rule.
    marks: false,
  },
  {
    name: 'the caret in a plain list item',
    block: { type: 'bulletListItem', content: 'a' },
    place: caretInFirstBlock,
    marks: true,
  },
  {
    name: 'the caret in a quoted heading',
    block: { type: 'heading', content: 'h', props: { quoted: true } },
    place: caretInFirstBlock,
    marks: true,
  },
  {
    name: 'a range across a paragraph',
    block: { type: 'paragraph', content: 'body' },
    place: (editor) => {
      const view = editor.prosemirrorView!;
      select(editor, 3, view.state.doc.content.size - 2);
    },
    marks: true,
  },
];

describe('what the tools claim, by where the selection sits', () => {
  PLACEMENTS.forEach((placement) => {
    it(`with ${placement.name}`, () => {
      const editor = open(placement.block);
      placement.place(editor);

      ALL_TOOLS.forEach((tool) => {
        expect(`${tool.id}=${String(tool.canRun(editor))}`).toBe(
          `${tool.id}=${String(placement.marks)}`,
        );
      });
    });
  });
});

describe('and what actually happens when they are pressed', () => {
  PLACEMENTS.forEach((placement) => {
    it(`with ${placement.name}, every live tool does something`, () => {
      ALL_TOOLS.forEach((tool) => {
        const editor = open(placement.block);
        placement.place(editor);
        if (!tool.canRun(editor)) return;

        // A collapsed caret counts marks armed for the next keystroke as
        // "something", because arming IS the effect there.
        const before = editor.prosemirrorState.doc.toString();
        const armedBefore = JSON.stringify(
          editor.prosemirrorState.storedMarks ?? null,
        );
        tool.run(editor);
        const changed =
          before !== editor.prosemirrorState.doc.toString() ||
          armedBefore !==
            JSON.stringify(editor.prosemirrorState.storedMarks ?? null);
        expect(`${tool.id}=${String(changed)}`).toBe(`${tool.id}=true`);
      });
    });
  });
});
