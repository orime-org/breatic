// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The size cap at the ProseMirror editors bound to a Space document
 * (inner#1790, design 5.2): the transaction filter every editor carries, and
 * the gate their undo and redo commands go through.
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
 * | step | kind and estimate |
 * |---|---|
 * | `ReplaceStep`, `ReplaceAroundStep` with a slice | `add`, `estimateSliceBytes` of the slice |
 * | `AddMarkStep` | `add`, 32 bytes per text node it touches |
 * | `AddNodeMarkStep`, `AttrStep`, any other step | `add`, 32 bytes |
 * | `ReplaceStep` or `ReplaceAroundStep` without a slice, `RemoveMarkStep`, `RemoveNodeMarkStep` | `delete` |
 *
 * Over the hard ceiling a delete must free something: it removes a whole
 * block, or it removes at least `SPACE_DELETE_MIN_BYTES` of text without
 * joining two blocks (a join rewrites the joined text). Anything less is
 * refused as an overwrite, with its own sentence.
 */

import type { Command } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
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
import {
  estimateSliceBytes,
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
  kind: SpaceWriteKind;
  /** Bytes the adds in it can grow the document by. */
  estimate: number;
  /** UTF-8 bytes of the text its deletes remove. */
  deletedBytes: number;
  /** A delete removes a whole block. */
  removesBlock: boolean;
  /** A delete joins two blocks, or rewrites what it keeps. */
  rewrites: boolean;
}

/**
 * UTF-8 bytes of a string.
 * @param text - The string.
 * @returns Its encoded length.
 */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
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
 * Judge one step against the document it applies to.
 * @param step - The step.
 * @param doc - The document before it.
 * @param judged - The running judgement, updated in place.
 */
function judgeStep(step: Step, doc: ProseMirrorNode, judged: Judged): void {
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
    if (step.slice.size > 0) {
      judged.kind = 'add';
      judged.estimate += estimateSliceBytes(step.slice);
      return;
    }
    const removed = removal(doc, step.from, step.to);
    judged.deletedBytes += removed.bytes;
    judged.removesBlock ||= removed.block;
    judged.rewrites ||= removed.join || step instanceof ReplaceAroundStep;
    return;
  }
  if (step instanceof RemoveMarkStep || step instanceof RemoveNodeMarkStep) return;
  judged.kind = 'add';
  judged.estimate += step instanceof AddMarkStep ? MARK_BYTES * textNodesIn(doc, step.from, step.to) : MARK_BYTES;
}

/**
 * Judge a transaction's steps.
 * @param tr - The transaction.
 * @returns What it does to the size.
 */
function judge(tr: Transaction): Judged {
  const judged: Judged = { kind: 'delete', estimate: 0, deletedBytes: 0, removesBlock: false, rewrites: false };
  tr.steps.forEach((step, k) => {
    judgeStep(step, tr.docs[k]!, judged);
  });
  return judged;
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
export function redrawFromState(view: EditorView): void {
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
      // A machine edit (`addToHistory: false`) is not something the reader did.
      const notify = (meta?.notify ?? true) && !(composing && refusedComposition) && tr.getMeta('addToHistory') !== false;
      const judged = judge(tr);
      let refusal: SpaceRefusal | null = null;
      if (judged.kind === 'delete' && readDocSize(name).overCeiling && !judged.removesBlock
        && (judged.rewrites || judged.deletedBytes < SPACE_DELETE_MIN_BYTES)) {
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
 * Whether every struct a delete set covers is the value of a map key that
 * still has a value, so restoring them only replaces values.
 * @param doc - The document.
 * @param deletions - The delete set.
 * @returns True when all of them are such values.
 */
function onlyKeyValues(doc: Y.Doc, deletions: ReturnType<typeof Y.createDeleteSet>): boolean {
  for (const [client, ranges] of deletions.clients) {
    const structs = doc.store.clients.get(client);
    if (structs === undefined) continue;
    for (const { clock, len } of ranges) {
      for (let k = Y.findIndexSS(structs, clock); k < structs.length && structs[k]!.id.clock < clock + len; k += 1) {
        const struct = structs[k];
        if (!(struct instanceof Y.Item)) continue;
        const key = struct.parentSub;
        const parent = struct.parent as Y.AbstractType<unknown> | null;
        const current = key === null || parent === null ? undefined : parent._map.get(key);
        if (current === undefined || current.deleted) return false;
      }
    }
  }
  return true;
}

/**
 * What undoing or redoing the next stack item does to the size: an item
 * that restores nothing only deletes, one that restores only values of keys
 * that still have one overwrites, anything else adds.
 * @param manager - The undo manager.
 * @param direction - Which stack.
 * @returns The kind, or null when the stack is empty.
 */
export function historyStepKind(manager: Y.UndoManager, direction: 'undo' | 'redo'): SpaceWriteKind | null {
  const item = (direction === 'undo' ? manager.undoStack : manager.redoStack).at(-1);
  if (item === undefined) return null;
  if ([...item.deletions.clients.values()].every((ranges) => ranges.length === 0)) return 'delete';
  return onlyKeyValues(manager.doc, item.deletions) ? 'overwrite' : 'add';
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
  const kind = name === null ? null : historyStepKind(manager, direction);
  if (name === null || kind === null) return run();
  let ran = false;
  const result = writeSpaceDoc(name, { kind }, () => {
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
