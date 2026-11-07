// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The delete executor (inner#1790 design 5.3, steps 2 to 8): while a Space is
 * full, an editor's deletion is not translated by the sync plugin, which
 * would rewrite the joined blocks and add structs; the executor deletes the
 * same content straight from Yjs, so the update holds only a delete set.
 *
 * What to delete is read off the ProseMirror transaction the filter refused:
 * the ranges its steps remove, taken back to the document before it. Whole
 * nodes go whole, partial text goes as a text range, and two blocks a
 * deletion spans are never merged. Whether the result is a valid document is
 * left to the schema (`check()`), and whether it deletes no more than
 * ProseMirror itself would is checked against the transaction's own result.
 * ProseMirror positions are turned into Yjs ones by the binding's own
 * `absolutePositionToRelativePosition`.
 */

import type { Fragment as FragmentType, Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
import { Fragment } from '@tiptap/pm/model';
import type { PluginKey, Transaction } from '@tiptap/pm/state';
import { Mapping, ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import { absolutePositionToRelativePosition as tiptapRelativePosition } from '@tiptap/y-tiptap';
import { absolutePositionToRelativePosition as prosemirrorRelativePosition, ySyncPluginKey as prosemirrorSyncKey } from 'y-prosemirror';
import * as Y from 'yjs';

/**
 * The Yjs transaction meta an executor write carries, so an undo manager that
 * decides capture by other means (the document body's marker) can tell it
 * apart; its `addToHistory` meta then says whether it is the user's.
 */
export const SPACE_DELETE_META = 'spaceDelete';

/** The sync binding y-prosemirror and y-tiptap keep in their plugin state. */
export interface SpaceDeleteBinding {
  /** The fragment the editor is bound to. */
  readonly type: Y.XmlFragment;
  /** Its document. */
  readonly doc: Y.Doc;
  /** Y type to the ProseMirror node (or text nodes) it renders. */
  readonly mapping: ReadonlyMap<Y.AbstractType<unknown>, unknown>;
}

/** How a deletion is planned. */
export interface SpaceDeleteOptions {
  /** The editor's sync plugin key; it picks the binding's position helper and is the write's origin. */
  readonly syncKey: PluginKey;
  /** The Space is past its hard ceiling: only whole types may go. */
  readonly overCeiling: boolean;
  /** The user pressed Backspace or Delete, or cut: a refused deletion says so. */
  readonly deleteTriggered?: boolean;
}

/** Which sentence a refused deletion is told with: the add one, the compound one, or the over-ceiling one. */
export type SpaceDeleteRefusal = 'add' | 'compound' | 'over_ceiling';

/** A Y type the binding renders as a ProseMirror node. */
type YNode = Y.XmlElement | Y.XmlText;

/** One text range inside an `XmlText`. */
interface TextCut {
  readonly type: Y.XmlText;
  readonly index: number;
  readonly length: number;
}

/** What the executor writes, or why it does not. */
export type SpaceDeletePlan =
  | {
    ok: true;
    /** `delete` when some text range is cut, `remove` when only whole types go. */
    kind: 'delete' | 'remove';
    /** Text ranges, from the back of each `XmlText` to its front. */
    texts: readonly TextCut[];
    /** Whole types to delete. */
    types: readonly YNode[];
    /** Where the deletion starts in the document before it, for the caret. */
    at: number;
  }
  | { ok: false; refusal: SpaceDeleteRefusal };

/** A range in the document before the transaction. */
interface Range {
  readonly from: number;
  readonly to: number;
}

/** What the executor deletes, as positions in the document before the transaction. */
interface Targets {
  /** Nodes deleted whole, by position. */
  readonly nodes: Map<number, ProseMirrorNode>;
  /** Text deleted, in ranges. */
  readonly texts: Range[];
}

/**
 * Whether a slice puts in anything but wrappers and the empty text blocks a
 * schema fills in.
 * @param content - The slice's content.
 * @returns True when it holds text, a leaf, or a text block with content.
 */
function holdsContent(content: FragmentType): boolean {
  let found = false;
  content.descendants((node) => {
    if (found) return false;
    if (node.isLeaf || (node.isTextblock && node.content.size > 0)) found = true;
    return !found && !node.isTextblock;
  });
  return found;
}

/**
 * Whether a range holds text or a whole node, not just the open and close
 * tokens of nodes.
 * @param doc - The document.
 * @param from - Start.
 * @param to - End.
 * @returns True when something real lies inside.
 */
function coversSomething(doc: ProseMirrorNode, from: number, to: number): boolean {
  if (to <= from) return false;
  let found = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (node.isText || (pos >= from && pos + node.nodeSize <= to)) found = true;
    return !found;
  });
  return found;
}

/**
 * Step 1: the executor takes a transaction made only of deletions. A
 * `ReplaceAroundStep` counts when its two removed spans hold something; one
 * that only moves node boundaries changes a block's type or nesting.
 * @param tr - The refused transaction.
 * @returns True when every step is such a deletion.
 */
function accepts(tr: Transaction): boolean {
  return tr.steps.length > 0 && tr.steps.every((step, k) => {
    const doc = tr.docs[k]!;
    if (step instanceof ReplaceStep) return step.from < step.to && !holdsContent(step.slice.content);
    if (step instanceof ReplaceAroundStep) {
      return !holdsContent(step.slice.content)
        && (coversSomething(doc, step.from, step.gapFrom) || coversSomething(doc, step.gapTo, step.to));
    }
    return false;
  });
}

/**
 * Whether every step deletes something and puts nothing in: a deletion with
 * no key behind it (the side menu's delete) is told with the compound sentence.
 * @param tr - The refused transaction.
 * @returns True for such a transaction.
 */
function onlyDeletes(tr: Transaction): boolean {
  return tr.steps.length > 0 && tr.steps.every((step, k) => step instanceof ReplaceStep
    && step.from < step.to && !holdsContent(step.slice.content) && coversSomething(tr.docs[k]!, step.from, step.to));
}

/**
 * Step 2: the ranges the steps remove, taken back to the document before the
 * transaction through the inverse of the steps before each.
 * @param tr - The transaction.
 * @returns The ranges.
 */
function removedRanges(tr: Transaction): Range[] {
  const out: Range[] = [];
  tr.steps.forEach((step, k) => {
    // `Mapping.slice` keeps every map for `invert`, so the maps are cut first.
    const back = new Mapping(tr.mapping.maps.slice(0, k)).invert();
    const spans: Array<[number, number]> = step instanceof ReplaceAroundStep
      ? [[step.from, step.gapFrom], [step.gapTo, step.to]]
      : [[(step as ReplaceStep).from, (step as ReplaceStep).to]];
    for (const [a, b] of spans) {
      const from = back.map(a, 1);
      const to = back.map(b, -1);
      if (to > from) out.push({ from, to });
    }
  });
  return out;
}

/**
 * The block a text block belongs to: its BlockNote container, or itself.
 * @param $pos - A position inside the text block.
 * @returns The block and its position.
 */
function blockOf($pos: ResolvedPos): { node: ProseMirrorNode; pos: number } {
  const up = $pos.depth - 1;
  return up >= 0 && $pos.node(up).type.name === 'blockContainer'
    ? { node: $pos.node(up), pos: $pos.before(up) }
    : { node: $pos.parent, pos: $pos.before() };
}

/**
 * Whether one node lies inside another.
 * @param outer - The outer node and its position.
 * @param outer.node - The node.
 * @param outer.pos - Its position.
 * @param inner - The inner one's position.
 * @returns True when strictly inside.
 */
function contains(outer: { node: ProseMirrorNode; pos: number }, inner: number): boolean {
  return inner > outer.pos && inner < outer.pos + outer.node.nodeSize;
}

/**
 * Steps 3 and 4: what a range deletes. Nodes inside it go whole, text goes as
 * a range; when it spans two text blocks, the side left empty goes whole
 * unless it holds child blocks or the other side, and the two blocks are not
 * merged.
 * @param doc - The document before the transaction.
 * @param range - The range.
 * @param targets - Collected targets, added to.
 */
function collect(doc: ProseMirrorNode, range: Range, targets: Targets): void {
  const { from, to } = range;
  doc.nodesBetween(from, to, (node, pos) => {
    const end = pos + node.nodeSize;
    if (node.isText) {
      const a = Math.max(from, pos);
      const b = Math.min(to, end);
      if (b > a) targets.texts.push({ from: a, to: b });
      return false;
    }
    if (pos >= from && end <= to) {
      targets.nodes.set(pos, node);
      return false;
    }
    return true;
  });
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if ($from.parent === $to.parent || !$from.parent.isTextblock || !$to.parent.isTextblock) return;
  const start = blockOf($from);
  const finish = blockOf($to);
  /**
   * Whether a block may go whole: no child blocks, and not around the other side.
   * @param block - The block.
   * @param block.node - Its node.
   * @param block.pos - Its position.
   * @param other - The other side's position.
   * @returns True when it may.
   */
  const removable = (block: { node: ProseMirrorNode; pos: number }, other: number): boolean =>
    !(block.node.type.name === 'blockContainer' && block.node.childCount > 1) && !contains(block, other);
  if (to === $to.end() && removable(finish, start.pos)) targets.nodes.set(finish.pos, finish.node);
  else if (from === $from.start() && removable(start, finish.pos)) targets.nodes.set(start.pos, start.node);
}

/**
 * Whether a position lies inside one of the nodes going whole.
 * @param nodes - The nodes.
 * @param pos - The position.
 * @returns True when inside one.
 */
function insideWhole(nodes: ReadonlyMap<number, ProseMirrorNode>, pos: number): boolean {
  for (const [at, node] of nodes) if (at < pos && pos < at + node.nodeSize) return true;
  return false;
}

/**
 * Drops targets already inside a node going whole.
 * @param targets - The targets, changed in place.
 */
function dropCovered(targets: Targets): void {
  for (const at of [...targets.nodes.keys()]) if (insideWhole(targets.nodes, at)) targets.nodes.delete(at);
  for (let i = targets.texts.length - 1; i >= 0; i -= 1) {
    if (insideWhole(targets.nodes, targets.texts[i]!.from)) targets.texts.splice(i, 1);
  }
}

/**
 * Keeps a node in its smallest legal form: a text block loses its text and
 * inline nodes; any other node keeps its first child, made minimal too, and
 * each later child that its parent can do without goes whole. A leaf stays.
 * @param node - The node kept.
 * @param pos - Its position.
 * @param targets - The targets, added to.
 */
function keepMinimal(node: ProseMirrorNode, pos: number, targets: Targets): void {
  if (node.isLeaf) return;
  if (node.isTextblock) {
    node.forEach((child, offset) => {
      const at = pos + 1 + offset;
      if (child.isText) targets.texts.push({ from: at, to: at + child.nodeSize });
      else targets.nodes.set(at, child);
    });
    return;
  }
  const kept: ProseMirrorNode[] = [];
  node.forEach((child, offset, index) => {
    const at = pos + 1 + offset;
    const rest: ProseMirrorNode[] = [];
    for (let i = index + 1; i < node.childCount; i += 1) rest.push(node.child(i));
    if (index > 0 && node.type.validContent(Fragment.fromArray([...kept, ...rest]))) {
      targets.nodes.set(at, child);
      return;
    }
    kept.push(child);
    keepMinimal(child, at, targets);
  });
}

/**
 * Step 5's repairs: a kept node that would lose a child its schema requires
 * keeps that child, emptied; a node that would lose every child keeps one,
 * the first whose content is text when there is one, in its smallest form.
 * @param doc - The document before the transaction.
 * @param targets - The targets, changed in place.
 */
function keepRequired(doc: ProseMirrorNode, targets: Targets): void {
  // A wrapper of the whole body going whole is the blocks inside it going.
  doc.forEach((child, offset) => {
    if (!targets.nodes.has(offset) || child.isTextblock || child.isLeaf) return;
    targets.nodes.delete(offset);
    child.forEach((block, inner) => targets.nodes.set(offset + 1 + inner, block));
  });
  const parents: Array<[ProseMirrorNode, number]> = [];
  doc.descendants((node, pos) => {
    if (targets.nodes.has(pos) || insideWhole(targets.nodes, pos)) return false;
    if (!node.isTextblock && !node.isLeaf) parents.push([node, pos]);
    return !node.isTextblock;
  });
  parents.push([doc, -1]);
  for (const [parent, ppos] of parents) {
    if (targets.nodes.has(ppos) || insideWhole(targets.nodes, ppos)) continue;
    const children: Array<[number, ProseMirrorNode]> = [];
    parent.forEach((child, offset) => children.push([ppos + 1 + offset, child]));
    const left = children.filter(([at]) => !targets.nodes.has(at));
    if (left.length === children.length || parent.type.validContent(Fragment.fromArray(left.map(([, child]) => child)))) continue;
    if (left.length > 0) {
      // A child the schema requires, such as a block's content beside its children.
      for (const [at, child] of children) {
        if (!targets.nodes.has(at)) continue;
        targets.nodes.delete(at);
        keepMinimal(child, at, targets);
        break;
      }
      continue;
    }
    const pick = children.find(([, child]) => child.isTextblock || child.firstChild?.isTextblock === true) ?? children[0]!;
    targets.nodes.delete(pick[0]);
    keepMinimal(pick[1], pick[0], targets);
  }
  dropCovered(targets);
}

/**
 * The document with the targets deleted, as the executor would leave it.
 * @param node - The node to rebuild.
 * @param base - The position of its first child.
 * @param targets - What goes.
 * @returns Its children after the deletion.
 */
function simulate(node: ProseMirrorNode, base: number, targets: Targets): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  node.forEach((child, offset) => {
    const at = base + offset;
    if (targets.nodes.has(at)) return;
    if (child.isText) {
      const end = at + child.nodeSize;
      const cuts = targets.texts
        .filter((cut) => cut.from < end && cut.to > at)
        .map((cut) => [Math.max(cut.from, at) - at, Math.min(cut.to, end) - at] as const)
        .sort((x, y) => y[0] - x[0]);
      let text = child.text ?? '';
      for (const [a, b] of cuts) text = text.slice(0, a) + text.slice(b);
      if (text !== '') out.push(child.type.schema.text(text, child.marks));
      return;
    }
    out.push(child.isLeaf ? child : child.copy(Fragment.fromArray(simulate(child, at + 1, targets))));
  });
  return out;
}

/**
 * How many of each kind of non-text leaf a document holds.
 * @param doc - The document.
 * @returns Counts by node type name.
 */
function leafCounts(doc: ProseMirrorNode): Map<string, number> {
  const counts = new Map<string, number>();
  doc.descendants((node) => {
    if (node.isLeaf && !node.isText) counts.set(node.type.name, (counts.get(node.type.name) ?? 0) + 1);
    return true;
  });
  return counts;
}

/**
 * Whether one string is a subsequence of another.
 * @param short - The candidate.
 * @param long - The string it should be found in, in order.
 * @returns True when every character of `short` appears in `long` in order.
 */
function isSubsequence(short: string, long: string): boolean {
  let i = 0;
  for (const ch of long) if (i < short.length && ch === short[i]) i += 1;
  return i === short.length;
}

/**
 * Whether the executor deletes no more than ProseMirror's own result: its
 * text is a subsequence of the executor's, and no kind of leaf is fewer.
 * @param simulated - The executor's result.
 * @param result - ProseMirror's.
 * @returns True when the executor keeps at least as much.
 */
function keepsAsMuch(simulated: ProseMirrorNode, result: ProseMirrorNode): boolean {
  if (!isSubsequence(result.textContent, simulated.textContent)) return false;
  const kept = leafCounts(simulated);
  return [...leafCounts(result)].every(([type, count]) => (kept.get(type) ?? 0) >= count);
}

/**
 * Turns a ProseMirror position into a place in an `XmlText`.
 * @param pos - The position.
 * @param binding - The binding.
 * @param syncKey - The binding's plugin key.
 * @returns The text and index, or null when it does not resolve into one.
 */
function textAt(pos: number, binding: SpaceDeleteBinding, syncKey: PluginKey): { type: Y.XmlText; index: number } | null {
  const toRelative = syncKey === prosemirrorSyncKey ? prosemirrorRelativePosition : tiptapRelativePosition;
  const relative = toRelative(pos, binding.type, binding.mapping as Parameters<typeof toRelative>[2]) as Y.RelativePosition | null;
  const absolute = relative === null ? null : Y.createAbsolutePositionFromRelativePosition(relative, binding.doc);
  return absolute !== null && absolute.type instanceof Y.XmlText ? { type: absolute.type, index: absolute.index } : null;
}

/**
 * Step 6: finds the Y types and text ranges for the targets. A text range
 * that ends in a later `XmlText` (deleting an inline node leaves neighbours)
 * walks the `XmlText` siblings in between.
 * @param targets - What goes.
 * @param binding - The binding.
 * @param syncKey - The binding's plugin key.
 * @returns Whole types and text ranges, or null when something cannot be located.
 */
function locate(targets: Targets, binding: SpaceDeleteBinding, syncKey: PluginKey): { types: YNode[]; texts: TextCut[] } | null {
  // A text node maps from its `XmlText` as an array; every other node alone.
  const typeOf = new Map<unknown, YNode>();
  for (const [type, value] of binding.mapping) if (!Array.isArray(value)) typeOf.set(value, type as YNode);
  const types: YNode[] = [];
  for (const node of targets.nodes.values()) {
    const type = typeOf.get(node);
    if (type === undefined) return null;
    types.push(type);
  }
  const cuts = new Map<Y.XmlText, Array<[number, number]>>();
  /**
   * Records a cut in one `XmlText`.
   * @param type - The text.
   * @param a - Start index.
   * @param b - End index.
   */
  const cut = (type: Y.XmlText, a: number, b: number): void => {
    if (b > a) cuts.set(type, [...(cuts.get(type) ?? []), [a, b]]);
  };
  for (const { from, to } of targets.texts) {
    const start = textAt(from, binding, syncKey);
    const end = textAt(to, binding, syncKey);
    if (start === null || end === null) return null;
    if (start.type === end.type) {
      cut(start.type, start.index, end.index);
      continue;
    }
    cut(start.type, start.index, start.type.length);
    let reached = false;
    for (let item = start.type._item?.next ?? null; item !== null; item = item.next) {
      const sibling = item.content instanceof Y.ContentType ? item.content.type : null;
      if (!(sibling instanceof Y.XmlText)) break;
      if (sibling === end.type) {
        cut(sibling, 0, end.index);
        reached = true;
        break;
      }
      cut(sibling, 0, sibling.length);
    }
    if (!reached) return null;
  }
  const texts: TextCut[] = [];
  for (const [type, ranges] of cuts) {
    const covered = ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
    if (covered >= type.length) {
      types.push(type);
      continue;
    }
    for (const [a, b] of ranges.sort((x, y) => y[0] - x[0])) texts.push({ type, index: a, length: b - a });
  }
  return { types, texts };
}

/**
 * Steps 5 to 7 on collected targets.
 * @param doc - The document before the deletion.
 * @param result - ProseMirror's own result, or null when there is no transaction to compare with.
 * @param targets - What goes.
 * @param binding - The binding.
 * @param options - The planning options.
 * @param at - Where the deletion starts.
 * @returns The plan.
 */
function settle(
  doc: ProseMirrorNode,
  result: ProseMirrorNode | null,
  targets: Targets,
  binding: SpaceDeleteBinding,
  options: SpaceDeleteOptions,
  at: number,
): SpaceDeletePlan {
  dropCovered(targets);
  keepRequired(doc, targets);
  if (targets.nodes.size === 0 && targets.texts.length === 0) return { ok: false, refusal: 'compound' };
  const simulated = doc.copy(Fragment.fromArray(simulate(doc, 0, targets)));
  try {
    simulated.check();
  } catch {
    return { ok: false, refusal: 'compound' };
  }
  if (result !== null && !keepsAsMuch(simulated, result)) return { ok: false, refusal: 'compound' };
  const located = locate(targets, binding, options.syncKey);
  if (located === null) return { ok: false, refusal: 'add' };
  if (options.overCeiling && located.texts.length > 0) return { ok: false, refusal: 'over_ceiling' };
  return { ok: true, kind: located.texts.length > 0 ? 'delete' : 'remove', ...located, at };
}

/**
 * Plans the Yjs deletion for a refused editor transaction (design 5.3 steps 1 to 7).
 * @param tr - The transaction the filter refused.
 * @param binding - The editor's sync binding.
 * @param options - Its sync key, whether the Space is over its ceiling, and what triggered it.
 * @returns What to write, or which sentence to refuse with.
 */
export function planSpaceDelete(tr: Transaction, binding: SpaceDeleteBinding, options: SpaceDeleteOptions): SpaceDeletePlan {
  if (!accepts(tr)) return { ok: false, refusal: options.deleteTriggered === true || onlyDeletes(tr) ? 'compound' : 'add' };
  const ranges = removedRanges(tr);
  const targets: Targets = { nodes: new Map(), texts: [] };
  for (const range of ranges) collect(tr.before, range, targets);
  // Nothing to delete but the merge (Backspace at the start of a block with content).
  if (targets.nodes.size === 0 && targets.texts.length === 0) return { ok: false, refusal: 'compound' };
  return settle(tr.before, tr.doc, targets, binding, options, Math.min(...ranges.map((range) => range.from)));
}

/**
 * Plans deleting one node whole, as Backspace in an empty block does while
 * the Space is full (steps 5 to 7, with nothing to compare against).
 * @param doc - The document.
 * @param pos - The node's position.
 * @param binding - The editor's sync binding.
 * @param options - Its sync key and whether the Space is over its ceiling.
 * @returns What to write, or a refusal when the schema needs the node.
 */
export function planNodeRemoval(doc: ProseMirrorNode, pos: number, binding: SpaceDeleteBinding, options: SpaceDeleteOptions): SpaceDeletePlan {
  const node = doc.nodeAt(pos);
  if (node === null) return { ok: false, refusal: 'compound' };
  return settle(doc, null, { nodes: new Map([[pos, node]]), texts: [] }, binding, options, pos);
}

/**
 * Step 8's write, inside the Yjs transaction the caller opens with the sync
 * plugin key as origin (the key the editor's undo manager tracks): the text
 * ranges, then the whole types.
 * @param plan - An accepted plan.
 * @param ytr - The open transaction.
 * @param addToHistory - Whether the deletion goes on the undo stack.
 */
export function applySpaceDelete(plan: Extract<SpaceDeletePlan, { ok: true }>, ytr: Y.Transaction, addToHistory: boolean): void {
  ytr.meta.set('addToHistory', addToHistory);
  ytr.meta.set(SPACE_DELETE_META, true);
  for (const { type, index, length } of plan.texts) type.delete(index, length);
  for (const type of plan.types) {
    const parent = type.parent as Y.XmlFragment | null;
    if (type._item === null || type._item.deleted || parent === null) continue;
    parent.delete(parent.toArray().indexOf(type), 1);
  }
}
