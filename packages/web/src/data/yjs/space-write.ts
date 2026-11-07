// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one entry through which web writes a Space document (inner#1790,
 * design 5.2).
 *
 * A write states what it produces in Yjs, never how big it is: `add` writes
 * new content, `edit` changes fields of existing content, `compound` is a
 * deletion whose implementation also rewrites other content, `delete` removes
 * part of existing content, and `remove` drops whole Y types or whole Map
 * entries. A full Space takes only `delete` and `remove`, matching collab's
 * pure-delete step; past the hard ceiling only `remove`, matching the
 * whole-type step. Everything goes through while the size is unknown and
 * nothing while a refused document is being rebuilt.
 */

import { t } from '@breatic/shared';
import { readDocSize } from '@web/data/yjs/doc-size';
import { toast } from '@web/lib/toast';

/** What a write produces in Yjs. */
export type SpaceWriteKind = 'add' | 'edit' | 'compound' | 'delete' | 'remove';

/** Why a write was refused. */
export type SpaceRefusalReason = 'full' | 'over_ceiling' | 'resyncing';

/** A refused write. */
export type SpaceRefusal = { ok: false; reason: SpaceRefusalReason };

/** The outcome of `writeSpaceDoc`. */
export type SpaceWriteResult = { ok: true } | SpaceRefusal;

/** How a write is judged. */
export interface SpaceWriteOptions {
  kind: SpaceWriteKind;
  /** Show the refusal toast; false for entries that report the outcome themselves. */
  notify?: boolean;
}

/**
 * Why a write of this kind is refused right now.
 * @param name - Canonical document name.
 * @param kind - The kind.
 * @returns The reason, or null when the write may run.
 */
function refusalOf(name: string, kind: SpaceWriteKind): SpaceRefusalReason | null {
  const state = readDocSize(name);
  if (state.phase === 'resyncing') return 'resyncing';
  if (state.phase !== 'full') return null;
  if (state.overCeiling) return kind === 'remove' ? null : 'over_ceiling';
  return kind === 'delete' || kind === 'remove' ? null : 'full';
}

/**
 * The sentence for a refused write; none while a refused document is being
 * rebuilt, whose own sentence was shown once.
 * @param kind - The refused kind.
 * @param reason - Why.
 * @returns The sentence, or null.
 */
export function spaceRefusalMessage(kind: SpaceWriteKind, reason: SpaceRefusalReason): string | null {
  if (reason === 'resyncing') return null;
  if (reason === 'over_ceiling') return t('spaces.sizeCap.over');
  return t(kind === 'compound' ? 'spaces.sizeCap.compound' : 'spaces.sizeCap.add');
}

/**
 * Refuse, with the toast unless the caller reports it.
 * @param kind - The refused kind.
 * @param reason - Why.
 * @param notify - Whether to toast.
 * @returns The refusal.
 */
function refuse(kind: SpaceWriteKind, reason: SpaceRefusalReason, notify: boolean): SpaceRefusal {
  const message = notify ? spaceRefusalMessage(kind, reason) : null;
  if (message !== null) toast.warning(message);
  return { ok: false, reason };
}

/**
 * Whether new content may be added now: a request whose result is written
 * into the Space asks this before it goes to the server.
 * @param name - Canonical document name.
 * @returns False while the Space is full or being rebuilt.
 */
export function canAdd(name: string): boolean {
  return refusalOf(name, 'add') === null;
}

/**
 * {@link canAdd}, with the toast the state calls for when it is false.
 * @param name - Canonical document name.
 * @param options - Options.
 * @param options.notify - Show the refusal toast (default true).
 * @returns Whether the request may go, or why not.
 */
export function checkAdd(name: string, { notify = true }: { notify?: boolean } = {}): SpaceWriteResult {
  const reason = refusalOf(name, 'add');
  return reason === null ? { ok: true } : refuse('add', reason, notify);
}

/** Space documents with an allowed write running, by depth. */
const openWrites = new Map<string, number>();

/**
 * Run an allowed write, marking the document while it runs.
 * @param name - Canonical document name.
 * @param write - The write.
 * @throws {Error} Whatever `write` throws.
 */
function run(name: string, write: () => void): void {
  openWrites.set(name, (openWrites.get(name) ?? 0) + 1);
  try {
    write();
  } finally {
    const depth = (openWrites.get(name) ?? 1) - 1;
    if (depth === 0) openWrites.delete(name);
    else openWrites.set(name, depth);
  }
}

const KIND_RANK: Record<SpaceWriteKind, number> = { remove: 0, delete: 1, compound: 2, edit: 3, add: 4 };

/**
 * The kind several writes made as one are judged by: the strongest
 * (`add` > `edit` > `compound` > `delete` > `remove`).
 * @param kinds - Each write's kind.
 * @returns The strongest kind; `remove` for none.
 */
export function strongestKind(...kinds: ReadonlyArray<SpaceWriteKind>): SpaceWriteKind {
  let strongest: SpaceWriteKind = 'remove';
  for (const kind of kinds) if (KIND_RANK[kind] > KIND_RANK[strongest]) strongest = kind;
  return strongest;
}

/**
 * Write a Space document if its size allows the write.
 * @param name - Canonical document name.
 * @param options - What the write produces.
 * @param write - The write; runs only when allowed.
 * @returns Whether it ran, or why not.
 * @throws {Error} Whatever `write` throws.
 */
export function writeSpaceDoc(name: string, options: SpaceWriteOptions, write: () => void): SpaceWriteResult {
  // A write inside an allowed one is part of it: the outer write stated the
  // strongest kind.
  if ((openWrites.get(name) ?? 0) > 0) {
    write();
    return { ok: true };
  }
  const { kind, notify = true } = options;
  const reason = refusalOf(name, kind);
  if (reason !== null) return refuse(kind, reason, notify);
  run(name, write);
  return { ok: true };
}
