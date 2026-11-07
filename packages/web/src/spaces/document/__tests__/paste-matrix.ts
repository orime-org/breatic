// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The combinations the placement takes (inner#1351 design §5.4.6): target
 * lines with the selection a user makes there, content shapes, and what
 * §5.4.3 puts for each, shared by every source's matrix.
 */

import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { Node as PMNode } from '@tiptap/pm/model';

import { OURS, positionOf, type Editor } from './paste-harness';
import { tableBlock } from './table-fixtures';

export type Block = { type: string; props: Record<string, unknown>; content?: unknown; children?: Block[] };

/** A piece of pasted content. */
export type Piece = 'w' | 'v' | 'P' | 'T';

/** The content shapes, by their pieces. */
export const CONTENTS: Record<string, Piece[]> = { WPV: ['w', 'P', 'v'], PV: ['P', 'v'], WP: ['w', 'P'], P: ['P'], TP: ['T', 'P'] };

export const NEW = `${OURS}new.png`;

/**
 * Words of inline content.
 * @param content - The content.
 * @returns The words.
 */
function words(content: unknown): string {
  return Array.isArray(content) ? (content as { text?: string; content?: unknown }[]).map((c) => c.text ?? words(c.content)).join('') : '';
}

/**
 * A block as a label: `p:words`, `h:words`, `code:words`, `img(name)`,
 * `T(cell/cell)`, quoted with a leading `>`, nested blocks in brackets.
 * @param block - The block.
 * @returns The label.
 */
function label(block: Block): string {
  const quote = block.props['quoted'] === true ? '>' : '';
  let own: string;
  if (block.type === 'image') {
    const url = String(block.props['url'] ?? '');
    own = `img(${url === '' ? 'new' : (url.split('/').pop() ?? '').replace(/\.png$/, '')})`;
  } else if (block.type === 'docTable') {
    const cellLabel = (cell: Block): string => {
      const blocks = cell.children ?? [];
      return blocks.length === 1 && blocks[0]!.type === 'paragraph' ? words(blocks[0]!.content) : blocks.map(label).join('|');
    };
    own = `T(${(block.children ?? []).map((row) => (row.children ?? []).map(cellLabel).join('/')).join(';')})`;
    return `${quote}${own}`;
  } else if (block.type === 'table') {
    const rows = (block.content as { rows: { cells: unknown[] }[] }).rows;
    own = `T(${rows.map((row) => row.cells.map((cell) => words(Array.isArray(cell) ? cell : (cell as { content?: unknown }).content)).join('/')).join(';')})`;
  } else {
    const kind = block.type === 'paragraph' ? 'p' : block.type === 'heading' ? 'h' : block.type === 'codeBlock' ? 'code' : block.type;
    own = `${kind}:${words(block.content)}`;
  }
  const kids = block.children ?? [];
  return `${quote}${own}${kids.length > 0 ? `[${kids.map(label).join('|')}]` : ''}`;
}

/**
 * Where the selection is: `@path:offset` for a caret in a line (the path of
 * block indices, nested ones joined by dots), `cells`, `node@path`, `gap`.
 * @param editor - The editor.
 * @returns It.
 */
export function where(editor: Editor): string {
  const { selection } = editor.prosemirrorView.state;
  if (selection instanceof CellSelection) return 'cells';
  const $at = selection.$head;
  const path: number[] = [];
  for (let depth = 1; depth <= $at.depth; depth += 1) {
    if (['blockContainer', 'docTable', 'docTableRow', 'docTableCell', 'docTableHeader'].includes($at.node(depth).type.name)) path.push($at.index(depth - 1));
  }
  if (selection instanceof NodeSelection) return `node@${path.join('.')}`;
  if (selection.constructor.name === 'GapCursor') return 'gap';
  return `@${path.join('.')}:${$at.parentOffset}`;
}

/**
 * The body as labels joined by `|`.
 * @param editor - The editor.
 * @returns They.
 */
export function shape(editor: Editor): string {
  return (editor.document as Block[]).map(label).join('|');
}

/**
 * Where a node of a type starts.
 * @param editor - The editor.
 * @param name - The type.
 * @param nth - Which one.
 * @returns Its position.
 */
export function nodeAt(editor: Editor, name: string, nth = 0): number {
  const found: number[] = [];
  editor.prosemirrorView.state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name === name) found.push(pos);
    return true;
  });
  return found[nth]!;
}

/**
 * Presses a key the way a user does.
 * @param editor - The editor.
 * @param key - The key.
 */
export function press(editor: Editor, key: string): void {
  const view = editor.prosemirrorView;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  view.someProp('handleKeyDown', (handle) => handle(view, event));
}

/**
 * Sets a selection, as a click or a drag over the body does.
 * @param editor - The editor.
 * @param from - Where it starts.
 * @param to - Where it ends.
 */
export function setText(editor: Editor, from: number, to = from): void {
  const view = editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  view.focus();
}

/** A target line: the body it sits in and how the user puts the selection there. */
export interface Target {
  readonly blocks: unknown[];
  readonly select: (editor: Editor) => void;
  /** Where a drop on the same spot points, when a drop can aim there. */
  readonly dropAt?: (editor: Editor) => number;
}

const LEAD = { type: 'paragraph', content: 'lead' };
const TAIL = { type: 'paragraph', content: 'tail' };
const LINE = { type: 'paragraph', content: 'abcd' };
const TWO_CELLS = tableBlock({ rows: [{ cells: ['c1', 'c2'] }] });

/**
 * A caret target at an offset into some words.
 * @param blocks - The body.
 * @param text - The words.
 * @param offset - The offset.
 * @returns The target.
 */
function caretTarget(blocks: unknown[], text: string, offset: number): Target {
  return {
    blocks,
    select: (editor) => setText(editor, positionOf(editor, text, offset)),
    dropAt: (editor) => positionOf(editor, text, offset),
  };
}

/**
 * A caret target in an empty line, the second block.
 * @param line - The line.
 * @returns The target.
 */
function emptyTarget(line: unknown): Target {
  const at = (editor: Editor): number => nodeAt(editor, 'blockContainer', 1) + 2;
  return { blocks: [LEAD, line, TAIL], select: (editor) => setText(editor, at(editor)), dropAt: at };
}

export const TARGETS: Record<string, Target> = {
  mid: caretTarget([LEAD, LINE, TAIL], 'abcd', 2),
  start: caretTarget([LEAD, LINE, TAIL], 'abcd', 0),
  end: caretTarget([LEAD, LINE, TAIL], 'abcd', 4),
  docEnd: caretTarget([LEAD, LINE], 'abcd', 4),
  quotedMid: caretTarget([LEAD, { ...LINE, props: { quoted: true } }, TAIL], 'abcd', 2),
  emptyP: emptyTarget({ type: 'paragraph' }),
  emptyH: emptyTarget({ type: 'heading' }),
  emptyQ: emptyTarget({ type: 'paragraph', props: { quoted: true } }),
  fullLine: { blocks: [LEAD, LINE, TAIL], select: (editor) => setText(editor, positionOf(editor, 'abcd', 0), positionOf(editor, 'abcd', 4)) },
  fullHeading: {
    blocks: [LEAD, { type: 'heading', content: 'abcd' }, TAIL],
    select: (editor) => setText(editor, positionOf(editor, 'abcd', 0), positionOf(editor, 'abcd', 4)),
  },
  crossBlock: {
    blocks: [LEAD, LINE, { type: 'paragraph', content: 'efgh' }, TAIL],
    select: (editor) => setText(editor, positionOf(editor, 'abcd', 2), positionOf(editor, 'efgh', 2)),
  },
  nestedEnd: caretTarget([LEAD, { ...LINE, children: [{ type: 'paragraph', content: 'kid' }] }, TAIL], 'kid', 3),
  kidsMid: caretTarget([LEAD, { ...LINE, children: [{ type: 'paragraph', content: 'kid' }] }, TAIL], 'abcd', 2),
  cell: caretTarget([LEAD, TWO_CELLS, TAIL], 'c1', 2),
  cellSel: {
    blocks: [LEAD, TWO_CELLS, TAIL],
    select: (editor) => {
      const view = editor.prosemirrorView;
      view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, nodeAt(editor, 'docTableCell', 0), nodeAt(editor, 'docTableCell', 1))));
      view.focus();
    },
  },
  code: caretTarget([LEAD, { type: 'codeBlock', content: 'xy' }, TAIL], 'xy', 1),
  emptyCode: emptyTarget({ type: 'codeBlock' }),
  nodeSel: {
    blocks: [LEAD, { type: 'image', props: { url: `${OURS}old.png` } }, TAIL],
    select: (editor) => {
      const view = editor.prosemirrorView;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodeAt(editor, 'image'))));
      view.focus();
    },
  },
  inlineSel: {
    blocks: [LEAD, LINE, TAIL],
    select: (editor) => {
      const view = editor.prosemirrorView;
      const at = positionOf(editor, 'abcd', 2);
      view.dispatch(view.state.tr.insert(at, view.state.schema.nodes['unsupportedInline']!.create()));
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
      view.focus();
    },
  },
  gapArrow: {
    blocks: [LEAD, { type: 'image', props: { url: `${OURS}old1.png` } }, { type: 'image', props: { url: `${OURS}old2.png` } }, TAIL],
    select: (editor) => {
      const view = editor.prosemirrorView;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodeAt(editor, 'image', 1))));
      view.focus();
      press(editor, 'ArrowLeft');
    },
  },
  allSel: {
    blocks: [LEAD, LINE, TAIL],
    // The body takes no Mod-a of its own: the browser selects all of it and ProseMirror reads that back as text from the first line to the last.
    select: (editor) => setText(editor, positionOf(editor, 'lead', 0), positionOf(editor, 'tail', 4)),
  },
};

/**
 * What the design (§5.4.3) puts, by target and content: the body and the selection.
 * Content pasted from the web and from the body lands the same; the canvas
 * differs only in blocks that take words (A7), listed in BESIDE_TEXT_ONLY.
 */
export const EXPECTED: Record<string, Record<string, [string, string]>> = {
  mid: {
    WPV: ['p:lead|p:abw|img(new)|p:vcd|p:tail', '@3:1'],
    PV: ['p:lead|p:ab|img(new)|p:vcd|p:tail', '@3:1'],
    WP: ['p:lead|p:abw|img(new)|p:cd|p:tail', '@3:0'],
    P: ['p:lead|p:ab|img(new)|p:cd|p:tail', '@3:0'],
    TP: ['p:lead|p:ab|T(cell)|img(new)|p:cd|p:tail', '@4:0'],
  },
  start: {
    WPV: ['p:lead|p:w|img(new)|p:vabcd|p:tail', '@3:1'],
    PV: ['p:lead|img(new)|p:vabcd|p:tail', '@2:1'],
    WP: ['p:lead|p:w|img(new)|p:abcd|p:tail', '@3:0'],
    P: ['p:lead|img(new)|p:abcd|p:tail', '@2:0'],
    TP: ['p:lead|T(cell)|img(new)|p:abcd|p:tail', '@3:0'],
  },
  end: {
    WPV: ['p:lead|p:abcdw|img(new)|p:v|p:tail', '@3:1'],
    PV: ['p:lead|p:abcd|img(new)|p:v|p:tail', '@3:1'],
    WP: ['p:lead|p:abcdw|img(new)|p:tail', '@3:0'],
    P: ['p:lead|p:abcd|img(new)|p:tail', '@3:0'],
    TP: ['p:lead|p:abcd|T(cell)|img(new)|p:tail', '@4:0'],
  },
  docEnd: {
    WPV: ['p:lead|p:abcdw|img(new)|p:v', '@3:1'],
    PV: ['p:lead|p:abcd|img(new)|p:v', '@3:1'],
    WP: ['p:lead|p:abcdw|img(new)|p:', '@3:0'],
    P: ['p:lead|p:abcd|img(new)|p:', '@3:0'],
    TP: ['p:lead|p:abcd|T(cell)|img(new)|p:', '@4:0'],
  },
  quotedMid: {
    WPV: ['p:lead|>p:abw|>img(new)|>p:vcd|p:tail', '@3:1'],
    PV: ['p:lead|>p:ab|>img(new)|>p:vcd|p:tail', '@3:1'],
    WP: ['p:lead|>p:abw|>img(new)|>p:cd|p:tail', '@3:0'],
    P: ['p:lead|>p:ab|>img(new)|>p:cd|p:tail', '@3:0'],
    TP: ['p:lead|>p:ab|>T(cell)|>img(new)|>p:cd|p:tail', '@4:0'],
  },
  emptyP: {
    WPV: ['p:lead|p:w|img(new)|p:v|p:tail', '@3:1'],
    PV: ['p:lead|img(new)|p:v|p:tail', '@2:1'],
    WP: ['p:lead|p:w|img(new)|p:|p:tail', '@3:0'],
    P: ['p:lead|img(new)|p:|p:tail', '@2:0'],
    TP: ['p:lead|T(cell)|img(new)|p:|p:tail', '@3:0'],
  },
  emptyH: {
    WPV: ['p:lead|h:w|img(new)|h:v|p:tail', '@3:1'],
    PV: ['p:lead|img(new)|h:v|p:tail', '@2:1'],
    WP: ['p:lead|h:w|img(new)|h:|p:tail', '@3:0'],
    P: ['p:lead|img(new)|h:|p:tail', '@2:0'],
    TP: ['p:lead|T(cell)|img(new)|h:|p:tail', '@3:0'],
  },
  emptyQ: {
    WPV: ['p:lead|>p:w|>img(new)|>p:v|p:tail', '@3:1'],
    PV: ['p:lead|>img(new)|>p:v|p:tail', '@2:1'],
    WP: ['p:lead|>p:w|>img(new)|>p:|p:tail', '@3:0'],
    P: ['p:lead|>img(new)|>p:|p:tail', '@2:0'],
    TP: ['p:lead|>T(cell)|>img(new)|>p:|p:tail', '@3:0'],
  },
  fullLine: {
    WPV: ['p:lead|p:w|img(new)|p:v|p:tail', '@3:1'],
    PV: ['p:lead|img(new)|p:v|p:tail', '@2:1'],
    WP: ['p:lead|p:w|img(new)|p:tail', '@3:0'],
    P: ['p:lead|img(new)|p:tail', '@2:0'],
    TP: ['p:lead|T(cell)|img(new)|p:tail', '@3:0'],
  },
  fullHeading: {
    WPV: ['p:lead|h:w|img(new)|p:v|p:tail', '@3:1'],
    PV: ['p:lead|img(new)|p:v|p:tail', '@2:1'],
    WP: ['p:lead|h:w|img(new)|p:tail', '@3:0'],
    P: ['p:lead|img(new)|p:tail', '@2:0'],
    TP: ['p:lead|T(cell)|img(new)|p:tail', '@3:0'],
  },
  crossBlock: {
    WPV: ['p:lead|p:abw|img(new)|p:vgh|p:tail', '@3:1'],
    PV: ['p:lead|p:ab|img(new)|p:vgh|p:tail', '@3:1'],
    WP: ['p:lead|p:abw|img(new)|p:gh|p:tail', '@3:0'],
    P: ['p:lead|p:ab|img(new)|p:gh|p:tail', '@3:0'],
    TP: ['p:lead|p:ab|T(cell)|img(new)|p:gh|p:tail', '@4:0'],
  },
  nestedEnd: {
    WPV: ['p:lead|p:abcd[p:kidw|img(new)|p:v]|p:tail', '@1.2:1'],
    PV: ['p:lead|p:abcd[p:kid|img(new)|p:v]|p:tail', '@1.2:1'],
    WP: ['p:lead|p:abcd[p:kidw|img(new)]|p:tail', '@2:0'],
    P: ['p:lead|p:abcd[p:kid|img(new)]|p:tail', '@2:0'],
    TP: ['p:lead|p:abcd[p:kid|T(cell)|img(new)]|p:tail', '@2:0'],
  },
  kidsMid: {
    WPV: ['p:lead|p:abw|img(new)|p:vcd[p:kid]|p:tail', '@3:1'],
    PV: ['p:lead|p:ab|img(new)|p:vcd[p:kid]|p:tail', '@3:1'],
    WP: ['p:lead|p:abw|img(new)|p:cd[p:kid]|p:tail', '@3:0'],
    P: ['p:lead|p:ab|img(new)|p:cd[p:kid]|p:tail', '@3:0'],
    TP: ['p:lead|p:ab|T(cell)|img(new)|p:cd[p:kid]|p:tail', '@4:0'],
  },
  cell: {
    WPV: ['p:lead|T(p:c1w|img(new)|p:v/c2)|p:tail', '@1.0.0.2:1'],
    PV: ['p:lead|T(p:c1|img(new)|p:v/c2)|p:tail', '@1.0.0.2:1'],
    WP: ['p:lead|T(p:c1w|img(new)|p:/c2)|p:tail', '@1.0.0.2:0'],
    P: ['p:lead|T(p:c1|img(new)|p:/c2)|p:tail', '@1.0.0.2:0'],
    TP: ['p:lead|T(c1/c2)|p:tail', '@1.0.0.0:2'],
  },
  cellSel: {
    WPV: ['p:lead|T(p:w|img(new)|p:v/p:w|img(new)|p:v)|p:tail', '@1.0.0.2:1'],
    PV: ['p:lead|T(img(new)|p:v/img(new)|p:v)|p:tail', '@1.0.0.1:1'],
    WP: ['p:lead|T(p:w|img(new)|p:/p:w|img(new))|p:tail', '@1.0.0.2:0'],
    P: ['p:lead|T(img(new)|p:/img(new))|p:tail', '@1.0.0.1:0'],
    TP: ['p:lead|T(c1/c2)|p:tail', 'cells'],
  },
  code: {
    WPV: ['p:lead|code:xw\nvy|img(new)|p:tail', '@3:0'],
    PV: ['p:lead|code:xvy|img(new)|p:tail', '@3:0'],
    WP: ['p:lead|code:xwy|img(new)|p:tail', '@3:0'],
    P: ['p:lead|code:xy|img(new)|p:tail', '@3:0'],
    TP: ['p:lead|code:xcelly|img(new)|p:tail', '@3:0'],
  },
  emptyCode: {
    WPV: ['p:lead|code:w\nv|img(new)|p:tail', '@3:0'],
    PV: ['p:lead|code:v|img(new)|p:tail', '@3:0'],
    WP: ['p:lead|code:w|img(new)|p:tail', '@3:0'],
    P: ['p:lead|img(new)|code:|p:tail', '@2:0'],
    TP: ['p:lead|code:cell|img(new)|p:tail', '@3:0'],
  },
  nodeSel: {
    WPV: ['p:lead|p:w|img(new)|p:v|p:tail', '@3:1'],
    PV: ['p:lead|img(new)|p:v|p:tail', '@2:1'],
    WP: ['p:lead|p:w|img(new)|p:tail', '@3:0'],
    P: ['p:lead|img(new)|p:tail', '@2:0'],
    TP: ['p:lead|T(cell)|img(new)|p:tail', '@3:0'],
  },
  gapArrow: {
    WPV: ['p:lead|img(old1)|p:w|img(new)|p:v|img(old2)|p:tail', '@4:1'],
    PV: ['p:lead|img(old1)|img(new)|p:v|img(old2)|p:tail', '@3:1'],
    WP: ['p:lead|img(old1)|p:w|img(new)|p:|img(old2)|p:tail', '@4:0'],
    P: ['p:lead|img(old1)|img(new)|p:|img(old2)|p:tail', '@3:0'],
    TP: ['p:lead|img(old1)|T(cell)|img(new)|p:|img(old2)|p:tail', '@4:0'],
  },
  allSel: {
    WPV: ['p:w|img(new)|p:v', '@2:1'],
    PV: ['img(new)|p:v', '@1:1'],
    WP: ['p:w|img(new)|p:', '@2:0'],
    P: ['img(new)|p:', '@1:0'],
    TP: ['T(cell)|img(new)|p:', '@2:0'],
  },
};
EXPECTED['inlineSel'] = EXPECTED['mid']!;

/** Blocks that take words: canvas content and files go beside them whole (A7). */
export const BESIDE_TEXT_ONLY: Record<string, Record<string, [string, string]>> = {
  code: {
    WPV: ['p:lead|code:xy|p:w|img(new)|p:v|p:tail', '@4:1'],
    PV: ['p:lead|code:xy|img(new)|p:v|p:tail', '@3:1'],
    WP: ['p:lead|code:xy|p:w|img(new)|p:tail', '@4:0'],
    P: ['p:lead|code:xy|img(new)|p:tail', '@3:0'],
  },
  emptyCode: {
    WPV: ['p:lead|p:w|img(new)|p:v|code:|p:tail', '@4:0'],
    PV: ['p:lead|img(new)|p:v|code:|p:tail', '@3:0'],
    WP: ['p:lead|p:w|img(new)|code:|p:tail', '@3:0'],
    P: ['p:lead|img(new)|code:|p:tail', '@2:0'],
  },
};


/**
 * What §5.4.3 puts for a target and a content.
 * @param target - The target.
 * @param content - The content.
 * @param beside - Whether the whole content goes beside a block that takes words (canvas, files).
 * @returns The body and the selection.
 */
export function expected(target: string, content: string, beside: boolean): [string, string] {
  return (beside ? BESIDE_TEXT_ONLY[target]?.[content] : undefined) ?? EXPECTED[target]![content]!;
}
