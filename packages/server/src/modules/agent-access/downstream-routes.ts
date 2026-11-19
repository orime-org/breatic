// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The routes a downstream token is accepted on (#1488 §5.5): the ones the MCP
 * tools and uploads call, and nothing else. Account, payment, subscription,
 * membership and token management answer a downstream token with 401.
 *
 * `project` names where a route reads its `project_id`, so the external
 * agent's rate limit can count it per user per Studio (§6); a route without
 * one counts in the user's total.
 */

import type { Context } from "hono";
import { matchedRoutes } from "hono/route";

/** One whitelisted route, as Hono reports it in `app.routes`. */
export interface DownstreamRoute {
  method: "GET" | "POST";
  path: string;
  /** The validated target carrying `project_id`, on routes that name a Project. */
  project?: "query" | "json";
}

/** Every route a downstream token is accepted on. */
export const DOWNSTREAM_TOKEN_ROUTES: readonly DownstreamRoute[] = [
  { method: "GET", path: "/api/v1/studios" },
  { method: "GET", path: "/api/v1/studio/:slug/projects" },
  { method: "GET", path: "/api/v1/models" },
  { method: "GET", path: "/api/v1/models/:modelName/voices" },
  { method: "GET", path: "/api/v1/users" },
  { method: "POST", path: "/api/v1/canvas/tasks", project: "json" },
  { method: "POST", path: "/api/v1/canvas/understand", project: "json" },
  { method: "POST", path: "/api/v1/canvas/transcribe", project: "json" },
  { method: "POST", path: "/api/v1/mini-tools", project: "json" },
  { method: "GET", path: "/api/v1/canvas/nodes/:nodeId/history", project: "query" },
  { method: "GET", path: "/api/v1/canvas/node-tasks" },
  { method: "POST", path: "/api/v1/canvas/node-tasks/:taskId/failure" },
  { method: "POST", path: "/api/v1/canvas/ingest-url", project: "json" },
  { method: "GET", path: "/api/v1/assets/upload-config" },
  { method: "POST", path: "/api/v1/assets/upload-ticket", project: "json" },
  { method: "POST", path: "/api/v1/assets/uploads/:uploadId/complete" },
  { method: "GET", path: "/api/v1/assets/upload-status" },
  { method: "POST", path: "/api/v1/assets/ingest-url", project: "json" },
  { method: "POST", path: "/api/v1/assets/deleted", project: "json" },
  { method: "GET", path: "/api/v1/agent-access/connections/names" },
  { method: "GET", path: "/api/v1/agent/assignments" },
];

/**
 * The whitelist entry of the route this request is handled by. Every route
 * the request matched (middleware mounted for all methods aside) must be on
 * the list, so no handler outside it can answer a downstream token.
 * @param c - The request context.
 * @returns The entry, or null when the request is not for a whitelisted route.
 */
export function matchDownstreamRoute(c: Context): DownstreamRoute | null {
  const routes = matchedRoutes(c).filter((r) => r.method !== "ALL");
  let found: DownstreamRoute | null = null;
  for (const route of routes) {
    const entry = DOWNSTREAM_TOKEN_ROUTES.find((e) => e.method === route.method && e.path === route.path);
    if (!entry) return null;
    found = entry;
  }
  return found;
}
