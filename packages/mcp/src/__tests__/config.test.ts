// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { parseMcpEnv } from "@mcp/config.js";

const SECRET = { MCP_CLIENT_SECRET: "s3cret" };

describe("parseMcpEnv", () => {
  it("starts without the database settings the other services need", () => {
    const env = parseMcpEnv({ ...SECRET });
    expect(env).toEqual({
      ENV: "dev",
      DEBUG: false,
      REDIS_MCP_URL: "redis://localhost:6379/4",
      REDIS_KEY_PREFIX: "dev",
      MCP_PORT: 3003,
      MCP_HEALTH_PORT: 3004,
      MCP_PUBLIC_URL: "http://localhost:3003/mcp",
      MCP_API_BASE_URL: "http://localhost:3000/api/v1",
      MCP_CLIENT_SECRET: "s3cret",
      OAUTH_ISSUER: "http://localhost:3000",
    });
  });

  it("builds keys under the environment name when the prefix is blank, as core does", () => {
    expect(parseMcpEnv({ ...SECRET, ENV: "staging", REDIS_KEY_PREFIX: "  " }).REDIS_KEY_PREFIX).toBe("staging");
    expect(parseMcpEnv({ ...SECRET, REDIS_KEY_PREFIX: " wt-agent " }).REDIS_KEY_PREFIX).toBe("wt-agent");
  });

  it("refuses a prefix that would break channel patterns", () => {
    expect(() => parseMcpEnv({ ...SECRET, REDIS_KEY_PREFIX: "a*b" })).toThrow(/REDIS_KEY_PREFIX/);
  });

  it("takes a blank port as unset", () => {
    expect(parseMcpEnv({ ...SECRET, MCP_PORT: "", MCP_HEALTH_PORT: "3104" })).toMatchObject({ MCP_PORT: 3003, MCP_HEALTH_PORT: 3104 });
  });

  it("refuses to start without the client secret every call exchanges tokens with", () => {
    expect(() => parseMcpEnv({})).toThrow(/MCP_CLIENT_SECRET must be set/);
    expect(() => parseMcpEnv({ MCP_CLIENT_SECRET: "   " })).toThrow(/MCP_CLIENT_SECRET must be set/);
  });
});
