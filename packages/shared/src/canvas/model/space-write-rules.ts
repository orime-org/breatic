// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The size-cap decisions every Space write is judged by (inner#1790, design
 * 5.2): what kinds there are, which a document's size refuses, and what a
 * refusal says (breatic#1488 §8.1). Web's `writeSpaceDoc` runs the write and
 * shows the refusal.
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

import { t } from '@shared/i18n/index.js';
import { readDocSize } from '@shared/canvas/model/doc-size-store.js';

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
export function refusalOf(name: string, kind: SpaceWriteKind): SpaceRefusalReason | null {
  const state = readDocSize(name);
  if (state.phase === 'resyncing') return 'resyncing';
  return sizeRefusalOf(state.phase === 'full', state.overCeiling, kind);
}

/**
 * Why a write of this kind is refused by a document's size: a full Space
 * takes only `delete` and `remove`, one past the hard ceiling only `remove`.
 * The browser judges its own copy of the size through {@link refusalOf};
 * collab judges an external agent's writes through this with the size it holds.
 * @param full - Whether the document is at or over its limit.
 * @param overCeiling - Whether it is at or over the hard ceiling.
 * @param kind - The kind.
 * @returns The reason, or null when the write may run.
 */
export function sizeRefusalOf(full: boolean, overCeiling: boolean, kind: SpaceWriteKind): 'full' | 'over_ceiling' | null {
  if (!full) return null;
  if (overCeiling) return kind === 'remove' ? null : 'over_ceiling';
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
 * Whether new content may be added now: a request whose result is written
 * into the Space asks this before it goes to the server.
 * @param name - Canonical document name.
 * @returns False while the Space is full or being rebuilt.
 */
export function canAdd(name: string): boolean {
  return refusalOf(name, 'add') === null;
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
