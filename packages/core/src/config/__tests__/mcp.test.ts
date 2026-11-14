// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `config/mcp.yaml` (#1488 §13): the runtime parameters of external-agent
 * access, read by server (OAuth lifetimes, personal access tokens, task
 * queries, rate limits), collab (command rate limit) and the MCP service
 * (waits, timeouts, captures). What it pins: the start values the design
 * fixes, and the relations between values that would break a flow if an
 * operator edited one without the other.
 */

import { describe, expect, it } from "vitest";

import { getMcpConfig, mcpConfigSchema } from "@core/config/mcp.js";

/**
 * Parses an `mcp.yaml` body with some fields replaced.
 * @param over - Top-level blocks to put in the body.
 * @returns Whether the schema accepts it.
 */
function accepts(over: Record<string, unknown>): boolean {
  return mcpConfigSchema.safeParse(over).success;
}

describe("mcpConfigSchema defaults", () => {
  it("fills the token lifetimes the design fixes when the file is empty", () => {
    const config = mcpConfigSchema.parse({});
    expect(config.oauth).toEqual({
      access_token_ttl_seconds: 3600,
      refresh_token_ttl_seconds: 30 * 24 * 3600,
      grant_ttl_seconds: 365 * 24 * 3600,
      refresh_reuse_grace_seconds: 30,
    });
    expect(config.downstream_token_ttl_seconds).toBe(300);
  });

  it("fills the waits, the call timeout and the per-call bounds", () => {
    const config = mcpConfigSchema.parse({});
    expect(config.command_wait_ms).toBe(10_000);
    expect(config.call_timeout_ms).toBe(45_000);
    expect(config.task_query_max_ids).toBe(50);
    expect(config.read_canvas_max_nodes).toBe(500);
  });

  it("fills the capture limits", () => {
    expect(mcpConfigSchema.parse({}).view_capture).toEqual({
      max_edge_px: 1568,
      timeout_ms: 8000,
      max_bytes: 917_504,
    });
  });

  it("keeps command replies and capture results for ten minutes", () => {
    expect(mcpConfigSchema.parse({}).reply_ttl_seconds).toBe(600);
  });

  it("fills the personal access token cap and the rate limits", () => {
    const config = mcpConfigSchema.parse({});
    expect(config.pat.max_active_per_user).toBe(20);
    expect(config.rate_limit).toEqual({ commands_per_minute: 180, user_total_per_minute: 300 });
  });
});

describe("mcpConfigSchema relations", () => {
  it("refuses a capture timeout at or above the first call's wait, so a capture answers inside that wait", () => {
    expect(accepts({ command_wait_ms: 10_000, view_capture: { timeout_ms: 9999 } })).toBe(true);
    expect(accepts({ command_wait_ms: 10_000, view_capture: { timeout_ms: 10_000 } })).toBe(false);
    expect(accepts({ command_wait_ms: 5000, view_capture: { timeout_ms: 8000 } })).toBe(false);
  });

  it("refuses a first-call wait longer than the whole call's timeout", () => {
    expect(accepts({ command_wait_ms: 45_000, call_timeout_ms: 45_000 })).toBe(true);
    expect(accepts({ command_wait_ms: 45_001, call_timeout_ms: 45_000, view_capture: { timeout_ms: 8000 } })).toBe(false);
  });

  it("keeps a call inside the MCP SDK's default 60-second request timeout", () => {
    expect(accepts({ call_timeout_ms: 59_999 })).toBe(true);
    expect(accepts({ call_timeout_ms: 60_000 })).toBe(false);
  });

  it("refuses a refresh token that outlives its grant", () => {
    expect(accepts({ oauth: { refresh_token_ttl_seconds: 3600, grant_ttl_seconds: 3600 } })).toBe(true);
    expect(accepts({ oauth: { refresh_token_ttl_seconds: 3601, grant_ttl_seconds: 3600 } })).toBe(false);
  });

  it("keeps the refresh reuse grace within 0 to 60 seconds", () => {
    expect(accepts({ oauth: { refresh_reuse_grace_seconds: 0 } })).toBe(true);
    expect(accepts({ oauth: { refresh_reuse_grace_seconds: 60 } })).toBe(true);
    expect(accepts({ oauth: { refresh_reuse_grace_seconds: 61 } })).toBe(false);
    expect(accepts({ oauth: { refresh_reuse_grace_seconds: -1 } })).toBe(false);
  });

  it.each([
    ["a zero access token lifetime", { oauth: { access_token_ttl_seconds: 0 } }],
    ["a fractional wait", { command_wait_ms: 10.5 }],
    ["a negative id cap", { task_query_max_ids: -1 }],
    ["a zero token cap", { pat: { max_active_per_user: 0 } }],
    ["a zero rate limit", { rate_limit: { commands_per_minute: 0 } }],
    ["a zero capture size", { view_capture: { max_bytes: 0 } }],
    ["a zero reply lifetime", { reply_ttl_seconds: 0 }],
  ])("refuses %s", (_label, body) => {
    expect(accepts(body)).toBe(false);
  });
});

describe("getMcpConfig", () => {
  it("reads the tracked yaml with the design's start values", () => {
    const config = getMcpConfig();
    expect(config.oauth.access_token_ttl_seconds).toBe(3600);
    expect(config.oauth.refresh_token_ttl_seconds).toBe(2_592_000);
    expect(config.oauth.grant_ttl_seconds).toBe(31_536_000);
    expect(config.command_wait_ms).toBe(10_000);
    expect(config.call_timeout_ms).toBe(45_000);
    expect(config.view_capture.max_bytes).toBe(917_504);
    expect(config.reply_ttl_seconds).toBe(600);
  });

  it("parses the file once and hands back the same frozen object", () => {
    expect(getMcpConfig()).toBe(getMcpConfig());
    expect(Object.isFrozen(getMcpConfig())).toBe(true);
  });
});
