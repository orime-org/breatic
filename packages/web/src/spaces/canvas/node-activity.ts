// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who is doing what on an empty node (inner#1303 §6.8, A14).
 *
 * The person filling a node sees their own mark (a skeleton, an error line);
 * everyone else sees "{name} is {doing}". That second view travels in
 * awareness, not in the document: it belongs to the person, and leaves with
 * them. What a client publishes comes only from its waiting upload marks, so
 * the marks store stays the one place that decides it.
 */

import { readUserId } from '@web/spaces/canvas/awareness-user';
import type { UploadMark, UploadMarkAction } from '@web/stores/upload-marks';

/** One node this client is working on, as it goes on the wire. */
export interface NodeActivity {
  /** The node. */
  nodeId: string;
  /** What it is doing to the node. */
  action: UploadMarkAction;
  /** When it began, by the publisher's clock. */
  at: number;
}

/** Who another person is and what they are doing to a node. */
export interface PeerAct {
  /** The person, as the collab server stamped their connection. */
  userId: string;
  /** What they are doing. */
  action: UploadMarkAction;
  /** When they began. */
  at: number;
}

/** Node id to the person shown working on it. */
export type PeerActivity = ReadonlyMap<string, PeerAct>;

/**
 * The activity this client publishes: every node it is waiting on.
 * @param marks - This Space's marks, if any.
 * @returns One entry per waiting node.
 * @throws {never} Never.
 */
export function activityFromMarks(
  marks: Readonly<Record<string, UploadMark>> | undefined,
): NodeActivity[] {
  if (!marks) return [];
  return Object.entries(marks).flatMap(([nodeId, mark]) =>
    mark.state === 'waiting' ? [{ nodeId, action: mark.action, at: mark.at }] : [],
  );
}

/**
 * What filling a node from a file is doing: sending the bytes to storage, or
 * reading a text file into the node here.
 * @param spec - The file's node spec.
 * @param spec.needsUpload - Whether its bytes go to storage.
 * @returns `upload` or `readText`.
 * @throws {never} Never.
 */
export function fillActionOf(spec: { needsUpload: boolean }): 'upload' | 'readText' {
  return spec.needsUpload ? 'upload' : 'readText';
}

/**
 * Whether a value read off the wire is one activity entry.
 * @param value - The value.
 * @returns True when it has a string node, a string action and a numeric time.
 * @throws {never} Never.
 */
function isActivity(value: unknown): value is NodeActivity {
  const v = value as Partial<NodeActivity> | null;
  return (
    typeof v?.nodeId === 'string' && typeof v.action === 'string' && typeof v.at === 'number'
  );
}

/**
 * For each node, the other person who started on it last.
 * @param states - The awareness states, as `getStates()` hands them over.
 * @param selfClientId - This client's id, left out.
 * @returns Node id to the person to show.
 * @throws {never} Never.
 */
export function collectPeerActivity(
  states: ReadonlyMap<number, Record<string, unknown>>,
  selfClientId: number,
): Map<string, PeerAct> {
  const table = new Map<string, PeerAct>();
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    const userId = readUserId(state);
    const activity = state.activity;
    if (userId === null || !Array.isArray(activity)) continue;
    for (const entry of activity) {
      if (!isActivity(entry)) continue;
      const shown = table.get(entry.nodeId);
      if (shown && shown.at >= entry.at) continue;
      table.set(entry.nodeId, { userId, action: entry.action, at: entry.at });
    }
  }
  return table;
}

/**
 * Whether two tables show the same people doing the same things.
 * @param a - One table.
 * @param b - The other.
 * @returns True when every node shows the same person, action and time.
 * @throws {never} Never.
 */
export function samePeerActivity(a: PeerActivity, b: PeerActivity): boolean {
  if (a.size !== b.size) return false;
  for (const [nodeId, one] of a) {
    const other = b.get(nodeId);
    if (!other || other.userId !== one.userId || other.action !== one.action || other.at !== one.at) {
      return false;
    }
  }
  return true;
}

/**
 * Whether two published lists say the same thing, in order.
 * @param a - One list, or null.
 * @param b - The other, or null.
 * @returns True when both are null or hold the same entries.
 * @throws {never} Never.
 */
export function sameActivityList(
  a: readonly NodeActivity[] | null,
  b: readonly NodeActivity[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.length === b.length &&
    a.every((one, i) => {
      const other = b[i];
      return other?.nodeId === one.nodeId && other.action === one.action && other.at === one.at;
    })
  );
}
