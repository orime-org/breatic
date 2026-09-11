// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A19: the bubble bar's five inline tools, on BlockNote.
 *
 * Each tool answers three questions — is it on, can it run here, run it — and
 * all three read through `document-style-range.ts`: whether the style is on
 * speaks for the whole highlight, and whether a press can act is judged on
 * the range that press would land in.
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

/**
 * Opens an editor holding two blocks.
 * @param blocks - The blocks to write.
 * @returns The editor.
 */
function openTwo(
  ...blocks: readonly Record<string, unknown>[]
): ReturnType<typeof buildDocumentEditor> {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
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
    // is what lets a tool build its reading from its own id.
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
    // A reading that took the marks at one end alone would answer differently
    // on the same half-bold paragraph depending on which way the reader
    // dragged.
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
    it(`carries a trailing space into ${tool.id}`, () => {
      // The selection IS the range (user 2026-09-11). A space is content: it
      // carries a weight and a colour, it is only invisible, so a press that
      // covers it styles it like any other character.
      const editor = open({ type: 'paragraph', content: 'foo bar' });
      // "foo " — the word and the space after it.
      select(editor, 3, 7);

      tool.run(editor);

      expect(runsOf(editor)).toEqual([`foo [${tool.id}]`, 'bar[]']);
    });
  });

  MARK_TOOLS.forEach((tool) => {
    it(`draws ${tool.id} unavailable over a stretch that is entirely code`, () => {
      // The `code` mark excludes every other mark, so a press lands nothing
      // and the document comes back byte-identical (R7). `canExec` asks only
      // whether the block allows the mark type, never what the runs carry.
      const editor = open({ type: 'paragraph', content: 'plain words' });
      select(editor, 3, 14);
      editor.addStyles({ code: true } as never);
      select(editor, 3, 14);

      expect(tool.canRun(editor)).toBe(false);
    });
  });

  ALL_TOOLS.forEach((tool) => {
    it(`answers for every run, blank or not, for ${tool.id}`, () => {
      // `ab cd` with both words styled and the space between them plain. The
      // keyboard reaches these same five commands through their own shortcuts
      // (`Mod-b` and friends, SelectionBubbleBar's own note), and those go
      // through BlockNote's reading, which counts that space. A button that
      // skipped it would say ON where the keyboard says OFF, and the two
      // would then do opposite things to the same selection.
      const editor = open({ type: 'paragraph', content: 'ab cd' });
      select(editor, 3, 5);
      editor.addStyles({ [tool.id]: true } as never);
      select(editor, 6, 8);
      editor.addStyles({ [tool.id]: true } as never);
      select(editor, 3, 8);
      expect(tool.isActive(editor)).toBe(false);

      tool.run(editor);

      expect(runsOf(editor)).toEqual([`ab cd[${tool.id}]`]);
    });

    it(`is never drawn pressed and unavailable at once for ${tool.id}`, () => {
      // A styled trailing space followed by a run no mark can land on. The
      // press takes the REMOVE path, which covers the whole highlight and
      // needs no room for a new mark, so availability cannot be judged on
      // the range an ADD would land in alone.
      const editor = open({ type: 'paragraph', content: 'word npm i' });
      select(editor, 3, 8);
      editor.addStyles({ [tool.id]: true } as never);
      select(editor, 8, 13);
      editor.addStyles({ code: true } as never);
      select(editor, 7, 13);

      expect([tool.isActive(editor), tool.canRun(editor)]).toEqual([true, true]);
    });

    it(`reads as off over plain text and the space after it for ${tool.id}`, () => {
      const editor = open({ type: 'paragraph', content: 'foo bar' });
      select(editor, 3, 7);

      expect(tool.isActive(editor)).toBe(false);
    });
  });

  /**
   * Selection that is nothing BUT whitespace. It styles like any other, since
   * a space is content and the selection is the range.
   */
  describe('a selection that is nothing but whitespace', () => {
    /**
     * A paragraph of `ab  cd` whose first three characters are italic, so the
     * two spaces in the middle fall in different runs.
     * @returns The editor, with the two spaces selected.
     */
    function twoRunsOfSpace(): ReturnType<typeof buildDocumentEditor> {
      const editor = open({ type: 'paragraph', content: 'ab  cd' });
      select(editor, 3, 6);
      editor.addStyles({ italic: true } as never);
      select(editor, 5, 7);
      return editor;
    }

    it('marks whitespace that spans two runs', () => {
      const editor = twoRunsOfSpace();

      MARK_TOOLS[0]!.run(editor);

      expect(runsOf(editor)).toEqual([
        'ab[italic]',
        ' [bold,italic]',
        ' [bold]',
        'cd[]',
      ]);
    });

    it('marks whitespace that spans two blocks', () => {
      // One line's trailing space plus the next line's leading one.
      const editor = openTwo(
        { type: 'paragraph', content: 'abc ' },
        { type: 'paragraph', content: ' def' },
      );
      select(editor, 6, 12);

      MARK_TOOLS[0]!.run(editor);

      expect(runsOf(editor)).toEqual(['abc[]', ' [bold]', ' [bold]', 'def[]']);
    });
  });
});

describe('the button and the press read the same predicate', () => {
  /** The paragraph's inline nodes, each with the marks it carries. */
  function inlineShape(
    editor: ReturnType<typeof buildDocumentEditor>,
  ): string[] {
    const out: string[] = [];
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.isText) {
        out.push(`"${node.text ?? ''}"[${node.marks.map((m) => m.type.name).join(',')}]`);
      } else if (node.isInline) {
        out.push(`<${node.type.name}>[${node.marks.map((m) => m.type.name).join(',')}]`);
      }
      return true;
    });
    return out;
  }

  /**
   * A line broken by Shift+Enter, whose break carries bold but not italic.
   *
   * The break picks the mark up on the first whole-line press, because
   * `addMark` covers every inline node rather than only text. That leaves an
   * inline leaf inside the selection whose marks differ from the words', which
   * is a shape only a reading that counts inline leaves answers the same way
   * the press does.
   * @returns The editor, with the whole line selected.
   */
  function lineWithAMarkedBreak(): ReturnType<typeof buildDocumentEditor> {
    const editor = open({ type: 'paragraph', content: 'abcdef' });
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insert(6, view.state.schema.nodes['hardBreak']!.create()));
    const bold = MARK_TOOLS.find((tool) => tool.id === 'bold')!;
    const italic = MARK_TOOLS.find((tool) => tool.id === 'italic')!;
    select(editor, 3, 10);
    bold.run(editor);
    select(editor, 3, 6);
    italic.run(editor);
    select(editor, 7, 10);
    italic.run(editor);
    select(editor, 3, 10);
    return editor;
  }

  it('reads off over a line whose break lacks the style', () => {
    const editor = lineWithAMarkedBreak();
    const italic = MARK_TOOLS.find((tool) => tool.id === 'italic')!;

    expect(inlineShape(editor)).toEqual([
      '"abc"[bold,italic]',
      '<hardBreak>[bold]',
      '"def"[bold,italic]',
    ]);
    expect(italic.isActive(editor)).toBe(false);
  });

  it('carries the style onto the break, which is what turns the button on', () => {
    const editor = lineWithAMarkedBreak();
    const italic = MARK_TOOLS.find((tool) => tool.id === 'italic')!;

    italic.run(editor);

    // The break is the one thing a reading that counts only text runs cannot
    // see, so this is the assertion that separates the two readings.
    expect(inlineShape(editor)).toEqual([
      '"abc"[bold,italic]',
      '<hardBreak>[bold,italic]',
      '"def"[bold,italic]',
    ]);
    select(editor, 3, 10);
    expect(italic.isActive(editor)).toBe(true);
  });

  it('never draws a tool pressed and unavailable over a lone marked break', () => {
    // One Shift+ArrowRight from the end of a Shift+Enter line selects the break
    // alone. Whatever the button says there, a press really does act on it, so
    // the two answers have to agree.
    const editor = lineWithAMarkedBreak();
    const bold = MARK_TOOLS.find((tool) => tool.id === 'bold')!;
    select(editor, 6, 7);

    expect([bold.isActive(editor), bold.canRun(editor)]).toEqual([true, true]);
  });

  it('keeps a caret lit after a press has armed the style', () => {
    // A press at a collapsed caret arms a stored mark rather than changing the
    // document, and the button has to go on saying so.
    const editor = open({ type: 'paragraph', content: 'hello' });
    const bold = MARK_TOOLS.find((tool) => tool.id === 'bold')!;
    select(editor, 5, 5);
    expect(bold.isActive(editor)).toBe(false);

    bold.run(editor);

    expect(bold.isActive(editor)).toBe(true);
  });
});
