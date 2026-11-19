// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Names for the ids a read returns (breatic#1488 §7): members by the name
 * their profile shows, as the canvas sticky shows authors, and external-agent
 * connections by the name their owner gave them. Emails are never returned.
 */

import type { ServerApi } from "@mcp/server-api.js";

/** Fields whose value is a member's id. */
const USER_FIELDS = new Set(["createdBy", "assignedBy", "userId"]);
/** Fields whose value is an external-agent connection's id. */
const AGENT_FIELDS = new Set(["via", "connectionId"]);
/** Most ids one lookup takes on either route. */
const LOOKUP_MAX_IDS = 100;

/** The ids a read mentions. */
interface MentionedIds {
  users: Set<string>;
  agents: Set<string>;
}

/**
 * Collect the member and connection ids anywhere in a value.
 * @param value - A read's result.
 * @param into - Where they go.
 */
function collect(value: unknown, into: MentionedIds): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string" && USER_FIELDS.has(key)) into.users.add(field);
    else if (typeof field === "string" && AGENT_FIELDS.has(key)) into.agents.add(field);
    else collect(field, into);
  }
}

/**
 * Look ids up in batches the route takes.
 * @param api - The server.
 * @param path - The lookup route.
 * @param ids - The ids.
 * @returns Every row it answered.
 */
async function lookUp<T>(api: ServerApi, path: string, ids: readonly string[]): Promise<T[]> {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += LOOKUP_MAX_IDS) batches.push(ids.slice(i, i + LOOKUP_MAX_IDS));
  return (await Promise.all(batches.map((batch) => api.get<T[]>(path, { ids: batch.join(",") })))).flat();
}

/** Names by id. */
export interface Names {
  users: Record<string, string>;
  agents: Record<string, string>;
}

/**
 * The names of everyone and every agent a read's result mentions.
 * @param api - The server.
 * @param result - The read's result.
 * @returns Names by id; an id the server does not know is left out.
 */
export async function namesIn(api: ServerApi, result: unknown): Promise<Names> {
  const ids: MentionedIds = { users: new Set(), agents: new Set() };
  collect(result, ids);
  const [users, agents] = await Promise.all([
    lookUp<{ id: string; username: string | null }>(api, "/users", [...ids.users]),
    lookUp<{ id: string; name: string }>(api, "/agent-access/connections/names", [...ids.agents]),
  ]);
  return {
    users: Object.fromEntries(users.map((user) => [user.id, user.username ?? ""])),
    agents: Object.fromEntries(agents.map((agent) => [agent.id, agent.name])),
  };
}
