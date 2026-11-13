// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** The MCP SDK's default request timeout; a call must answer inside it. */
const SDK_REQUEST_TIMEOUT_MS = 60_000;

/** OAuth token lifetimes for external-agent access (#1488). */
const oauthSchema = z.object({
  access_token_ttl_seconds: positiveInt.default(3600),
  refresh_token_ttl_seconds: positiveInt.default(30 * 24 * 3600),
  /** How long one authorization lives; every refresh token it issues ends with it. */
  grant_ttl_seconds: positiveInt.default(365 * 24 * 3600),
  /** How long a rotated refresh token is still accepted (Okta allows 0-60 seconds). */
  refresh_reuse_grace_seconds: z.number().int().min(0).max(60).default(30),
});

/** Bounds of one view capture. */
const viewCaptureSchema = z.object({
  max_edge_px: positiveInt.default(1568),
  timeout_ms: positiveInt.default(8000),
  max_bytes: positiveInt.default(917_504),
});

/** Runtime parameters of external-agent access (#1488 §13). */
export const mcpConfigSchema = z.object({
  oauth: oauthSchema.prefault({}),
  /** Lifetime of the token the MCP service mints for each downstream API call. */
  downstream_token_ttl_seconds: positiveInt.default(300),
  /** How long a call waits for the first reply to a command. */
  command_wait_ms: positiveInt.default(10_000),
  /** The whole call's limit. */
  call_timeout_ms: positiveInt.default(45_000),
  task_query_max_ids: positiveInt.default(50),
  read_canvas_max_nodes: positiveInt.default(500),
  view_capture: viewCaptureSchema.prefault({}),
  pat: z.object({ max_active_per_user: positiveInt.default(20) }).prefault({}),
  rate_limit: z.object({
    commands_per_minute: positiveInt.default(180),
    user_total_per_minute: positiveInt.default(300),
  }).prefault({}),
}).superRefine((config, ctx) => {
  if (config.view_capture.timeout_ms >= config.command_wait_ms) {
    ctx.addIssue({ code: "custom", path: ["view_capture", "timeout_ms"], message: "view_capture.timeout_ms must be below command_wait_ms" });
  }
  if (config.command_wait_ms > config.call_timeout_ms) {
    ctx.addIssue({ code: "custom", path: ["command_wait_ms"], message: "command_wait_ms exceeds call_timeout_ms" });
  }
  if (config.call_timeout_ms >= SDK_REQUEST_TIMEOUT_MS) {
    ctx.addIssue({ code: "custom", path: ["call_timeout_ms"], message: "call_timeout_ms must be below the MCP SDK's 60000 ms request timeout" });
  }
  if (config.oauth.refresh_token_ttl_seconds > config.oauth.grant_ttl_seconds) {
    ctx.addIssue({ code: "custom", path: ["oauth", "refresh_token_ttl_seconds"], message: "refresh_token_ttl_seconds exceeds grant_ttl_seconds" });
  }
});

/** Validated external-agent access settings. */
export type McpConfig = z.infer<typeof mcpConfigSchema>;
let cached: Readonly<McpConfig> | undefined;

/**
 * Read external-agent access configuration lazily after service bootstrap.
 * @returns The cached validated configuration.
 * @throws {Error} When the tracked YAML cannot be read or validated.
 */
export function getMcpConfig(): Readonly<McpConfig> {
  if (cached !== undefined) return cached;
  cached = Object.freeze(mcpConfigSchema.parse(parse(readFileSync(resolve(MONOREPO_ROOT, "config/mcp.yaml"), "utf8"))));
  return cached;
}
