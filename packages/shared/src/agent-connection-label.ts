// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AgentConnectionItem } from "@shared/types/agent-access.js";

/**
 * What tells one external-agent connection apart from another of the same
 * name and owner (breatic#1488 design 19.2, 11.7): a personal access token's
 * first characters, or when an OAuth connection was first authorized; null
 * when the name is the owner's only one.
 */
export type ConnectionTellApart = { kind: "token"; prefix: string } | { kind: "since"; at: string } | null;

/** A connection's name as anyone in the project may read it. */
export interface ConnectionName {
  id: string;
  name: string;
  tellApart: ConnectionTellApart;
}

/**
 * Tell one owner's connections apart where they share a name.
 * @param connections - One owner's connections.
 * @returns What tells each apart, by id.
 */
export function tellConnectionsApart(
  connections: ReadonlyArray<Pick<AgentConnectionItem, "id" | "displayName" | "createdAt" | "tokenPrefix">>,
): Map<string, ConnectionTellApart> {
  const named = new Map<string, number>();
  for (const c of connections) named.set(c.displayName, (named.get(c.displayName) ?? 0) + 1);
  return new Map(
    connections.map((c): [string, ConnectionTellApart] => {
      if ((named.get(c.displayName) ?? 0) < 2) return [c.id, null];
      return [c.id, c.tokenPrefix ? { kind: "token", prefix: c.tokenPrefix } : { kind: "since", at: c.createdAt }];
    }),
  );
}
