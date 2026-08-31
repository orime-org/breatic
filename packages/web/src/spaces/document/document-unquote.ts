// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Taking the quotes off a selection, worked out in one pass (§6.3.1).
 *
 * A quote is 0 or 1 levels and never 2 (user 2026-08-31), so a press has to
 * leave every selected block unquoted however deep the lists go; A8 leaves
 * every block nobody selected in a quote of its own; and rule 3 keeps what each
 * block is — a freed list item is still an item of its own list.
 *
 * Three promises over one structure, which is why they are answered together.
 * Doing them as separate steps — split the list, carry the buried part out,
 * lift what is left — gave each step a part of the selection to act on and
 * nobody the whole, and every shape that broke broke on a seam between two of
 * them (round 9: 14 problems, four independent reviewers, all on the seams).
 *
 * Here the quote's content is cut into runs that are wholly selected or wholly
 * not, and each run is put back under as much of its original nesting as the
 * schema will take. The rules are in {@link splitForQuote}.
 */

import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';

import { QUOTE_NAMES, isListName } from '@web/spaces/document/document-block-model';

/** The stretch of document the press's blocks span, ends included. */
interface Span {
  from: number;
  to: number;
}

/** A stretch of nodes that is either wholly selected or wholly not. */
interface Run {
  /** Whether these nodes are leaving the quote. */
  freed: boolean;
  nodes: PMNode[];
}

/**
 * Would this node take these children?
 * @param node - The node whose type and attributes are being reused.
 * @param nodes - The children to put in it.
 * @returns A copy of the node holding them, or null where the schema refuses.
 */
function reWrap(node: PMNode, nodes: PMNode[]): PMNode | null {
  const content = Fragment.fromArray(nodes);
  return node.type.validContent(content) ? node.copy(content) : null;
}

/**
 * Puts one run back under a container, taking as many of its nodes as fit.
 *
 * A list whose items were all selected goes back as one list, so its numbering
 * runs on. Where the run mixes what the container takes with what it does not —
 * a bullet list asked to hold an item and a whole ordered list, which happens
 * when the selection covers a buried line and the item below it — the nodes it
 * cannot take are handed to the level above rather than dropped.
 * @param node - The container being rebuilt.
 * @param run - The run to put back.
 * @returns The run as it stands after this level, in document order.
 */
function packRun(node: PMNode, run: Run): Run[] {
  const out: Run[] = [];
  let batch: PMNode[] = [];
  /** Puts what has gathered so far back under the container. */
  const flush = (): void => {
    if (batch.length === 0) return;
    const held = reWrap(node, batch);
    out.push({ freed: run.freed, nodes: held ? [held] : batch });
    batch = [];
  };
  for (const child of run.nodes) {
    if (reWrap(node, [...batch, child])) {
      batch.push(child);
      continue;
    }
    flush();
    if (reWrap(node, [child])) batch = [child];
    else out.push({ freed: run.freed, nodes: [child] });
  }
  flush();
  return out;
}

/**
 * Groups pieces into runs of one side, keeping document order.
 * @param pieces - The pieces, in document order.
 * @returns The same nodes, gathered into runs.
 */
function intoRuns(pieces: Run[]): Run[] {
  const runs: Run[] = [];
  for (const piece of pieces) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.freed === piece.freed) last.nodes.push(...piece.nodes);
    else runs.push({ freed: piece.freed, nodes: [...piece.nodes] });
  }
  return runs;
}

/**
 * Cuts one node into runs of selected and unselected content.
 *
 * Four rules, and the whole behaviour follows from them:
 *
 * A text block is a run of its own, selected or not.
 *
 * A list item whose FIRST block is selected goes as a whole. That block carries
 * the marker the reader sees, and whatever is indented below it belongs to it —
 * the same reading Tab and Shift-Tab take, and what `itemLift`'s second path in
 * `document-block-press.ts` already does for the exclusive rows.
 *
 * A quote keeps the runs nobody selected and hands the selected ones up bare.
 * That is what taking a quote off means, and doing it at every level is what
 * strips a legacy nested quote in one press (A22).
 *
 * Any other container puts each run back under a copy of itself, as far as the
 * schema allows. This is what keeps a freed line a list item: the list it
 * belonged to is rebuilt around it. Where the schema refuses — `listItem` is
 * `paragraph block*`, so it cannot hold a run that opens with a list — the run
 * goes up a level and is offered to the container above.
 *
 * A block with no text in it — an unsupported block a co-editor's version
 * wrote, a rule — has nothing to be picked, so it goes by where it stands: one
 * between two selected blocks travels with them (§6.0, user 2026-08-30).
 * @param node - The node to cut.
 * @param at - Where that node sits in the document.
 * @param picked - The positions of the selected text blocks' content starts.
 * @param span - Where the press's blocks begin and end.
 * @returns Its content as runs, in document order.
 */
function splitForQuote(
  node: PMNode,
  at: number,
  picked: ReadonlySet<number>,
  span: Span,
): Run[] {
  if (node.isTextblock) return [{ freed: picked.has(at + 1), nodes: [node] }];
  if (node.isLeaf) return [{ freed: at > span.from && at < span.to, nodes: [node] }];
  if (isListName(node.type.name)) return splitList(node, at, picked, span);

  const inside: Run[] = [];
  let offset = at + 1;
  node.forEach((child) => {
    inside.push(...splitForQuote(child, offset, picked, span));
    offset += child.nodeSize;
  });

  const isQuote = QUOTE_NAMES.has(node.type.name);
  const out: Run[] = [];
  for (const run of intoRuns(inside)) {
    if (isQuote && run.freed) out.push(run);
    else out.push(...packRun(node, run));
  }
  return out;
}

/**
 * Cuts a list's items, letting a whole item go where its first block is picked.
 * @param list - The list node.
 * @param at - Where it sits in the document.
 * @param picked - The positions of the selected text blocks' content starts.
 * @param span - Where the press's blocks begin and end.
 * @returns Its items as runs, in document order.
 */
function splitList(list: PMNode, at: number, picked: ReadonlySet<number>, span: Span): Run[] {
  const inside: Run[] = [];
  let offset = at + 1;
  list.forEach((item) => {
    const first = item.firstChild;
    // The item's content start is offset + 1; its first block's is one further.
    if (first?.isTextblock && picked.has(offset + 2)) inside.push({ freed: true, nodes: [item] });
    else inside.push(...splitForQuote(item, offset, picked, span));
    offset += item.nodeSize;
  });
  const out: Run[] = [];
  for (const run of intoRuns(inside)) out.push(...packRun(list, run));
  return out;
}

/**
 * Where each of these blocks stands among the document's text blocks.
 *
 * Rebuilding a quote's content moves every block in it and adds or removes
 * none, so a block's place in that count is what survives the rewrite — the
 * transaction's own mapping cannot follow a `replaceWith` back to the blocks
 * inside it.
 * @param doc - The document.
 * @param positions - Content-start positions of the blocks to find.
 * @returns Their ordinals, ascending.
 */
function ordinalsOf(doc: PMNode, positions: ReadonlySet<number>): number[] {
  const out: number[] = [];
  let seen = 0;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (positions.has(pos + 1)) out.push(seen);
    seen += 1;
    return false;
  });
  return out;
}

/**
 * The content start of the text block at this ordinal.
 * @param doc - The document.
 * @param ordinal - Which text block, counting from zero.
 * @returns Its content start, or null where the document holds fewer blocks.
 */
function blockAtOrdinal(doc: PMNode, ordinal: number): number | null {
  let seen = 0;
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (!node.isTextblock) return true;
    if (seen === ordinal) found = pos + 1;
    seen += 1;
    return false;
  });
  return found;
}

/**
 * The outermost quote holding each block, innermost-last in the document.
 *
 * The outermost is the one to rebuild: cutting it cuts every quote inside it
 * too, which is what leaves no level behind (A22). They come back in reverse
 * document order so rewriting one does not move the next.
 * @param doc - The document.
 * @param picked - The positions of the selected text blocks' content starts.
 * @returns Where those quotes start, descending.
 */
function outerQuotes(doc: PMNode, picked: ReadonlySet<number>): number[] {
  const found = new Set<number>();
  for (const pos of picked) {
    const $pos = doc.resolve(pos);
    for (let depth = 1; depth <= $pos.depth; depth += 1) {
      if (!QUOTE_NAMES.has($pos.node(depth).type.name)) continue;
      found.add($pos.before(depth));
      break;
    }
  }
  return [...found].sort((a, b) => b - a);
}

/**
 * Takes the quotes off the selection, leaving everything else quoted.
 *
 * Rebuilds each quote the selection reaches, then puts the selection back on
 * the blocks the press was given by their place among the document's text
 * blocks. A collapsed selection stays collapsed (A21).
 * @param tr - The transaction, written into.
 * @param blocks - Where the press's blocks stood when it started.
 * @returns Whether any quote came off.
 */
export function unquoteSelection(tr: Transaction, blocks: number[]): boolean {
  const picked = new Set(blocks.map((pos) => tr.mapping.map(pos)));
  const quotes = outerQuotes(tr.doc, picked);
  if (quotes.length === 0) return false;

  const wasCollapsed = tr.selection.empty;
  const ordinals = ordinalsOf(tr.doc, picked);
  const reach = [...picked].sort((a, b) => a - b);
  const span = { from: (reach[0] ?? 0) - 1, to: reach[reach.length - 1] ?? 0 };

  for (const at of quotes) {
    const quote = tr.doc.nodeAt(at);
    if (!quote) continue;
    const runs = splitForQuote(quote, at, picked, span);
    tr.replaceWith(at, at + quote.nodeSize, Fragment.fromArray(runs.flatMap((run) => run.nodes)));
  }

  const head = ordinals[0];
  const tail = ordinals[ordinals.length - 1];
  if (head === undefined || tail === undefined) return true;
  const from = blockAtOrdinal(tr.doc, head);
  const to = blockAtOrdinal(tr.doc, tail);
  if (from === null || to === null) return true;
  tr.setSelection(wasCollapsed
    ? TextSelection.create(tr.doc, from)
    : TextSelection.create(tr.doc, from, tr.doc.resolve(to).end()));
  return true;
}
