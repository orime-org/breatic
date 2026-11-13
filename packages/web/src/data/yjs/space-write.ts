// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one entry through which web writes a Space document (inner#1790,
 * design 5.2).
 *
 * A write states what it produces in Yjs, never how big it is (`add`, `edit`,
 * `compound`, `delete`, `remove`). Which kinds a document's size refuses, and
 * what a refusal says, are decided in `@breatic/shared/canvas-model`
 * (`space-write-rules.ts`, breatic#1488 §8.1); this module runs the write and
 * shows the refusal.
 */

import {
  refusalOf,
  spaceRefusalMessage,
  type SpaceRefusal,
  type SpaceRefusalReason,
  type SpaceWriteKind,
  type SpaceWriteOptions,
  type SpaceWriteResult,
} from '@breatic/shared/canvas-model';
import { toast } from '@web/lib/toast';

export type { SpaceRefusal, SpaceRefusalReason, SpaceWriteKind, SpaceWriteOptions, SpaceWriteResult };
export { canAdd, spaceRefusalMessage, strongestKind } from '@breatic/shared/canvas-model';

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
 * Judge a write without running it, with the toast the state calls for when
 * it is refused: for an action whose write happens elsewhere later.
 * @param name - Canonical document name.
 * @param options - What the write produces.
 * @returns Whether it may run, or why not.
 */
export function checkWrite(name: string, options: SpaceWriteOptions): SpaceWriteResult {
  const { kind, notify = true } = options;
  const reason = refusalOf(name, kind);
  return reason === null ? { ok: true } : refuse(kind, reason, notify);
}

/**
 * `canAdd`, with the toast the state calls for when it is false.
 * @param name - Canonical document name.
 * @param options - Options.
 * @param options.notify - Show the refusal toast (default true).
 * @returns Whether the request may go, or why not.
 */
export function checkAdd(name: string, { notify = true }: { notify?: boolean } = {}): SpaceWriteResult {
  return checkWrite(name, { kind: 'add', notify });
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
