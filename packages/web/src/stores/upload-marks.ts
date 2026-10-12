// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The uploader's own marks on the nodes it is filling (inner#1303 §6.7).
 *
 * A node is built the moment an upload or a tool run starts, and the server
 * answers later (a ticket, a stored copy, an accepted run). In between, the
 * person who started it sees a skeleton on the node; when it ends before the
 * answer, they see a line saying why. Both live only in this tab's memory and
 * never in the shared document, so a refresh or a closed tab takes them away
 * and nobody else is left looking at a node that never stops loading.
 *
 * Only the latest operation on a node counts: a second upload started on the
 * node while the first waits takes the mark over, and the first one's answer
 * or failure no longer matches it.
 */

import { create } from 'zustand';

import { newId } from '@breatic/shared';

/** A message for the reader, as a locale key and its parameters. */
export interface UploadMarkMessage {
  key: string;
  params?: Record<string, string | number>;
}

/** One node's mark: the operation it belongs to and where it stands. */
export type UploadMark =
  | { op: string; state: 'waiting' }
  | { op: string; state: 'failed'; message: UploadMarkMessage };

interface UploadMarksState {
  /** spaceId → nodeId → mark. */
  marks: Record<string, Record<string, UploadMark>>;
  /**
   * Start an operation on a node, replacing whatever mark it had.
   * @returns The operation's id, which its answer or failure must carry.
   */
  begin: (spaceId: string, nodeId: string) => string;
  /** The server answered this operation: the mark goes. */
  answer: (spaceId: string, nodeId: string, op: string) => void;
  /** This operation ended before the server answered. */
  fail: (spaceId: string, nodeId: string, op: string, message: UploadMarkMessage) => void;
  /** The node's mark, if it has one. */
  markOf: (spaceId: string, nodeId: string) => UploadMark | undefined;
}

/**
 * Set or remove one node's mark, leaving every other one as it was.
 * @param all - Every mark.
 * @param spaceId - The Space.
 * @param nodeId - The node.
 * @param mark - The new mark, or undefined to remove it.
 * @returns The marks.
 */
function withMark(
  all: UploadMarksState['marks'],
  spaceId: string,
  nodeId: string,
  mark: UploadMark | undefined,
): UploadMarksState['marks'] {
  const { [nodeId]: _gone, ...rest } = all[spaceId] ?? {};
  return { ...all, [spaceId]: mark === undefined ? rest : { ...rest, [nodeId]: mark } };
}

export const useUploadMarksStore = create<UploadMarksState>()((set, get) => ({
  marks: {},
  begin: (spaceId, nodeId) => {
    const op = newId();
    set((s) => ({ marks: withMark(s.marks, spaceId, nodeId, { op, state: 'waiting' }) }));
    return op;
  },
  answer: (spaceId, nodeId, op) => {
    const mark = get().markOf(spaceId, nodeId);
    if (mark?.op !== op || mark.state !== 'waiting') return;
    set((s) => ({ marks: withMark(s.marks, spaceId, nodeId, undefined) }));
  },
  fail: (spaceId, nodeId, op, message) => {
    const mark = get().markOf(spaceId, nodeId);
    if (mark?.op !== op || mark.state !== 'waiting') return;
    set((s) => ({ marks: withMark(s.marks, spaceId, nodeId, { op, state: 'failed', message }) }));
  },
  markOf: (spaceId, nodeId) => get().marks[spaceId]?.[nodeId],
}));
