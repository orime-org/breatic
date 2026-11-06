// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The size cap at the ProseMirror editors bound to a Space document
 * (inner#1790): the transaction filter every editor carries, and
 * the gate their undo and redo commands go through.
 *
 * A transaction is as strong as its strongest step: `add`, then `overwrite`,
 * then `delete`. y-prosemirror writes a replaced range or a changed block
 * type as a delete of the old content plus the new content, which collab
 * admits up to the hard ceiling like any write that deletes live content.
 *
 * The editors write Yjs from their sync plugin, after a transaction has been
 * applied, so the judgement is made on the transaction itself: a local
 * transaction is refused before it reaches the state, and the sync plugin then
 * has nothing to write. A transaction carrying the editor's own sync key meta
 * came from Yjs (a peer, an undo, the binding) or writes nothing to it, and is
 * always let through. Each editor passes its own key: the document body is on
 * y-prosemirror, the canvas editors on y-tiptap, and the two keys are
 * different objects.
 *
 * The replace steps of a transaction are weighed together, so a move or a
 * rewrite counts what it puts in against what it takes out:
 *
 * | steps | kind and estimate |
 * |---|---|
 * | replaces that take out live content and put in no more text and no larger estimate | `overwrite` |
 * | a `ReplaceAroundStep` whose slice holds no text (the block around kept content changes) | `overwrite` |
 * | any other replace that puts something in | `add`, the larger of the estimate and the text it adds net |
 * | `AddMarkStep` | `add`, per text node 32 bytes plus the mark's name and attributes |
 * | `AddNodeMarkStep`, `AttrStep`, any other step | `add`, 32 bytes |
 * | `ReplaceStep` or `ReplaceAroundStep` without a slice, `RemoveMarkStep`, `RemoveNodeMarkStep` | `delete` |
 *
 * Over the hard ceiling a delete must free something: it removes a whole
 * block, or it removes at least `SPACE_DELETE_MIN_BYTES` of text without
 * joining two blocks (a join rewrites the joined text). Anything less is
 * refused as an overwrite, with its own sentence.
 */

import type { Command } from '@tiptap/pm/state';
import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import {
  AddMarkStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
} from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import * as Y from 'yjs';

import { SPACE_DELETE_MIN_BYTES, t } from '@breatic/shared';
import { readDocSize } from '@web/data/yjs/doc-size';
import { nextHistoryStep } from '@web/data/yjs/history-step';
import {
  estimateSliceBytes,
  utf8Bytes,
  writeSpaceDoc,
  type SpaceRefusal,
  type SpaceReservation,
  type SpaceWriteKind,
} from '@web/data/yjs/space-write';
import { toast } from '@web/lib/toast';

/** Bytes counted for each text node a mark or attribute change touches. */
const MARK_BYTES = 32;

/**
 * The meta a transaction carries when its room was reserved before it was
 * built (an upload, an Agent proposal), or when its caller reports a refusal
 * itself.
 */
export const SPACE_WRITE_META = 'spaceWrite';

/** What {@link SPACE_WRITE_META} carries. */
export interface SpaceWriteMeta {
  /** Room reserved for this write; the write consumes it. */
  readonly reservation?: SpaceReservation;
  /** Show the refusal toast (default true). */
  readonly notify?: boolean;
}

/** Why each refused transaction was refused, for the caller that dispatched it. */
const refusals = new WeakMap<Transaction, SpaceRefusal>();

/**
 * Why the filter refused a transaction.
 * @param tr - A dispatched transaction.
 * @returns The refusal, or undefined when it was not refused.
 */
export function refusalOf(tr: Transaction): SpaceRefusal | undefined {
  return refusals.get(tr);
}

/** What a transaction does to its document's size. */
interface Judged {
  /** A step adds, or the replaces put in more than they take out. */
  adds: boolean;
  /** The replaces take out live content and put in no more. */
  overwrites: boolean;
  /** Bytes the adds in it can grow the document by. */
  estimate: number;
  /** UTF-8 bytes of the text its empty-slice deletes remove. */
  deletedBytes: number;
  /** A delete removes a whole block. */
  removesBlock: boolean;
  /** A delete joins two blocks, or unwraps what it keeps. */
  joins: boolean;
}

/** What the replace steps of one transaction put in and take out, summed. */
interface ReplaceTotals {
  /** Estimate of the slices put in. */
  added: number;
  /** UTF-8 bytes of the text put in. */
  addedText: number;
  /** Estimate of the ranges taken out. */
  removed: number;
  /** UTF-8 bytes of the text taken out. */
  removedText: number;
  /** Some step takes out live content or changes the block around kept content. */
  removesLive: boolean;
  /** Some step puts something in. */
  puts: boolean;
  /** Some step changes only the block around kept content. */
  wraps: boolean;
}

/**
 * What one empty-slice replace removes from the document before it.
 * @param doc - The document the step applies to.
 * @param from - Start of the removed range.
 * @param to - End of the removed range.
 * @returns The removed text's bytes, whether a whole block goes, whether it joins blocks.
 */
function removal(doc: ProseMirrorNode, from: number, to: number): { bytes: number; block: boolean; join: boolean } {
  let block = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isBlock && pos >= from && pos + node.nodeSize <= to) block = true;
    return !block;
  });
  return {
    bytes: utf8Bytes(doc.textBetween(from, to)),
    block,
    join: !doc.resolve(from).sameParent(doc.resolve(to)),
  };
}

/**
 * Text nodes in a range.
 * @param doc - The document.
 * @param from - Start.
 * @param to - End.
 * @returns How many, at least one.
 */
function textNodesIn(doc: ProseMirrorNode, from: number, to: number): number {
  let count = 0;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) count += 1;
    return true;
  });
  return Math.max(1, count);
}

/**
 * What one mark costs on each text node it lands on: y-prosemirror writes
 * its attributes as the format value.
 * @param mark - The mark.
 * @returns Bytes.
 */
function markCost(mark: Mark): number {
  return MARK_BYTES + utf8Bytes(mark.type.name) + utf8Bytes(JSON.stringify(mark.attrs));
}

/**
 * What marking ranges adds, as the filter judges the marks.
 * @param doc - The document.
 * @param ranges - The ranges.
 * @param mark - The mark.
 * @returns Bytes.
 */
export function markBytes(doc: ProseMirrorNode, ranges: ReadonlyArray<{ from: number; to: number }>, mark: Mark): number {
  return ranges.reduce((sum, { from, to }) => sum + markCost(mark) * textNodesIn(doc, from, to), 0);
}

/**
 * Add a range a replace takes out to the totals.
 * @param doc - The document before the step.
 * @param from - Start.
 * @param to - End.
 * @param totals - The running totals, updated in place.
 */
function takeOut(doc: ProseMirrorNode, from: number, to: number, totals: ReplaceTotals): void {
  if (to <= from) return;
  totals.removed += estimateSliceBytes(doc.slice(from, to));
  totals.removedText += utf8Bytes(doc.textBetween(from, to));
  totals.removesLive = true;
}

/**
 * Judge one step against the document it applies to.
 * @param step - The step.
 * @param doc - The document before it.
 * @param judged - The running judgement, updated in place.
 * @param totals - The running replace totals, updated in place.
 */
function judgeStep(step: Step, doc: ProseMirrorNode, judged: Judged, totals: ReplaceTotals): void {
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
    const text = step.slice.content.textBetween(0, step.slice.content.size);
    if (step instanceof ReplaceAroundStep && step.slice.size > 0 && text === '') {
      // Only the block around kept content changes; y-prosemirror rewrites
      // the block, which collab admits like any write deleting live content.
      totals.removesLive = true;
      totals.wraps = true;
      return;
    }
    if (step.slice.size > 0) {
      totals.added += estimateSliceBytes(step.slice);
      totals.addedText += utf8Bytes(text);
      totals.puts = true;
      if (step instanceof ReplaceAroundStep) {
        takeOut(doc, step.from, step.gapFrom, totals);
        takeOut(doc, step.gapTo, step.to, totals);
      } else {
        takeOut(doc, step.from, step.to, totals);
      }
      return;
    }
    takeOut(doc, step.from, step.to, totals);
    const removed = removal(doc, step.from, step.to);
    judged.deletedBytes += removed.bytes;
    judged.removesBlock ||= removed.block;
    judged.joins ||= removed.join || step instanceof ReplaceAroundStep;
    return;
  }
  if (step instanceof RemoveMarkStep || step instanceof RemoveNodeMarkStep) return;
  judged.adds = true;
  judged.estimate += step instanceof AddMarkStep ? markCost(step.mark) * textNodesIn(doc, step.from, step.to) : MARK_BYTES;
}

/**
 * Judge a transaction: its marks and attributes step by step, its replaces
 * together, so a move or a rewrite is weighed by what it puts in against
 * what it takes out.
 * @param tr - The transaction.
 * @returns What it does to the size.
 */
function judge(tr: Transaction): Judged & { kind: SpaceWriteKind } {
  const judged: Judged = { adds: false, overwrites: false, estimate: 0, deletedBytes: 0, removesBlock: false, joins: false };
  const totals: ReplaceTotals = { added: 0, addedText: 0, removed: 0, removedText: 0, removesLive: false, puts: false, wraps: false };
  tr.steps.forEach((step, k) => {
    judgeStep(step, tr.docs[k]!, judged, totals);
  });
  if (totals.puts) {
    if (totals.removesLive && totals.addedText <= totals.removedText && totals.added <= totals.removed) {
      judged.overwrites = true;
    } else {
      judged.adds = true;
      judged.estimate += Math.max(totals.added - totals.removed, totals.addedText - totals.removedText, 0);
    }
  } else if (totals.wraps) {
    judged.overwrites = true;
  }
  return { ...judged, kind: judged.adds ? 'add' : judged.overwrites ? 'overwrite' : 'delete' };
}

/**
 * Whether a transaction only adds and removes marks of the given types.
 * @param tr - The transaction.
 * @param marks - Mark type names.
 * @returns True when every step is such a mark step.
 */
function onlyMarks(tr: Transaction, marks: readonly string[]): boolean {
  return marks.length > 0 && tr.steps.every((step) =>
    (step instanceof AddMarkStep || step instanceof RemoveMarkStep) && marks.includes(step.mark.type.name));
}

/**
 * Throws away what the browser wrote into the DOM during a refused
 * composition and redraws it from the state, which never took it.
 *
 * `docView.markDirty` is internal to prosemirror-view: without it
 * `updateState` with an unchanged document finds nothing to do and leaves the
 * composed characters on screen.
 * @param view - The editor view.
 */
function redrawFromState(view: EditorView): void {
  const { docView } = view as unknown as { docView: { markDirty: (from: number, to: number) => void } };
  docView.markDirty(0, view.state.doc.content.size);
  view.updateState(view.state);
}

/** What an editor tells the filter about itself. */
export interface SpaceSizeFilterOptions {
  /** The editor's own sync plugin key; its meta marks a transaction from Yjs. */
  readonly syncKey: PluginKey;
  /** The Space document's canonical name, or null when it is not a registered document. */
  readonly docName: () => string | null;
  /**
   * Marks the editor's own extensions keep in step with other Yjs data (the
   * comment mark, which BlockNote rewrites from the thread map): a
   * transaction made only of them, with no {@link SPACE_WRITE_META}, rewrites
   * existing marks and is judged an overwrite without a toast.
   */
  readonly derivedMarks?: readonly string[];
}

/**
 * The filter for one editor. Build one per editor: it keeps that editor's
 * view, for redrawing after a refused composition.
 * @param options - The editor's sync key and document name.
 * @returns The ProseMirror plugin.
 */
export function spaceSizeFilterPlugin(options: SpaceSizeFilterOptions): Plugin {
  let view: EditorView | null = null;
  /** A composition was refused and its characters are still on screen. */
  let refusedComposition = false;
  return new Plugin({
    key: new PluginKey('spaceSizeFilter'),
    filterTransaction: (tr): boolean => {
      // Appended transactions follow a root that was already judged (BlockNote
      // stamps ids on new blocks); refusing one would leave the root half done.
      if (!tr.docChanged || tr.getMeta(options.syncKey) !== undefined || tr.getMeta('appendedTransaction') !== undefined) return true;
      const name = options.docName();
      if (name === null) return true;
      const meta = tr.getMeta(SPACE_WRITE_META) as SpaceWriteMeta | undefined;
      const composing = view?.composing === true || tr.getMeta('composition') !== undefined;
      const derived = meta === undefined && onlyMarks(tr, options.derivedMarks ?? []);
      // A machine edit (`addToHistory: false`) is not something the reader did.
      const notify = (meta?.notify ?? true) && !derived && !(composing && refusedComposition) && tr.getMeta('addToHistory') !== false;
      const judged = derived ? { ...judge(tr), kind: 'overwrite' as const } : judge(tr);
      let refusal: SpaceRefusal | null = null;
      if (judged.kind === 'delete' && readDocSize(name).overCeiling && !judged.removesBlock
        && (judged.joins || judged.deletedBytes < SPACE_DELETE_MIN_BYTES)) {
        refusal = { ok: false, reason: 'full' };
        if (notify && readDocSize(name).phase !== 'resyncing') toast.warning(t('spaces.size.overCeilingDelete'));
      } else {
        const result = writeSpaceDoc(name, {
          kind: judged.kind,
          ...(judged.kind === 'add' && { estimate: judged.estimate }),
          ...(meta?.reservation !== undefined && { reservation: meta.reservation }),
          notify,
          landsLater: true,
        }, () => undefined);
        if (!result.ok) refusal = result;
      }
      if (refusal === null) return true;
      refusals.set(tr, refusal);
      if (composing) refusedComposition = true;
      return false;
    },
    view: (editorView) => {
      view = editorView;
      /** Redraws once the last composition has ended, if one was refused. */
      const onEnd = (): void => {
        // After ProseMirror's own handler has run for this event.
        setTimeout(() => {
          if (!refusedComposition || editorView.isDestroyed || editorView.composing) return;
          refusedComposition = false;
          redrawFromState(editorView);
        }, 0);
      };
      editorView.dom.addEventListener('compositionend', onEnd);
      return {
        destroy: (): void => {
          editorView.dom.removeEventListener('compositionend', onEnd);
          view = null;
        },
      };
    },
  });
}

/**
 * Runs an undo or redo if the Space's size allows what it restores.
 * @param name - The Space document's name, or null for an unregistered one.
 * @param manager - The undo manager the step comes from.
 * @param direction - Which stack.
 * @param run - The step itself.
 * @returns What `run` returned, or true when the step was refused (the press is handled).
 * @throws {Error} Whatever `run` throws.
 */
export function gatedHistoryStep(
  name: string | null,
  manager: Y.UndoManager,
  direction: 'undo' | 'redo',
  run: () => boolean,
): boolean {
  const stack = direction === 'undo' ? manager.undoStack : manager.redoStack;
  if (name === null || stack.length === 0) return run();
  let ran = false;
  const result = writeSpaceDoc(name, nextHistoryStep(manager, direction), () => {
    ran = run();
  });
  return result.ok ? ran : true;
}

/**
 * A ProseMirror undo or redo command behind the size gate.
 * @param name - Reads the Space document's name.
 * @param manager - The undo manager the command drives.
 * @param direction - Which stack.
 * @param command - The command.
 * @returns The gated command; a dry run (no dispatch) asks the command itself.
 */
export function gatedHistoryCommand(
  name: () => string | null,
  manager: Y.UndoManager,
  direction: 'undo' | 'redo',
  command: Command,
): Command {
  return (state, dispatch, view) => {
    if (dispatch === undefined) return command(state, dispatch, view);
    return gatedHistoryStep(name(), manager, direction, () => command(state, dispatch, view));
  };
}
