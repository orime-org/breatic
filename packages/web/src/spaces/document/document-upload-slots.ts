// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Uploads in flight in a document body, and where each one's block will land
 * (inner#1127 A2, A4, A6).
 *
 * A file being uploaded has no block yet: its placeholder lives in this
 * plugin's state and is drawn as a widget decoration, so only the uploader
 * sees it and nothing of it reaches the shared document; only its gap's Yjs
 * name rides on undo stack items (below). When the upload finishes, its block
 * is inserted where the placeholder was drawn.
 *
 * A batch remembers its gap as a position between two blocks, carried the way
 * the comment draft carries its range (`document-comment-draft-range.ts`):
 * the reader's own edits move it through `tr.mapping`; a change that comes in
 * through Yjs — a co-editor's edit, which reaches ProseMirror as one
 * replacement of the whole body — is followed by the Yjs relative position
 * taken after the change before it; the reader's undo or redo hands back the
 * position as it stood before the edit it takes back (`namesOnUndoStack`),
 * and a batch started after that edit follows its Yjs relative position. A
 * position that lands inside a block is lifted to the gap under that block's
 * line. The placeholder and the insert both ask {@link resolveSlotPosition},
 * so a placeholder drawn in one place and a block landing in another cannot
 * happen. Design 3.3 holds the transition table.
 */

import { blockToNode, createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from 'y-prosemirror';
import type * as Y from 'yjs';

import { keyedStore } from '@web/lib/keyed-store';
import { watchPluginState } from '@web/spaces/document/document-plugin-watch';
import { syncBindingOf } from '@web/spaces/document/document-link-tracking';
import { QUOTED } from '@web/spaces/document/document-list-block';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { namesOnUndoStack } from '@web/spaces/document/document-undo-selection';
import { fromYjs } from '@web/spaces/document/document-yjs-origin';

/** Where a batch of files lands: a position between two blocks. */
export type UploadGap = number;

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
export interface UploadBatch {
  readonly id: string;
  /** The gap the files go into. */
  readonly gap: UploadGap;
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
 * Where the k-th file of a batch goes in the document as it is now: before the
 * nearest later file of the batch already inserted, after the nearest earlier
 * one, or at the batch's gap. Every file therefore keeps the order it came in,
 * whichever finishes first.
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
  return batch.gap;
}

/**
 * The gap between blocks a position stands for. One inside a block is lifted
 * to the gap under that block's line: the head of its nested blocks when it
 * has some, as "insert below" places a row (`insertRowForMenu`), or the gap
 * after it.
 * @param doc - The document.
 * @param pos - A position.
 * @returns A position between two blocks.
 */
export function blockGapAt(doc: PMNode, pos: number): number {
  // The top-level block group, which is the document's only child, spans 1 to size - 1.
  const $at = doc.resolve(Math.min(Math.max(pos, 1), doc.content.size - 1));
  for (let depth = $at.depth; depth > 0; depth -= 1) {
    if ($at.node(depth).type.name !== 'blockGroup') continue;
    if (depth === $at.depth) return $at.pos;
    const row = $at.node(depth + 1);
    const children = row.lastChild;
    if (row.childCount > 1 && children?.type.name === 'blockGroup') {
      return $at.before(depth + 1) + 1 + row.firstChild!.nodeSize + 1;
    }
    return $at.after(depth + 1);
  }
  return doc.content.size - 1;
}

/**
 * Whether a block inserted at a gap goes in quoted: as the block before it, or
 * the block after it at the head of a level.
 * @param doc - The document.
 * @param at - A position between two blocks.
 * @returns True when quoted.
 */
function quotedAt(doc: PMNode, at: number): boolean {
  const $at = doc.resolve(at);
  const beside = $at.nodeBefore ?? $at.nodeAfter;
  return beside?.firstChild?.attrs[QUOTED] === true;
}

/** Each batch's gap as Yjs names it, by batch id. */
type NamedGaps = ReadonlyMap<string, Y.RelativePosition>;

/** The sync binding, as a gap's name is taken and read against. */
type Binding = NonNullable<ReturnType<typeof syncBindingOf>>;

/**
 * A gap as Yjs names it.
 * @param bound - The sync binding.
 * @param gap - The gap.
 * @returns Its relative position.
 */
function nameGap(bound: Binding, gap: UploadGap): Y.RelativePosition {
  return absolutePositionToRelativePosition(gap, bound.type, bound.mapping) as Y.RelativePosition;
}

/**
 * Where a named gap is now.
 * @param bound - The sync binding.
 * @param name - The gap's relative position.
 * @returns The position, or null when Yjs cannot place it.
 */
function gapNamed(bound: Binding, name: Y.RelativePosition): UploadGap | null {
  return relativePositionToAbsolutePosition(bound.doc, bound.type, name, bound.mapping);
}

/**
 * The batches with their gaps carried across a change to the body.
 * @param batches - The batches.
 * @param tr - The change.
 * @param state - The state after it.
 * @param named - The gaps as Yjs named them before a change from Yjs.
 * @param handed - On the reader's undo or redo, the gaps as named before the
 *   edit it takes back; a batch started after that edit has none there and
 *   goes by `named`.
 * @returns The batches, the same array when no gap moved.
 */
function carryGaps(
  batches: readonly UploadBatch[],
  tr: Transaction,
  state: EditorState,
  named: NamedGaps,
  handed: NamedGaps | null,
): readonly UploadBatch[] {
  const bound = fromYjs(tr) ? syncBindingOf(state) : null;
  let changed = false;
  const next = batches.map((batch) => {
    const name = handed?.get(batch.id) ?? named.get(batch.id);
    const found = bound !== null && name !== undefined ? gapNamed(bound, name) : null;
    const gap = blockGapAt(tr.doc, found ?? tr.mapping.map(batch.gap));
    if (gap === batch.gap) return batch;
    changed = true;
    return { ...batch, gap };
  });
  return changed ? next : batches;
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
          (view) => {
            const holder = document.createElement('div');
            holder.setAttribute(UPLOAD_SLOT_ATTRIBUTE, slot.id);
            holder.contentEditable = 'false';
            putSlotHolder(view, slot.id, holder);
            return holder;
          },
          // Keyed by slot so the container usually survives a redraw. When
          // ProseMirror builds a new one anyway (a block before it on its
          // level went), the new one is entered and the page moves there.
          // Sides in batch order keep files that share a position in the
          // order they came in.
          {
            key: slot.id,
            side: k - batch.slots.length,
            destroy: (node) => {
              dropSlotHolder(node as HTMLElement);
            },
          },
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

const NO_HOLDERS: ReadonlyMap<string, HTMLElement> = new Map();

/** Every view's placeholder containers by slot id. */
const holders = keyedStore<EditorView, ReadonlyMap<string, HTMLElement>>(() => NO_HOLDERS);

/** The view each container was built for, for the widget's teardown. */
const viewOfHolder = new WeakMap<HTMLElement, EditorView>();

/**
 * Enters the container a slot's widget just built.
 * @param view - The editor view.
 * @param slotId - The slot.
 * @param holder - Its container.
 */
function putSlotHolder(view: EditorView, slotId: string, holder: HTMLElement): void {
  viewOfHolder.set(holder, view);
  holders.set(view, new Map(holders.get(view)).set(slotId, holder));
}

/**
 * Takes a container out when its widget goes, unless a newer one took its slot.
 * @param holder - The container.
 */
function dropSlotHolder(holder: HTMLElement): void {
  const view = viewOfHolder.get(holder);
  const slotId = holder.getAttribute(UPLOAD_SLOT_ATTRIBUTE);
  if (view === undefined || slotId === null) return;
  const now = holders.get(view);
  if (now.get(slotId) !== holder) return;
  const next = new Map(now);
  next.delete(slotId);
  holders.set(view, next);
}

/**
 * Every slot's container in a view now; the same map until one changes.
 * @param view - The editor view.
 * @returns The containers by slot id.
 */
export function uploadSlotHoldersIn(view: EditorView): ReadonlyMap<string, HTMLElement> {
  return holders.get(view);
}

/**
 * Hears about every change to a view's containers.
 * @param view - The editor view.
 * @param listener - Called after each change.
 * @returns The function that stops it.
 */
export function onUploadSlotHoldersChange(view: EditorView, listener: () => void): () => void {
  return holders.subscribe(view, listener);
}

const watch = watchPluginState(uploadBatchesIn);

/** Hears about every change to the uploads in flight. */
export const onUploadSlotsChange: (listener: () => void) => () => void = watch.onChange;

/**
 * The extension that carries the plugin.
 * @returns The extension, for the assembly to register.
 */
export const documentUploadsExtension = createExtension(() => {
  // Each batch's gap as Yjs names it, taken again after every change.
  let named: NamedGaps = new Map();
  const onUndoStack = namesOnUndoStack(() => named);
  return ({
    key: 'document-uploads',
    prosemirrorPlugins: [
      new Plugin<UploadsState>({
        key: documentUploadsKey,
        state: {
          init: () => ({ batches: [], decorations: DecorationSet.empty }),
          apply: (tr, previous, _old, state) => {
            const action = tr.getMeta(documentUploadsKey) as UploadsAction | undefined;
            if (action === undefined && !tr.docChanged) return previous;
            const reduced =
              action === undefined ? previous.batches : reduce(previous.batches, action);
            const batches = tr.docChanged ? carryGaps(reduced, tr, state, named, onUndoStack.handedFor(tr)) : reduced;
            return { batches, decorations: decorate(batches, state.doc) };
          },
        },
        props: {
          decorations: (state) => documentUploadsKey.getState(state)?.decorations,
        },
        view: (view) => {
          const watching = watch.view(view);
          const stopKeeping = onUndoStack.attach(view);
          return {
            update: (next, prev): void => {
              const batches = uploadBatchesIn(next.state);
              if (next.state.doc !== prev.doc || batches !== uploadBatchesIn(prev)) {
                const bound = syncBindingOf(next.state);
                named = new Map(
                  bound === null
                    ? []
                    : batches.map((batch) => [batch.id, nameGap(bound, batch.gap)]),
                );
              }
              watching.update?.(next, prev);
            },
            destroy: (): void => {
              stopKeeping();
              watching.destroy?.();
            },
          };
        },
      }),
    ],
  }) as never;
});

/**
 * Dispatches one action.
 * @param view - The editor view.
 * @param action - What to do.
 */
function send(view: EditorView, action: UploadsAction): void {
  view.dispatch(view.state.tr.setMeta(documentUploadsKey, action));
}

/**
 * Starts a batch: one placeholder per file, all at one gap.
 * @param view - The editor view.
 * @param gap - The gap, a position between two blocks.
 * @param names - The files' names, in the order they came in.
 * @returns The slots' ids, in the same order.
 */
export function addUploadBatch(
  view: EditorView,
  gap: UploadGap,
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
  send(view, { kind: 'add', batch: { id: crypto.randomUUID(), gap: blockGapAt(view.state.doc, gap), slots } });
  return slots.map((slot) => slot.id);
}

/**
 * Holds a gap until its batch is started, which waits on admission: named in
 * Yjs, so the reader's edits and a co-editor's meanwhile carry it along.
 * @param view - The editor view.
 * @param gap - The gap as it is now.
 * @returns A function giving the gap as it stands when called.
 */
export function holdGap(view: EditorView, gap: UploadGap): () => UploadGap {
  const bound = syncBindingOf(view.state);
  if (bound === null) return () => gap;
  const name = nameGap(bound, gap);
  return () => {
    const now = syncBindingOf(view.state);
    return (now === null ? null : gapNamed(now, name)) ?? gap;
  };
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
  const batches = uploadBatchesIn(view.state);
  for (const batch of batches) {
    const k = batch.slots.findIndex((slot) => slot.id === slotId);
    if (k < 0 || batch.slots[k]!.phase !== 'uploading') continue;
    const blockId = crypto.randomUUID();
    const at = resolveSlotPosition(batch, k, view.state.doc);
    const props = { ...block.props, [QUOTED]: quotedAt(view.state.doc, at) };
    const node = blockToNode({ ...block, props, id: blockId } as never, view.state.schema);
    undo?.stopCapturing();
    view.dispatch(
      view.state.tr
        .insert(at, node)
        .setMeta(documentUploadsKey, { kind: 'inserted', slotId, blockId }),
    );
    undo?.stopCapturing();
    return blockId;
  }
  return null;
}
