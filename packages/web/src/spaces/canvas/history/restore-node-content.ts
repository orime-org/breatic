// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { NodeHistoryEntry, NodeTaskEntry } from '@web/data/api/canvas';
import {
  evaluateNodeGate,
  type NodeGateState,
} from '@web/spaces/canvas/node-gate';
import type { HistoryModality } from '@web/spaces/canvas/history/NodeHistoryRow';

/**
 * What a restore attempt resolves to — the pure decision, separated from the
 * Yjs reads (gate state) and writes (restoreNodeMedia) so the #1619 restore
 * invariants are unit-testable without a canvas.
 */
export type RestoreDecision =
  | { readonly kind: 'noop' }
  | { readonly kind: 'blocked'; readonly toastKey: string }
  | {
      readonly kind: 'write';
      readonly content: string;
      readonly coverUrl: string | null | undefined;
    };

/**
 * Decide what a history restore should do (#1619). Pure: the caller reads the
 * fresh gate state + performs the write. Invariants:
 * - INV-9: `readOnly` → noop (an editor→viewer downgrade cannot write).
 * - INV-4: a failed / content-less entry → noop (never restorable).
 * - INV-1 / INV-2: a locked node, or one with a live handling lease, → blocked
 *   with the gate's toast key (the caller must pass `handling` already OR'd
 *   with the live-lease read).
 * - INV-8: video restores carry the cover (`thumbnailUrl`, `null` clears a
 *   stale poster); image / audio pass `undefined` so `coverUrl` is untouched
 *   (writing it would leak an asset-GC phantom reference).
 * - INV-3: an allowed restore writes the entry's content back.
 * @param opts - The restore inputs.
 * @param opts.readOnly - Whether the viewer is read-only.
 * @param opts.entry - The chosen history row.
 * @param opts.modality - The host node's modality.
 * @param opts.gateState - The node's fresh locked / handling state (handling
 *   already OR'd with the live-lease read by the caller).
 * @returns The restore decision.
 */
export function resolveRestore(opts: {
  readOnly: boolean;
  entry: Pick<NodeHistoryEntry, 'status' | 'content' | 'thumbnailUrl'>;
  modality: HistoryModality;
  gateState: NodeGateState;
}): RestoreDecision {
  if (opts.readOnly) return { kind: 'noop' };
  if (opts.entry.status !== 'success' || opts.entry.content == null) {
    return { kind: 'noop' };
  }
  const block = evaluateNodeGate(opts.gateState);
  if (block) return { kind: 'blocked', toastKey: block.toastKey };
  return {
    kind: 'write',
    content: opts.entry.content,
    coverUrl:
      opts.modality === 'video' ? (opts.entry.thumbnailUrl ?? null) : undefined,
  };
}

/**
 * Decide what the task list's Replace should do (#186 §7.4).
 *
 * A task's result and a history row's result are the same thing reached two
 * ways, so the rules are the same and are decided in one place. In particular
 * INV-8: a video whose result carries no cover clears the node's poster, which
 * is what keeps the previous clip's thumbnail off the new clip.
 * @param opts - The replace inputs.
 * @param opts.readOnly - Whether the viewer is read-only.
 * @param opts.task - The row the user picked, as the list holds it.
 * @param opts.modality - The host node's modality.
 * @param opts.gateState - The node's fresh locked state.
 * @returns The same decision a restore resolves to.
 */
export function resolveTaskReplace(opts: {
  readOnly: boolean;
  task: Pick<NodeTaskEntry, 'content' | 'coverUrl'>;
  modality: HistoryModality;
  gateState: NodeGateState;
}): RestoreDecision {
  return resolveRestore({
    readOnly: opts.readOnly,
    // A row the list offers Replace on has already finished with a result;
    // `resolveRestore` refuses anything else, which is the guard for a row
    // whose content the server sent as null.
    entry: {
      status: 'success',
      content: opts.task.content,
      thumbnailUrl: opts.task.coverUrl,
    },
    modality: opts.modality,
    gateState: opts.gateState,
  });
}
