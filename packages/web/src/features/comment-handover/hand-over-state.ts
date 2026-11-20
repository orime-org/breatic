// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a comment thread handed to an external agent shows (#1488 §11.7), the
 * same for canvas notes and document comments: the label the one who handed
 * it over sees while it waits, and the list the hand-over button offers. Both
 * read the server's hand-over record; the document holds no hand-over.
 */

import { tellConnectionsApart, type AgentConnectionItem, type ConnectionTellApart } from '@breatic/shared';
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
  /**
   * The server's record of this thread, as the viewer's records list holds
   * it: only the viewer's own hand-overs are there, so a collaborator has none.
   */
  record: SpaceAssignment | undefined;
  /** Whether the thread is still there to work on: not deleted, not resolved. */
  open: boolean;
  /** The viewer's connections; undefined while they load. */
  connections: readonly AgentConnectionItem[] | undefined;
}

/**
 * The label a thread shows, or null for none: only while the record of the
 * viewer's hand-over is pending, on a thread still there.
 * @param input - The record, the thread and the connections.
 * @returns The label, or null.
 */
export function handOverLabel(input: HandOverLabelInput): HandOverLabel | null {
  const { record, connections } = input;
  if (record === undefined || record.status !== 'pending' || !input.open || connections === undefined) return null;
  const connectionId = record.connectionId;
  const connection = connections.find((c) => c.id === connectionId);
  if (connection === undefined) return { kind: 'disconnected', connectionId };
  if (connection.status === 'active') return { kind: 'waiting', connectionId };
  return { kind: connection.kind === 'pat' ? 'expiredToken' : 'expiredReconnect', connectionId };
}

/** One external agent the hand-over list offers. */
export interface HandOverChoice {
  id: string;
  name: string;
  /** The one that just answered this thread, offered first to hand it again. */
  again: boolean;
  /** What tells it apart from another of the same name, or null when its name is its own. */
  tellApart: ConnectionTellApart;
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
  const told = tellConnectionsApart(usable);
  const choices = usable.map((c): HandOverChoice => ({ id: c.id, name: c.displayName, again: c.id === again, tellApart: told.get(c.id) ?? null }));
  return [...choices.filter((c) => c.again), ...choices.filter((c) => !c.again)];
}
