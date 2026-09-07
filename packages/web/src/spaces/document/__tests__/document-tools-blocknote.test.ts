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
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

import { textblocks } from './textblocks';
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
  {
    // A whole block selected rather than a range inside one. `Mod`-clicking a
    // paragraph is how a reader gets here: `prosemirror-view` builds a
    // `NodeSelection` when the platform's select-node modifier is held. The
    // selection then sits OUTSIDE the block's content, which is a shape none
    // of the caret-in-a-textblock placements above reaches.
    name: 'a whole paragraph selected as a node',
    block: { type: 'paragraph', content: 'body' },
    place: (editor) => {
      const view = editor.prosemirrorView!;
      let at = -1;
      view.state.doc.descendants((node, pos) => {
        if (at >= 0) return false;
        if (node.type.name !== 'blockContainer') return true;
        at = pos;
        return false;
      });
      view.dispatch(
        view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)),
      );
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

describe('a selection only half of which carries the style', () => {
  /** A paragraph whose second half is bold. */
  const HALF_BOLD = {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'plain', styles: {} },
      { type: 'text', text: 'BOLD', styles: { bold: true } },
    ],
  };

  /** A paragraph whose first half is bold. */
  const BOLD_HALF = {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'BOLD', styles: { bold: true } },
      { type: 'text', text: 'plain', styles: {} },
    ],
  };

  const BOLD = ALL_TOOLS.find((tool) => tool.id === 'bold')!;

  /** The paragraph's runs, each with the marks it carries. */
  function runsOf(editor: ReturnType<typeof buildDocumentEditor>): string[] {
    const out: string[] = [];
    editor.prosemirrorState.doc.descendants((node) => {
      if (!node.isText) return true;
      out.push(
        `${node.text ?? ''}[${node.marks.map((mark) => mark.type.name).join(',')}]`,
      );
      return false;
    });
    return out;
  }

  /** Selects the whole first block. */
  function selectBlock(editor: ReturnType<typeof buildDocumentEditor>): void {
    const view = editor.prosemirrorView!;
    const first = textblocks(view.state.doc)[0];
    const from = first?.start ?? 0;
    const to = first?.end ?? 0;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
    );
  }

  it('reads as off, whichever half carries it', () => {
    // `getActiveStyles()` reads the marks at `$to` alone, so the same half-bold
    // paragraph answered differently depending on which way the reader dragged.
    for (const block of [HALF_BOLD, BOLD_HALF]) {
      const editor = open(block);
      selectBlock(editor);
      expect(BOLD.isActive(editor)).toBe(false);
    }
  });

  it('puts the style on the whole selection when it is pressed', () => {
    const editor = open(HALF_BOLD);
    selectBlock(editor);

    BOLD.run(editor);

    expect(runsOf(editor)).toEqual(['plainBOLD[bold]']);
    expect(BOLD.isActive(editor)).toBe(true);
  });
});

describe('whitespace at the edges of a selection', () => {
  /** The paragraph's runs, each with the marks it carries. */
  function runsOf(editor: ReturnType<typeof buildDocumentEditor>): string[] {
    const out: string[] = [];
    editor.prosemirrorState.doc.descendants((node) => {
      if (!node.isText) return true;
      out.push(
        `${node.text ?? ''}[${node.marks.map((mark) => mark.type.name).join(',')}]`,
      );
      return false;
    });
    return out;
  }

  ALL_TOOLS.forEach((tool) => {
    it(`leaves a trailing space out of ${tool.id}`, () => {
      // A reader dragging over a word picks up the space after it more often
      // than not, and the style is meant for the word. Inline code shows it
      // plainest: the tinted box runs one character past the word and sits
      // flush against the next one.
      const editor = open({ type: 'paragraph', content: 'foo bar' });
      // "foo " — the word and the space after it.
      select(editor, 3, 7);

      tool.run(editor);

      expect(runsOf(editor)).toEqual([`foo[${tool.id}]`, ' bar[]']);
    });
  });
});
