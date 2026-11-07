// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `GET /mini-tools/text/config` against the shipped `config/text-tools.yaml`
 * (inner#1860): the browser cuts its context window and refuses an
 * oversized selection by the same two numbers the server checks.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  checkRateLimit: async () => ({ allowed: true }),
  getRedis: () => ({}),
}));

vi.mock("@server/middleware/auth.js", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "user-1" });
    return next();
  },
}));

vi.mock("@server/modules", () => ({ textToolService: { executeTextTool: vi.fn() } }));

import { getModelForTool } from "@server/config/text-tools.js";
import { textToolsRoute } from "@server/routes/text-tools.js";

describe("the shipped text-tools config", () => {
  it("hands the browser two positive budgets, the selection's no larger than the context's, and a positive reveal speed", async () => {
    const res = await textToolsRoute.request("/config");

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { selectionMaxChars: unknown; contextMaxChars: unknown; revealCharsPerSecond: unknown } };
    expect(Object.keys(data).sort()).toEqual(["contextMaxChars", "revealCharsPerSecond", "selectionMaxChars"]);
    expect(Number.isInteger(data.revealCharsPerSecond) && (data.revealCharsPerSecond as number) > 0).toBe(true);
    expect(Number.isInteger(data.selectionMaxChars) && (data.selectionMaxChars as number) > 0).toBe(true);
    expect(Number.isInteger(data.contextMaxChars) && (data.contextMaxChars as number) > 0).toBe(true);
    expect(data.selectionMaxChars as number).toBeLessThanOrEqual(data.contextMaxChars as number);
  });

  it("runs every text tool on google/gemini-3.8-flash", () => {
    for (const tool of ["polish", "expand", "shorten", "translate", "rewrite", "custom"]) {
      expect(getModelForTool(tool), tool).toBe("google/gemini-3.8-flash");
    }
  });
});
