// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one entry through which web writes a Space document (inner#1790).
 *
 * A write states what it does to the document's size: `add` grows it,
 * `overwrite` replaces existing values, `delete` removes content. Adds stop at
 * the full line and at the room left; overwrites stop once the room kept
 * below the hard ceiling is used up; deletes always go through. Everything
 * goes through while the size is unknown, and nothing while a refused document
 * is being rebuilt. Neither function throws for a full Space: callers read the
 * result.
 */

import type { Slice } from '@tiptap/pm/model';

import { formatBytes, parseDocName, t } from '@breatic/shared';
import { readDocVersions } from '@web/data/yjs/collab-socket';
import {
  availableRoom, bindWrite, freeReservation, heldBytes, holdRoom, readDocSize, type SpaceReservation,
} from '@web/data/yjs/doc-size';
import { toast } from '@web/lib/toast';

export type { SpaceReservation } from '@web/data/yjs/doc-size';

/** Bytes counted for each node a write creates, over its own content. */
const NODE_BYTES = 64;

/**
 * UTF-8 bytes of a string.
 * @param text - The string.
 * @returns Its encoded length.
 */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * What adding one canvas node can grow its document by.
 * @param node - The node's fields as they are written.
 * @returns Bytes.
 */
export function estimateNodeBytes(node: unknown): number {
  return utf8Bytes(JSON.stringify(node) ?? '') + NODE_BYTES;
}

/**
 * What inserting a ProseMirror slice can grow its document by: its text, a
 * fixed count per node, and the attributes and marks it carries.
 * @param slice - The slice.
 * @returns Bytes.
 */
export function estimateSliceBytes(slice: Slice): number {
  let bytes = 0;
  slice.content.descendants((node) => {
    bytes += NODE_BYTES + utf8Bytes(JSON.stringify(node.attrs));
    if (node.isText) bytes += utf8Bytes(node.text ?? '');
    for (const mark of node.marks) bytes += utf8Bytes(JSON.stringify(mark.toJSON()));
    return true;
  });
  return bytes;
}

/** What a write does to the document's size. */
export type SpaceWriteKind = 'add' | 'overwrite' | 'delete';

/** Why a write or reservation was refused. */
export type SpaceRefusal = { ok: false; reason: 'full' } | { ok: false; reason: 'no_room'; room: number };

/** The outcome of `writeSpaceDoc`. */
export type SpaceWriteResult = { ok: true } | SpaceRefusal;

/** The outcome of `reserveSpaceRoom`. */
export type SpaceReserveResult = { ok: true; reservation: SpaceReservation } | SpaceRefusal;

/** How a write is judged. */
export interface SpaceWriteOptions {
  kind: SpaceWriteKind;
  /** Bytes an add can grow the document by. */
  estimate?: number;
  /** Room reserved for this write before it was requested from the server. */
  reservation?: SpaceReservation;
  /** Show the refusal toast; false for entries that report the outcome themselves. */
  notify?: boolean;
}

/**
 * The sentence for a refused write.
 * @param name - Canonical document name.
 * @param kind - The refused kind.
 * @param refusal - The refusal.
 * @returns The sentence.
 */
export function spaceRefusalMessage(name: string, kind: Exclude<SpaceWriteKind, 'delete'>, refusal: SpaceRefusal): string {
  if (refusal.reason === 'no_room') return t('spaces.size.noRoom', { room: formatBytes(refusal.room) });
  const spaceKind = parseDocName(name)?.kind;
  if (spaceKind === 'timeline') return t('spaces.size.timelineFull');
  if (spaceKind === '3d') return t('spaces.size.threeDFull');
  return t(kind === 'add' ? 'spaces.size.addBlocked' : 'spaces.size.overwriteBlocked');
}

/**
 * Refuse, with the toast unless the caller reports it or the document is
 * being rebuilt (its own toast was shown once).
 * @param name - Canonical document name.
 * @param kind - The refused kind.
 * @param refusal - The refusal.
 * @param notify - Whether to toast.
 * @returns The refusal.
 */
function refuse<R extends SpaceRefusal>(name: string, kind: Exclude<SpaceWriteKind, 'delete'>, refusal: R, notify: boolean): R {
  if (notify && readDocSize(name).phase !== 'resyncing') toast.warning(spaceRefusalMessage(name, kind, refusal));
  return refusal;
}

/**
 * Hold room for a write that is requested from the server before it lands.
 * @param name - Canonical document name.
 * @param estimateBytes - Bytes the write can add.
 * @param options - Options.
 * @param options.notify - Show the refusal toast (default true).
 * @returns The reservation, or why there is no room.
 */
export function reserveSpaceRoom(name: string, estimateBytes: number, { notify = true }: { notify?: boolean } = {}): SpaceReserveResult {
  const state = readDocSize(name);
  if (state.phase === 'full' || state.phase === 'resyncing') return refuse(name, 'add', { ok: false, reason: 'full' }, notify);
  const room = availableRoom(name);
  if (room === null) return { ok: true, reservation: freeReservation() };
  if (estimateBytes > room) return refuse(name, 'add', { ok: false, reason: 'no_room', room }, notify);
  return { ok: true, reservation: holdRoom(name, estimateBytes) };
}

/**
 * Write a Space document if its size allows the write.
 * @param name - Canonical document name.
 * @param options - What the write does and what it carries.
 * @param write - The write; runs only when allowed.
 * @returns Whether it ran, or why not.
 * @throws {Error} Whatever `write` throws.
 */
export function writeSpaceDoc(name: string, options: SpaceWriteOptions, write: () => void): SpaceWriteResult {
  const { kind, estimate, reservation, notify = true } = options;
  const state = readDocSize(name);
  if (state.phase === 'resyncing') return kind === 'delete' ? { ok: false, reason: 'full' } : refuse(name, kind, { ok: false, reason: 'full' }, notify);
  if (state.phase === 'unknown' || kind === 'delete') {
    write();
    return { ok: true };
  }
  if (kind === 'overwrite') {
    if (state.overwriteRoom === 0) return refuse(name, kind, { ok: false, reason: 'full' }, notify);
    write();
    return { ok: true };
  }
  if (state.phase === 'full') return refuse(name, kind, { ok: false, reason: 'full' }, notify);
  const held = heldBytes(name, reservation);
  const room = availableRoom(name) ?? 0;
  if (estimate !== undefined && estimate - (held ?? 0) > room) return refuse(name, kind, { ok: false, reason: 'no_room', room }, notify);
  write();
  if (estimate !== undefined || held !== null) {
    bindWrite(name, estimate ?? 0, readDocVersions(name)?.localVersion ?? 0, held !== null ? reservation : undefined);
  }
  return { ok: true };
}
