// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a comment thread handed to an external agent shows (#1488 §11.7), the
 * same for canvas notes and document comments: the label the one who handed
 * it over sees while it waits, and the list the hand-over button offers.
 */

import type { AgentConnectionItem, AnnotationAssignment } from '@breatic/shared';
import type { SpaceAssignment } from '@web/data/api/agent-access';

/** The label on a thread waiting for an external agent, and what it says. */
export interface HandOverLabel {
  /**
   * `waiting` while the connection works; `expiredReconnect` when an OAuth
   * connection expired and reconnecting brings it back; `expiredToken` when a
   * personal access token expired; `disconnected` when the connection is gone.
   */
  kind: 'waiting' | 'expiredReconnect' | 'expiredToken' | 'disconnected';
  connectionId: string;
}

/** What decides a thread's label. */
export interface HandOverLabelInput {
  /** The thread's current hand-over, as the document holds it. */
  assignment: AnnotationAssignment | undefined;
  viewerId: string | undefined;
  /** The project the document is in. */
  projectId: string;
  /** Whether the handed-to connection has answered this hand-over in the thread. */
  answered: boolean;
  /** Whether the thread was resolved (documents only). */
  resolved: boolean;
  /** The server's record of this thread, when it has one. */
  record: SpaceAssignment | undefined;
  /** The viewer's connections; undefined while they load. */
  connections: readonly AgentConnectionItem[] | undefined;
}

/**
 * The label a thread shows, or null for none. Only the one who handed it
 * over sees one, and only while it waits: the server's record decides once it
 * has caught up with this hand-over, the thread's own words until then.
 * @param input - The thread, the record and the connections.
 * @returns The label, or null.
 */
export function handOverLabel(input: HandOverLabelInput): HandOverLabel | null {
  const { assignment, record, connections } = input;
  if (assignment === undefined || assignment.assignedBy !== input.viewerId) return null;
  if (assignment.projectId !== input.projectId || connections === undefined) return null;
  const pending =
    record !== undefined && record.assignedAt === assignment.assignedAt
      ? record.status === 'pending'
      : !input.answered && !input.resolved;
  if (!pending) return null;
  const connectionId = assignment.connectionId;
  const connection = connections.find((c) => c.id === connectionId);
  if (connection === undefined) return { kind: 'disconnected', connectionId };
  if (connection.status === 'active') return { kind: 'waiting', connectionId };
  return { kind: connection.kind === 'pat' ? 'expiredToken' : 'expiredReconnect', connectionId };
}

/**
 * Whether the handed-to connection answered this hand-over: a reply it wrote
 * carrying the hand-over's time.
 * @param assignment - The thread's hand-over.
 * @param entries - The thread's comments.
 * @returns True when such a reply is there.
 */
export function answeredHandOver(
  assignment: AnnotationAssignment | undefined,
  entries: ReadonlyArray<{ via?: string | null; answers?: number | null }>,
): boolean {
  if (assignment === undefined) return false;
  return entries.some((e) => e.via === assignment.connectionId && e.answers === assignment.assignedAt);
}

/** One external agent the hand-over list offers. */
export interface HandOverChoice {
  id: string;
  name: string;
  /** The one that just answered this thread, offered first to hand it again. */
  again: boolean;
  /** What tells it apart from another of the same name, or null when its name is its own. */
  tellApart: { kind: 'token'; prefix: string } | { kind: 'since'; at: string } | null;
}

/**
 * The connections a thread can be handed to: the viewer's working ones, the
 * one that just answered first.
 * @param connections - The viewer's connections.
 * @param again - The connection that answered this thread, if it is the viewer's hand-over.
 * @returns The choices, in the order shown.
 */
export function handOverChoices(
  connections: readonly AgentConnectionItem[],
  again: string | null,
): HandOverChoice[] {
  const usable = connections.filter((c) => c.status === 'active');
  const named = new Map<string, number>();
  for (const c of usable) named.set(c.displayName, (named.get(c.displayName) ?? 0) + 1);
  const choices = usable.map((c): HandOverChoice => {
    const shared = (named.get(c.displayName) ?? 0) > 1;
    let tellApart: HandOverChoice['tellApart'] = null;
    if (shared) {
      tellApart =
        c.kind === 'pat' && c.tokenPrefix !== undefined
          ? { kind: 'token', prefix: c.tokenPrefix }
          : { kind: 'since', at: c.createdAt };
    }
    return { id: c.id, name: c.displayName, again: c.id === again, tellApart };
  });
  return [...choices.filter((c) => c.again), ...choices.filter((c) => !c.again)];
}
