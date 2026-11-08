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
 * left to the schema (each deletion is a `ReplaceStep` the schema checks),
 * and whether it deletes no more than ProseMirror itself would is checked
 * against the transaction's own result. ProseMirror positions are turned into
 * Yjs ones by the binding's own `absolutePositionToRelativePosition`.
 *
 * The write holds the binding's `mux`, so the sync plugin does not redraw the
 * whole document from Yjs; the executor dispatches the same deletions as one
 * sync-keyed transaction and keeps the binding's mapping as the redraw would.
 */

import type { Fragment as FragmentType, Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
import { Fragment, Slice } from '@tiptap/pm/model';
import { TextSelection, type PluginKey, type Transaction } from '@tiptap/pm/state';
import { Mapping, ReplaceAroundStep, ReplaceStep, Transform } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { absolutePositionToRelativePosition as tiptapRelativePosition } from '@tiptap/y-tiptap';
import { absolutePositionToRelativePosition as prosemirrorRelativePosition, ySyncPluginKey as prosemirrorSyncKey } from 'y-prosemirror';
import * as Y from 'yjs';

import { writeSpaceDoc } from '@web/data/yjs/space-write';

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
  readonly mapping: ReadonlyMap<unknown, unknown>;
}

/** The binding as the write needs it: its mapping kept up, its redraw held off. */
export interface SpaceDeleteWriteBinding extends SpaceDeleteBinding {
  readonly mapping: Map<unknown, unknown>;
  /** The binding's mutex: a Yjs change made inside it is not redrawn. */
  readonly mux: (run: () => void) => void;
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

/** A Y type that holds children. */
type YParent = Y.XmlFragment;

/** One text range inside an `XmlText`. */
interface TextCut {
  readonly type: Y.XmlText;
  readonly index: number;
  readonly length: number;
}

/** A whole type to delete, at its index in its parent. */
interface TypeCut {
  readonly parent: YParent;
  readonly index: number;
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
    types: readonly TypeCut[];
    /** The same deletions on the ProseMirror document, in the order they apply. */
    steps: readonly ReplaceStep[];
    /** Each Y type whose node changes, with that node's position before the deletion (-1 for the root). */
    paths: ReadonlyMap<YParent, number>;
    /** Where the deletion starts in the document before it, for the caret. */
    at: number;
  }
  | { ok: false; refusal: SpaceDeleteRefusal };

/** A range in the document before the transaction. */
interface Range {
  readonly from: number;
  readonly to: number;
}

/** A node deleted whole, with where it sits. */
interface Whole {
  readonly pos: number;
  readonly node: ProseMirrorNode;
  readonly parent: ProseMirrorNode;
  /** The parent's position, -1 for the document. */
  readonly parentPos: number;
  readonly index: number;
}

/** What the executor deletes, as positions in the document before the transaction. */
interface Targets {
  /** Nodes deleted whole, by position. */
  readonly nodes: Map<number, Whole>;
  /** Text deleted, in ranges. */
  texts: Range[];
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
 * The Y types on the path from the root to a node, each checked against the
 * binding's mapping. Above a text block, children map to Y children one to one.
 * @param doc - The document.
 * @param pos - The node's position (a node with content), or -1 for the root.
 * @param binding - The binding.
 * @returns Each Y type with its node's position, root first, or null when the mapping does not agree.
 */
function yPath(doc: ProseMirrorNode, pos: number, binding: SpaceDeleteBinding): Array<[YParent, number]> | null {
  const path: Array<[YParent, number]> = [[binding.type, -1]];
  if (pos < 0) return path;
  const $pos = doc.resolve(pos + 1);
  let type: YParent = binding.type;
  for (let depth = 0; depth < $pos.depth; depth += 1) {
    const child = type.get($pos.index(depth)) as unknown;
    if (!(child instanceof Y.XmlElement) || binding.mapping.get(child) !== $pos.node(depth + 1)) return null;
    type = child;
    path.push([type, $pos.before(depth + 1)]);
  }
  return path;
}

/**
 * The deletion a transaction makes inside one `XmlText`, if that is all it
 * does: every step deletes text only, in one text block whose Y element holds
 * that single `XmlText` (design 5.3). y-prosemirror writes such a deletion as
 * a delete set alone.
 * @param tr - The transaction.
 * @param binding - The editor's sync binding.
 * @returns `part` when text is left in the block, `all` when none is, or null for any other transaction.
 */
export function textDeletionInOneText(tr: Transaction, binding: SpaceDeleteBinding): 'part' | 'all' | null {
  if (tr.steps.length === 0 || !tr.steps.every((step) => step instanceof ReplaceStep && step.from < step.to && step.slice.size === 0)) return null;
  const doc = tr.before;
  let block: number | null = null;
  let deleted = 0;
  for (const { from, to } of removedRanges(tr)) {
    const $from = doc.resolve(from);
    if (!$from.parent.isTextblock || doc.resolve(to).parent !== $from.parent) return null;
    if (block !== null && block !== $from.before()) return null;
    block = $from.before();
    let inline = false;
    doc.nodesBetween(from, to, (node) => {
      if (node.isInline && !node.isText) inline = true;
      return !inline;
    });
    if (inline) return null;
    deleted += to - from;
  }
  if (block === null) return null;
  const element = yPath(doc, block, binding)?.at(-1)?.[0];
  if (element === undefined || element.length !== 1 || !(element.get(0) instanceof Y.XmlText)) return null;
  return deleted < doc.nodeAt(block)!.content.size ? 'part' : 'all';
}

/**
 * A node at one depth of a resolved position, as a whole-node target.
 * @param $pos - The position.
 * @param depth - The node's depth (at least 1).
 * @returns The target.
 */
function wholeAt($pos: ResolvedPos, depth: number): Whole {
  return {
    pos: $pos.before(depth),
    node: $pos.node(depth),
    parent: $pos.node(depth - 1),
    parentPos: depth > 1 ? $pos.before(depth - 1) : -1,
    index: $pos.index(depth - 1),
  };
}

/**
 * The block a text block belongs to: its BlockNote container, or itself.
 * @param $pos - A position inside the text block.
 * @returns The block as a target.
 */
function blockOf($pos: ResolvedPos): Whole {
  const up = $pos.depth - 1;
  return wholeAt($pos, up >= 1 && $pos.node(up).type.name === 'blockContainer' ? up : $pos.depth);
}

/**
 * Adds a child of a node as a whole-node target.
 * @param targets - The targets.
 * @param parent - The parent.
 * @param parentPos - Its position.
 * @param index - The child's index.
 * @param offset - The child's offset in the parent.
 */
function addChild(targets: Targets, parent: ProseMirrorNode, parentPos: number, index: number, offset: number): void {
  const pos = parentPos + 1 + offset;
  targets.nodes.set(pos, { pos, node: parent.child(index), parent, parentPos, index });
}

/**
 * Collects the nodes and text a range covers below a node.
 * @param parent - The node.
 * @param parentPos - Its position (-1 for the document).
 * @param range - The range.
 * @param targets - Collected targets, added to.
 */
function walk(parent: ProseMirrorNode, parentPos: number, range: Range, targets: Targets): void {
  parent.forEach((child, offset, index) => {
    const pos = parentPos + 1 + offset;
    const end = pos + child.nodeSize;
    if (end <= range.from || pos >= range.to) return;
    if (child.isText) targets.texts.push({ from: Math.max(range.from, pos), to: Math.min(range.to, end) });
    else if (pos >= range.from && end <= range.to) addChild(targets, parent, parentPos, index, offset);
    else walk(child, pos, range, targets);
  });
}

/**
 * Whether one node lies inside another.
 * @param outer - The outer node.
 * @param inner - The inner one's position.
 * @returns True when strictly inside.
 */
function contains(outer: Whole, inner: number): boolean {
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
  walk(doc, -1, range, targets);
  const { from, to } = range;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if ($from.parent === $to.parent || !$from.parent.isTextblock || !$to.parent.isTextblock) return;
  const start = blockOf($from);
  const finish = blockOf($to);
  /**
   * Whether a block may go whole: no child blocks, and not around the other side.
   * @param block - The block.
   * @param other - The other side's position.
   * @returns True when it may.
   */
  const removable = (block: Whole, other: number): boolean =>
    !(block.node.type.name === 'blockContainer' && block.node.childCount > 1) && !contains(block, other);
  if (to === $to.end() && removable(finish, start.pos)) targets.nodes.set(finish.pos, finish);
  else if (from === $from.start() && removable(start, finish.pos)) targets.nodes.set(start.pos, start);
}

/**
 * Drops targets inside a node going whole, in one sweep over the targets
 * sorted by position.
 * @param targets - The targets, changed in place.
 */
function dropCovered(targets: Targets): void {
  const items: Array<{ from: number; to: number; whole: Whole | null; text: Range | null }> = [
    ...[...targets.nodes.values()].map((whole) => ({ from: whole.pos, to: whole.pos + whole.node.nodeSize, whole, text: null })),
    ...targets.texts.map((text) => ({ ...text, whole: null, text })),
  ].sort((a, b) => a.from - b.from || b.to - a.to);
  let coveredTo = -1;
  const texts: Range[] = [];
  for (const item of items) {
    if (item.from < coveredTo) {
      if (item.whole !== null) targets.nodes.delete(item.from);
      continue;
    }
    if (item.whole !== null) coveredTo = Math.max(coveredTo, item.to);
    if (item.text !== null) texts.push(item.text);
  }
  targets.texts = texts;
}

/**
 * The whole-node targets grouped by their parent's position.
 * @param targets - The targets.
 * @returns Parent position to its children going whole.
 */
function byParent(targets: Targets): Map<number, Whole[]> {
  const groups = new Map<number, Whole[]>();
  for (const whole of targets.nodes.values()) {
    const known = groups.get(whole.parentPos);
    if (known === undefined) groups.set(whole.parentPos, [whole]);
    else known.push(whole);
  }
  return groups;
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
    node.forEach((child, offset, index) => {
      const at = pos + 1 + offset;
      if (child.isText) targets.texts.push({ from: at, to: at + child.nodeSize });
      else addChild(targets, node, pos, index, offset);
    });
    return;
  }
  const kept: ProseMirrorNode[] = [];
  node.forEach((child, offset, index) => {
    const rest: ProseMirrorNode[] = [];
    for (let i = index + 1; i < node.childCount; i += 1) rest.push(node.child(i));
    if (index > 0 && node.type.validContent(Fragment.fromArray([...kept, ...rest]))) {
      addChild(targets, node, pos, index, offset);
      return;
    }
    kept.push(child);
    keepMinimal(child, pos + 1 + offset, targets);
  });
}

/**
 * Step 5's repairs, for each parent losing children: one that would lose a
 * child its schema requires keeps that child, emptied; one that would lose
 * every child keeps one, the first whose content is text when there is one,
 * in its smallest form.
 * @param targets - The targets, changed in place.
 */
function keepRequired(targets: Targets): void {
  // A wrapper of the whole body going whole is the blocks inside it going.
  for (const whole of [...targets.nodes.values()]) {
    if (whole.parentPos !== -1 || whole.node.isTextblock || whole.node.isLeaf) continue;
    targets.nodes.delete(whole.pos);
    whole.node.forEach((_block, offset, index) => addChild(targets, whole.node, whole.pos, index, offset));
  }
  const groups = byParent(targets);
  for (const group of groups.values()) {
    const { parent } = group[0]!;
    const gone = new Set(group.map((whole) => whole.index));
    const left: ProseMirrorNode[] = [];
    parent.forEach((child, _offset, index) => {
      if (!gone.has(index)) left.push(child);
    });
    if (parent.type.validContent(Fragment.fromArray(left))) continue;
    const ordered = group.sort((a, b) => a.index - b.index);
    // A child the schema requires (a block's content beside its children),
    // or, when every child goes, the first whose content is text.
    const keep = left.length > 0
      ? ordered[0]!
      : ordered.find((whole) => whole.node.isTextblock || whole.node.firstChild?.isTextblock === true) ?? ordered[0]!;
    targets.nodes.delete(keep.pos);
    keepMinimal(keep.node, keep.pos, targets);
  }
  dropCovered(targets);
}

/**
 * The deletions as ProseMirror steps: the ranges merged where they touch
 * (touching ranges are siblings), applied from the back.
 * @param doc - The document before the deletion.
 * @param targets - What goes.
 * @returns The transform, or null when the schema refuses a step.
 */
function simulate(doc: ProseMirrorNode, targets: Targets): Transform | null {
  const spans = [
    ...[...targets.nodes.values()].map((whole) => ({ from: whole.pos, to: whole.pos + whole.node.nodeSize })),
    ...targets.texts,
  ].sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last !== undefined && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  const transform = new Transform(doc);
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const { from, to } = merged[i]!;
    if (transform.maybeStep(new ReplaceStep(from, to, Slice.empty)).failed !== null) return null;
  }
  return transform;
}

/**
 * The leaves other than text between two positions, counted by type.
 * @param doc - The document.
 * @param from - Start.
 * @param to - End.
 * @returns Counts by node type name.
 */
function leafCounts(doc: ProseMirrorNode, from: number, to: number): Map<string, number> {
  const counts = new Map<string, number>();
  doc.nodesBetween(from, to, (node) => {
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
  for (let j = 0; j < long.length && i < short.length; j += 1) if (long.charCodeAt(j) === short.charCodeAt(i)) i += 1;
  return i === short.length;
}

/**
 * Whether the executor deletes no more than ProseMirror's own result: its
 * text is a subsequence of the executor's, and no kind of leaf is fewer. Only
 * the stretch either changed is read: outside it both are the document before.
 * @param before - The document before the deletion.
 * @param result - ProseMirror's result.
 * @param simulated - The executor's deletions.
 * @param lo - Start of the executor's stretch in the document before.
 * @param hi - Its end.
 * @returns True when the executor keeps at least as much.
 */
function keepsAsMuch(before: ProseMirrorNode, result: ProseMirrorNode, simulated: Transform, lo: number, hi: number): boolean {
  let from = lo;
  let to = hi;
  let shift = 0;
  const start = before.content.findDiffStart(result.content);
  const end = before.content.findDiffEnd(result.content);
  if (start !== null && end !== null) {
    // The ends can overlap the start where content repeats; ProseMirror's view moves them past it.
    const overlap = Math.max(0, start - Math.min(end.a, end.b));
    from = Math.min(from, start);
    to = Math.max(to, end.a + overlap);
    shift = end.b - end.a;
  }
  const text = isSubsequence(result.textBetween(from, to + shift, ''), simulated.doc.textBetween(simulated.mapping.map(from, -1), simulated.mapping.map(to, 1), ''));
  if (!text) return false;
  const kept = leafCounts(simulated.doc, simulated.mapping.map(from, -1), simulated.mapping.map(to, 1));
  return [...leafCounts(result, from, to + shift)].every(([type, count]) => (kept.get(type) ?? 0) >= count);
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
 * The Y children of a text block's element at their ProseMirror offsets.
 * @param element - The element.
 * @param binding - The binding.
 * @returns Offset to Y child, or null when an inline element is not mapped.
 */
function inlineOffsets(element: YParent, binding: SpaceDeleteBinding): Map<number, YNode> | null {
  const out = new Map<number, YNode>();
  let offset = 0;
  for (const child of element.toArray()) {
    out.set(offset, child as YNode);
    if (child instanceof Y.XmlText) {
      offset += child.length;
      continue;
    }
    const node = binding.mapping.get(child);
    if (!(node instanceof Object) || !('nodeSize' in node)) return null;
    offset += (node as ProseMirrorNode).nodeSize;
  }
  return out;
}

/** What step 6 finds. */
interface Located {
  readonly texts: TextCut[];
  readonly types: TypeCut[];
  readonly paths: Map<YParent, number>;
}

/**
 * Step 6: finds the Y types and text ranges for the targets. Whole nodes are
 * found through their parent's element, by index (or by offset inside a text
 * block); a text range that ends in a later `XmlText` (deleting an inline
 * node leaves neighbours) walks the `XmlText` siblings in between.
 * @param doc - The document before the deletion.
 * @param targets - What goes.
 * @param binding - The binding.
 * @param syncKey - The binding's plugin key.
 * @returns What to write, or null when something cannot be located.
 */
function locate(doc: ProseMirrorNode, targets: Targets, binding: SpaceDeleteBinding, syncKey: PluginKey): Located | null {
  const paths = new Map<YParent, number>();
  const elements = new Map<number, YParent>();
  /**
   * The element of a node with content, its path recorded.
   * @param pos - The node's position, -1 for the root.
   * @returns The element, or null.
   */
  const elementAt = (pos: number): YParent | null => {
    const known = elements.get(pos);
    if (known !== undefined) return known;
    const path = yPath(doc, pos, binding);
    if (path === null) return null;
    for (const [type, at] of path) paths.set(type, at);
    const element = path.at(-1)![0];
    elements.set(pos, element);
    return element;
  };
  const types: TypeCut[] = [];
  const groups = byParent(targets);
  for (const [parentPos, group] of groups) {
    const parent = elementAt(parentPos);
    if (parent === null) return null;
    const textblock = group[0]!.parent.isTextblock;
    const inline = textblock ? inlineOffsets(parent, binding) : null;
    const children = textblock ? null : parent.toArray();
    for (const whole of group) {
      const type = inline !== null ? inline.get(whole.pos - parentPos - 1) : children?.[whole.index];
      if (type === undefined || binding.mapping.get(type) !== whole.node) return null;
      types.push({ parent, index: textblock ? parent.toArray().indexOf(type) : whole.index });
    }
  }
  const cuts = new Map<Y.XmlText, Array<[number, number]>>();
  /**
   * Records a cut in one `XmlText`.
   * @param type - The text.
   * @param a - Start index.
   * @param b - End index.
   */
  const cut = (type: Y.XmlText, a: number, b: number): void => {
    if (b <= a) return;
    const known = cuts.get(type);
    if (known === undefined) cuts.set(type, [[a, b]]);
    else known.push([a, b]);
  };
  for (const { from, to } of targets.texts) {
    if (elementAt(doc.resolve(from).before()) === null) return null;
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
      const parent = type.parent as YParent;
      types.push({ parent, index: parent.toArray().indexOf(type) });
      continue;
    }
    for (const [a, b] of ranges.sort((x, y) => y[0] - x[0])) texts.push({ type, index: a, length: b - a });
  }
  return { texts, types, paths };
}

/**
 * Steps 5 to 7 on collected targets.
 * @param doc - The document before the deletion.
 * @param tr - ProseMirror's own transaction, or null when there is none to compare with.
 * @param targets - What goes.
 * @param binding - The binding.
 * @param options - The planning options.
 * @param at - Where the deletion starts.
 * @returns The plan.
 */
function settle(
  doc: ProseMirrorNode,
  tr: Transaction | null,
  targets: Targets,
  binding: SpaceDeleteBinding,
  options: SpaceDeleteOptions,
  at: number,
): SpaceDeletePlan {
  dropCovered(targets);
  keepRequired(targets);
  if (targets.nodes.size === 0 && targets.texts.length === 0) return { ok: false, refusal: 'compound' };
  const simulated = simulate(doc, targets);
  if (simulated === null) return { ok: false, refusal: 'compound' };
  if (tr !== null) {
    const ends = [
      ...removedRanges(tr),
      ...targets.texts,
      ...[...targets.nodes.values()].map((whole) => ({ from: whole.pos, to: whole.pos + whole.node.nodeSize })),
    ];
    const lo = ends.reduce((min, range) => Math.min(min, range.from), Infinity);
    const hi = ends.reduce((max, range) => Math.max(max, range.to), -Infinity);
    if (!keepsAsMuch(doc, tr.doc, simulated, lo, hi)) return { ok: false, refusal: 'compound' };
  }
  const located = locate(doc, targets, binding, options.syncKey);
  if (located === null) return { ok: false, refusal: 'add' };
  if (options.overCeiling && located.texts.length > 0) return { ok: false, refusal: 'over_ceiling' };
  return {
    ok: true,
    kind: located.texts.length > 0 ? 'delete' : 'remove',
    ...located,
    steps: simulated.steps as ReplaceStep[],
    at,
  };
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
  return settle(tr.before, tr, targets, binding, options, Math.min(...ranges.map((range) => range.from)));
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
  const $pos = doc.resolve(pos);
  if ($pos.nodeAfter === null) return { ok: false, refusal: 'compound' };
  const whole: Whole = {
    pos,
    node: $pos.nodeAfter,
    parent: $pos.parent,
    parentPos: $pos.depth > 0 ? $pos.before() : -1,
    index: $pos.index(),
  };
  return settle(doc, null, { nodes: new Map([[pos, whole]]), texts: [] }, binding, options, pos);
}

/**
 * Deletes whole types, grouped by parent, each run of neighbours in one call,
 * from the back so earlier indices hold.
 * @param types - The types, at their indices.
 */
function deleteTypes(types: readonly TypeCut[]): void {
  const groups = new Map<YParent, number[]>();
  for (const { parent, index } of types) {
    const known = groups.get(parent);
    if (known === undefined) groups.set(parent, [index]);
    else known.push(index);
  }
  for (const [parent, indices] of groups) {
    const sorted = [...new Set(indices)].sort((a, b) => b - a);
    let i = 0;
    while (i < sorted.length) {
      let first = sorted[i]!;
      const last = first;
      while (i + 1 < sorted.length && sorted[i + 1] === first - 1) {
        i += 1;
        first = sorted[i]!;
      }
      parent.delete(first, last - first + 1);
      i += 1;
    }
  }
}

/**
 * Step 8: writes an accepted plan through `writeSpaceDoc` and brings the
 * editor along. The Yjs write (origin the sync key the editor's undo manager
 * tracks: text ranges, then whole types) runs inside the binding's mutex, so the sync plugin does not
 * redraw the whole document from Yjs; one sync-keyed transaction then makes
 * the same deletions in the editor, the binding's mapping is kept as the
 * redraw would keep it, and the caret goes to where the deletion started.
 * @param name - The Space document's name.
 * @param view - The editor, still on the document the plan was made on.
 * @param binding - Its sync binding.
 * @param plan - An accepted plan.
 * @param syncKey - The sync plugin key.
 * @param addToHistory - Whether the deletion goes on the undo stack.
 */
export function applySpaceDelete(
  name: string,
  view: EditorView,
  binding: SpaceDeleteWriteBinding,
  plan: Extract<SpaceDeletePlan, { ok: true }>,
  syncKey: PluginKey,
  addToHistory: boolean,
): void {
  writeSpaceDoc(name, { kind: plan.kind }, () => binding.mux(() => {
    binding.doc.transact((ytr) => {
      ytr.meta.set('addToHistory', addToHistory);
      ytr.meta.set(SPACE_DELETE_META, true);
      for (const { type, index, length } of plan.texts) type.delete(index, length);
      deleteTypes(plan.types);
      Y.iterateDeletedStructs(ytr, ytr.deleteSet, (struct) => {
        if (struct instanceof Y.Item && struct.content instanceof Y.ContentType) binding.mapping.delete(struct.content.type);
      });
    }, syncKey);
    const tr = view.state.tr;
    for (const step of plan.steps) tr.step(step);
    for (const [type, pos] of plan.paths) {
      const node = pos < 0 ? tr.doc : tr.doc.nodeAt(tr.mapping.map(pos, 1));
      if (node === null) {
        binding.mapping.delete(type);
        continue;
      }
      binding.mapping.set(type, node);
      // A text block's text nodes are rendered afresh, as the redraw does.
      if (node.isTextblock) for (const child of (type as YParent).toArray()) if (child instanceof Y.XmlText) binding.mapping.delete(child);
    }
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(plan.at, -1)), -1));
    view.dispatch(tr.setMeta(syncKey, { isChangeOrigin: true }).setMeta('addToHistory', false));
  }));
}
