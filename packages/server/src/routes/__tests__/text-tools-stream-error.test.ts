// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: logged,
}));

vi.mock("@server/middleware/auth.js", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "user-1" });
    return next();
  },
}));

const service = vi.hoisted(() => ({ executeTextTool: vi.fn() }));
vi.mock("@server/modules", () => ({ textToolService: service }));

import { textToolsRoute } from "@server/routes/text-tools.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("text tools stream", () => {
  it("records a failure thrown by the tool run as an error log", async () => {
    const failure = new Error("model call failed");
    // eslint-disable-next-line require-yield -- a run that fails before its first event
    service.executeTextTool.mockImplementation(async function* () {
      throw failure;
    });

    const res = await textToolsRoute.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "generate", instructions: "write a line" }),
    });
    await res.text();

    expect(logged.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure, userId: "user-1", tool: "generate" }),
      "text_tool_stream_failed",
    );
  });
});
