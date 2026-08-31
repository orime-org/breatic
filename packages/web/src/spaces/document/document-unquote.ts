// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Taking the quotes off a selection, worked out in one pass (§6.3.1).
 *
 * A quote is 0 or 1 levels and never 2 (user 2026-08-31), so a press has to
 * leave every selected block unquoted however deep the lists go; A8 leaves
 * every block nobody selected in a quote of its own; rule 3 keeps what each
 * block is, so a freed list item is still an item of its own list and a freed
 * line that carried no marker still carries none; and A21 leaves the reader
 * holding what they were holding.
 *
 * Four promises over one structure, which is why they are answered together.
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

/** The content starts of the first and last of the press's blocks. */
interface Span {
  first: number;
  last: number;
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
    // Nothing this container refuses beside its siblings is one it takes on its
    // own: a list refuses whatever is not an item, and an item refuses whatever
    // cannot open it, both regardless of what came before.
    flush();
    out.push({ freed: run.freed, nodes: [child] });
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
 * The same positions, plus every text block inside this node.
 *
 * A list item travelling whole takes everything indented under it, so every
 * block in it is leaving the quote — a block a second quote holds inside the
 * item included, which is how that quote comes off too.
 * @param node - The node whose blocks are all leaving.
 * @param at - Where that node sits in the document.
 * @param picked - The positions the press started from.
 * @returns Those positions widened by the node's own blocks.
 */
function withEverythingIn(
  node: PMNode,
  at: number,
  picked: ReadonlySet<number>,
): ReadonlySet<number> {
  const wider = new Set(picked);
  node.descendants((child, pos) => {
    if (!child.isTextblock) return true;
    // `pos` is relative to this node's content, which starts at `at + 1`.
    wider.add(at + pos + 2);
    return false;
  });
  return wider;
}

/**
 * Cuts one node into runs of selected and unselected content.
 *
 * Five rules, and the whole behaviour follows from them:
 *
 * A text block is a run of its own, selected or not.
 *
 * A block with no text in it — an unsupported block a co-editor's version
 * wrote, a rule — has nothing to be picked, so it goes by where it stands: one
 * between two selected blocks travels with them (§6.0, user 2026-08-30).
 *
 * A list item whose FIRST block is selected goes as a whole, with everything
 * indented under it. That block carries the marker the reader sees, and what is
 * indented below belongs to it — the same reading Tab and Shift-Tab take, and
 * what `itemLift`'s second path in `document-block-press.ts` already does for
 * the exclusive rows. Every block in it is leaving, so the recursion runs over
 * it with all of them counted as picked, which takes a quote buried inside it
 * off as well.
 *
 * A quote keeps the runs nobody selected and hands the selected ones up bare.
 * That is what taking a quote off means, and doing it at every level is what
 * strips a legacy nested quote in one press (A22).
 *
 * Any other container puts each run back under a copy of itself, as far as the
 * schema allows — this is what keeps a freed line a list item, the list it
 * belonged to being rebuilt around it. Two limits. A list ITEM is the block
 * that opens it plus what follows, so only its FIRST run is still that item: a
 * later run put back under a copy would be a new item, carrying a marker the
 * reader never had (rule 3). And where the schema refuses a run — `listItem` is
 * `paragraph block*`, so it cannot hold one that opens with a list — the run
 * goes up a level and is offered to the container above.
 * @param node - The node to cut.
 * @param at - Where that node sits in the document.
 * @param picked - The positions of the selected text blocks' content starts.
 * @param span - The first and last of the press's blocks.
 * @param asItem - Whether a list holds this node, making it one of its items.
 * @returns Its content as runs, in document order.
 */
function splitForQuote(
  node: PMNode,
  at: number,
  picked: ReadonlySet<number>,
  span: Span,
  asItem: boolean,
): Run[] {
  if (node.isTextblock) return [{ freed: picked.has(at + 1), nodes: [node] }];
  if (node.isLeaf) return [{ freed: at > span.first && at < span.last, nodes: [node] }];

  const isList = isListName(node.type.name);
  const inside: Run[] = [];
  let offset = at + 1;
  node.forEach((child) => {
    // An item's first block sits two in: the item opens at `offset`, its
    // content at `offset + 1`, and that block's own content at `offset + 2`.
    const whole = isList && child.firstChild?.isTextblock === true && picked.has(offset + 2);
    const reach = whole ? withEverythingIn(child, offset, picked) : picked;
    inside.push(...splitForQuote(child, offset, reach, span, isList));
    offset += child.nodeSize;
  });

  const isQuote = QUOTE_NAMES.has(node.type.name);
  const out: Run[] = [];
  intoRuns(inside).forEach((run, index) => {
    if (isQuote && run.freed) out.push(run);
    else if (asItem && index > 0) out.push(run);
    else out.push(...packRun(node, run));
  });
  return out;
}

/**
 * Where every text block in the document starts, in document order.
 *
 * Rebuilding a quote's content moves every block in it and adds or removes
 * none, so a block's place in this list is what survives the rewrite — the
 * transaction's own mapping cannot follow a `replaceWith` back to the blocks
 * inside it.
 * @param doc - The document.
 * @returns Their content starts.
 */
function textBlocks(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    out.push(pos + 1);
    return false;
  });
  return out;
}

/**
 * The outermost quote holding each block, in reverse document order.
 *
 * The outermost is the one to rebuild: cutting it cuts every quote inside it
 * too, which is what leaves no level behind (A22). They come back last-first so
 * rewriting one does not move the next.
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
 * @param tr - The transaction, written into.
 * @param blocks - Where the press's blocks stood when it started.
 * @returns Whether any quote came off.
 */
export function unquoteSelection(tr: Transaction, blocks: number[]): boolean {
  const picked = new Set(blocks.map((pos) => tr.mapping.map(pos)));
  const quotes = outerQuotes(tr.doc, picked);
  if (quotes.length === 0) return false;

  const collapsed = tr.selection.empty;
  const heldHead = tr.selection.$from.parentOffset;
  const heldTail = tr.selection.$to.parentOffset;
  const ordinals = textBlocks(tr.doc).reduce<number[]>((found, pos, index) => {
    if (picked.has(pos)) found.push(index);
    return found;
  }, []);
  const reach = [...picked].sort((a, b) => a - b);
  const span = { first: reach[0] ?? 0, last: reach[reach.length - 1] ?? 0 };

  for (const at of quotes) {
    const quote = tr.doc.nodeAt(at);
    if (!quote) continue;
    const runs = splitForQuote(quote, at, picked, span, false);
    tr.replaceWith(at, at + quote.nodeSize, Fragment.fromArray(runs.flatMap((run) => run.nodes)));
  }

  // The selection goes back on the blocks the press acted on, found by their
  // ordinal since the rebuild moved them, at the offsets the reader held inside
  // them: A21 asks for the caret to stay on the same character and a range to
  // stay over the same words. The offsets are clamped, since ProseMirror throws
  // on a position past a block's end.
  const after = textBlocks(tr.doc);
  const from = after[ordinals[0] ?? -1];
  const to = after[ordinals[ordinals.length - 1] ?? -1];
  if (from === undefined || to === undefined) return true;
  const start = Math.min(from + heldHead, tr.doc.resolve(from).end());
  tr.setSelection(collapsed
    ? TextSelection.create(tr.doc, start)
    : TextSelection.create(tr.doc, start, Math.min(to + heldTail, tr.doc.resolve(to).end())));
  return true;
}
