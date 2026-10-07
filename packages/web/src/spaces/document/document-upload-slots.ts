// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Uploads in flight in a document body, and where each one's block will land
 * (inner#1127 A2, A4, A6).
 *
 * A file being uploaded has no block yet: its placeholder lives in this
 * plugin's state and is drawn as a widget decoration, so only the uploader
 * sees it and nothing about it reaches Yjs or the undo stack. When the upload
 * finishes, its block is inserted where the placeholder was drawn.
 *
 * Positions are never mapped. A change arriving from Yjs — a co-editor's edit,
 * or this client's own undo — reaches ProseMirror as one transaction that
 * replaces the whole body, and mapping through it pushes every position to the
 * end (`document-comment-draft-range.ts`). So a batch remembers block ids, and
 * {@link resolveSlotPosition} finds the place again in whatever the document
 * is now. The placeholder and the insert both ask it, so a placeholder drawn
 * in one place and a block landing in another cannot happen.
 */

import { blockToNode, createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { watchPluginState } from '@web/spaces/document/document-plugin-watch';
import { rowById } from '@web/spaces/document/document-row-by-id';

/** Where a batch was dropped: the blocks on either side of the gap. */
export interface SlotAnchor {
  /** The block before the gap; null at the head of the document. */
  readonly before: string | null;
  /** The block after the gap; null at the end of the document. */
  readonly after: string | null;
}

/** Why a slot stopped, as the placeholder shows it. */
export interface SlotFailure {
  /** The message key the placeholder shows beside the file name. */
  readonly messageKey: string;
  /** The values the message is filled with. */
  readonly params: Readonly<Record<string, string>>;
  /** Whether sending the same file again can end differently. */
  readonly retryable: boolean;
}

/** One file of a batch. */
export interface UploadSlot {
  readonly id: string;
  /** The file's name, which the placeholder shows. */
  readonly name: string;
  readonly phase: 'uploading' | 'failed' | 'inserted';
  /** The share that has landed, from 0 to 1; null before the first part lands. */
  readonly progress: number | null;
  /** Set while the slot is failed. */
  readonly failure: SlotFailure | null;
  /** The block it became, once inserted. */
  readonly blockId: string | null;
}

/** One pick, drop or paste: its files, in the order they came in. */
export interface UploadBatch extends SlotAnchor {
  readonly slots: readonly UploadSlot[];
}

/** The plugin's state. */
interface UploadsState {
  readonly batches: readonly UploadBatch[];
  readonly decorations: DecorationSet;
}

/** What a transaction asks the plugin to do. */
type UploadsAction =
  | { readonly kind: 'add'; readonly batch: UploadBatch }
  | {
      readonly kind: 'patch';
      readonly slotId: string;
      readonly patch: Partial<Pick<UploadSlot, 'phase' | 'progress' | 'failure'>>;
    }
  | { readonly kind: 'remove'; readonly slotId: string }
  | { readonly kind: 'inserted'; readonly slotId: string; readonly blockId: string };

/** A block to insert, as BlockNote takes it. */
export interface SlotBlock {
  readonly type: string;
  readonly props: Record<string, unknown>;
}

/** What closes an undo step around an insert. */
export interface UndoCapture {
  stopCapturing(): void;
}

/** The plugin's key; its state is read through the functions below. */
export const documentUploadsKey = new PluginKey<UploadsState>('documentUploads');

/** The attribute a placeholder's container carries, naming its slot. */
export const UPLOAD_SLOT_ATTRIBUTE = 'data-upload-slot';

/**
 * Where a container starting at the given block sits, if the document holds it.
 * @param doc - The document now.
 * @param id - The block's id.
 * @returns Its start and end, or undefined.
 */
function rangeOf(doc: PMNode, id: string | null): { from: number; to: number } | undefined {
  return id === null ? undefined : rowById(doc, id);
}

/**
 * Where the k-th file of a batch goes in the document as it is now.
 *
 * In order: before the nearest later file of the batch already inserted; after
 * the nearest earlier one; before `after`; after `before`; the end of the
 * document. Every file therefore keeps the order it came in, whichever
 * finishes first. `after` is asked before `before` because the gap a reader
 * picks under a row with children is before that row's first child, and only
 * `after` names that level.
 * @param batch - The batch.
 * @param k - The file's index in it.
 * @param doc - The document now.
 * @returns A position between two blocks.
 */
export function resolveSlotPosition(batch: UploadBatch, k: number, doc: PMNode): number {
  for (let later = k + 1; later < batch.slots.length; later += 1) {
    const range = rangeOf(doc, batch.slots[later]!.blockId);
    if (range !== undefined) return range.from;
  }
  for (let earlier = k - 1; earlier >= 0; earlier -= 1) {
    const range = rangeOf(doc, batch.slots[earlier]!.blockId);
    if (range !== undefined) return range.to;
  }
  const after = rangeOf(doc, batch.after);
  if (after !== undefined) return after.from;
  const before = rangeOf(doc, batch.before);
  if (before !== undefined) return before.to;
  // The end of the top-level block group, which is the document's only child.
  return doc.content.size - 1;
}

/**
 * Every slot still waiting for a block, with where it is drawn.
 * @param state - The editor state.
 * @returns Slot id to position.
 */
export function slotPositions(state: EditorState): Map<string, number> {
  const positions = new Map<string, number>();
  for (const batch of documentUploadsKey.getState(state)?.batches ?? []) {
    batch.slots.forEach((slot, k) => {
      if (slot.phase !== 'inserted') {
        positions.set(slot.id, resolveSlotPosition(batch, k, state.doc));
      }
    });
  }
  return positions;
}

/**
 * Every slot still waiting for a block, in batch order.
 * @param state - The editor state.
 * @returns The slots.
 */
export function uploadSlots(state: EditorState): UploadSlot[] {
  return waitingSlots(uploadBatchesIn(state));
}

/**
 * Every slot of these batches still waiting for a block, in batch order.
 * @param batches - The batches.
 * @returns The slots.
 */
export function waitingSlots(batches: readonly UploadBatch[]): UploadSlot[] {
  return batches.flatMap((batch) => batch.slots.filter((slot) => slot.phase !== 'inserted'));
}

/**
 * The placeholders' widgets, one per waiting slot.
 * @param batches - The batches.
 * @param doc - The document now.
 * @returns The decorations.
 */
function decorate(batches: readonly UploadBatch[], doc: PMNode): DecorationSet {
  const widgets: Decoration[] = [];
  for (const batch of batches) {
    batch.slots.forEach((slot, k) => {
      if (slot.phase === 'inserted') return;
      widgets.push(
        Decoration.widget(
          resolveSlotPosition(batch, k, doc),
          () => {
            const holder = document.createElement('div');
            holder.setAttribute(UPLOAD_SLOT_ATTRIBUTE, slot.id);
            holder.contentEditable = 'false';
            return holder;
          },
          // Keyed by slot so the container, and what the page renders into
          // it, survives every redraw. Sides in batch order keep files that
          // share a position in the order they came in.
          { key: slot.id, side: k - batch.slots.length },
        ),
      );
    });
  }
  return DecorationSet.create(doc, widgets);
}

/**
 * The batches after one action.
 * @param batches - The batches before.
 * @param action - What was asked.
 * @returns The batches after; a batch with nothing left waiting is dropped.
 */
function reduce(batches: readonly UploadBatch[], action: UploadsAction): UploadBatch[] {
  if (action.kind === 'add') return [...batches, action.batch];
  return batches
    .map((batch) => ({
      ...batch,
      slots: batch.slots.flatMap((slot): UploadSlot[] => {
        if (slot.id !== action.slotId) return [slot];
        if (action.kind === 'remove') return [];
        if (action.kind === 'inserted') {
          return [{ ...slot, phase: 'inserted', blockId: action.blockId, failure: null }];
        }
        return [{ ...slot, ...action.patch }];
      }),
    }))
    .filter((batch) => batch.slots.some((slot) => slot.phase !== 'inserted'));
}

/**
 * The batches as the state holds them; the same array until one changes,
 * which is what lets a store snapshot be taken off it directly.
 * @param state - The editor state.
 * @returns The batches.
 */
export function uploadBatchesIn(state: EditorState): readonly UploadBatch[] {
  return documentUploadsKey.getState(state)?.batches ?? NO_BATCHES;
}

/** No uploads in flight, as one array. */
const NO_BATCHES: readonly UploadBatch[] = [];

const watch = watchPluginState(uploadBatchesIn);

/** Hears about every change to the uploads in flight. */
export const onUploadSlotsChange: (listener: () => void) => () => void = watch.onChange;

/**
 * The plugin.
 * @returns A fresh plugin.
 */
function uploadsPlugin(): Plugin<UploadsState> {
  return new Plugin<UploadsState>({
    key: documentUploadsKey,
    state: {
      init: () => ({ batches: [], decorations: DecorationSet.empty }),
      apply: (tr, previous, _old, state) => {
        const action = tr.getMeta(documentUploadsKey) as UploadsAction | undefined;
        if (action === undefined && !tr.docChanged) return previous;
        const batches =
          action === undefined ? previous.batches : reduce(previous.batches, action);
        return { batches, decorations: decorate(batches, state.doc) };
      },
    },
    props: {
      decorations: (state) => documentUploadsKey.getState(state)?.decorations,
    },
    view: watch.view,
  });
}

/**
 * The extension that carries the plugin.
 * @returns The extension, for the assembly to register.
 */
export const documentUploadsExtension = createExtension(() => ({
  key: 'document-uploads',
  prosemirrorPlugins: [uploadsPlugin()],
}) as never);

/**
 * Dispatches one action.
 * @param view - The editor view.
 * @param action - What to do.
 */
function send(view: EditorView, action: UploadsAction): void {
  view.dispatch(view.state.tr.setMeta(documentUploadsKey, action).setMeta('addToHistory', false));
}

/**
 * Starts a batch: one placeholder per file, all at one gap.
 * @param view - The editor view.
 * @param anchor - The gap.
 * @param names - The files' names, in the order they came in.
 * @returns The slots' ids, in the same order.
 */
export function addUploadBatch(
  view: EditorView,
  anchor: SlotAnchor,
  names: readonly string[],
): string[] {
  const slots = names.map((name) => ({
    id: crypto.randomUUID(),
    name,
    phase: 'uploading' as const,
    progress: null,
    failure: null,
    blockId: null,
  }));
  send(view, { kind: 'add', batch: { ...anchor, slots } });
  return slots.map((slot) => slot.id);
}

/**
 * Changes what one slot shows.
 * @param view - The editor view.
 * @param slotId - Which slot.
 * @param patch - The fields that change.
 */
export function patchUploadSlot(
  view: EditorView,
  slotId: string,
  patch: Partial<Pick<UploadSlot, 'phase' | 'progress' | 'failure'>>,
): void {
  send(view, { kind: 'patch', slotId, patch });
}

/**
 * Takes one slot away without a block.
 * @param view - The editor view.
 * @param slotId - Which slot.
 */
export function removeUploadSlot(view: EditorView, slotId: string): void {
  send(view, { kind: 'remove', slotId });
}

/**
 * Inserts the block a slot became, where its placeholder is drawn.
 *
 * One transaction, kept apart from the reader's typing on either side so that
 * one undo takes exactly the block back. The selection is mapped through the
 * insert and nothing else: the reader may be typing anywhere.
 * @param view - The editor view.
 * @param slotId - Which slot.
 * @param block - The block, as BlockNote takes it.
 * @param undo - The undo manager whose capture is closed around the insert.
 * @returns The new block's id, or null when the slot is no longer waiting.
 */
export function insertSlotBlock(
  view: EditorView,
  slotId: string,
  block: SlotBlock,
  undo?: UndoCapture,
): string | null {
  const batches = documentUploadsKey.getState(view.state)?.batches ?? [];
  for (const batch of batches) {
    const k = batch.slots.findIndex((slot) => slot.id === slotId);
    if (k < 0 || batch.slots[k]!.phase !== 'uploading') continue;
    const blockId = crypto.randomUUID();
    const node = blockToNode({ ...block, id: blockId } as never, view.state.schema);
    undo?.stopCapturing();
    view.dispatch(
      view.state.tr
        .insert(resolveSlotPosition(batch, k, view.state.doc), node)
        .setMeta(documentUploadsKey, { kind: 'inserted', slotId, blockId }),
    );
    undo?.stopCapturing();
    return blockId;
  }
  return null;
}
