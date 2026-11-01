// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A `config/text-tools.yaml` whose selection budget exceeds its context budget
 * is refused by the loader (inner#1860): a selection allowed past the window
 * it is cut from cannot be sent with its context.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { cpSync, mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { parse, stringify } = await import("yaml");
  const root = mkdtempSync(join(tmpdir(), "text-tools-invalid-"));
  cpSync(join(actual.MONOREPO_ROOT as string, "config"), join(root, "config"), { recursive: true });
  const file = join(root, "config", "text-tools.yaml");
  const shipped = parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  writeFileSync(file, stringify({ ...shipped, selection_max_chars: 200, context_max_chars: 100 }));
  return {
    ...actual,
    MONOREPO_ROOT: root,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    checkRateLimit: async () => ({ allowed: true }),
    getRedis: () => ({}),
  };
});

vi.mock("@server/middleware/auth.js", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "user-1" });
    return next();
  },
}));

vi.mock("@server/modules", () => ({ textToolService: { executeTextTool: vi.fn() } }));

import { textToolsRoute } from "@server/routes/text-tools.js";

describe("a selection budget larger than the context budget", () => {
  it("fails to load, so the budgets are never served", async () => {
    const res = await textToolsRoute.request("/config");

    expect(res.status).toBe(500);
  });
});
