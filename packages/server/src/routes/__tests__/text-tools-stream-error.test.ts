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

describe("text tools stream when the client leaves before anything is read", () => {
  /**
   * A run that streams until its signal is raised, then reports the stop the
   * way the real one does and counts that it got that far.
   * @returns The mock's run and how many runs reached their end.
   */
  function stoppableRun(): { ended: { count: number }; signals: AbortSignal[] } {
    const ended = { count: 0 };
    const signals: AbortSignal[] = [];
    service.executeTextTool.mockImplementation(async function* (
      _user: string,
      _tool: string,
      _params: unknown,
      signal: AbortSignal,
    ) {
      signals.push(signal);
      // The model can have said a word before the stop is noticed.
      do {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield { type: "text_delta", text: "." };
      } while (!signal.aborted);
      yield { type: "aborted", tokens: 0, creditsUsed: 0 };
      ended.count += 1;
    });
    return { ended, signals };
  }

  it("stops and finishes the run of a client already gone", async () => {
    const { ended, signals } = stoppableRun();
    const gone = new AbortController();
    gone.abort();

    const res = await textToolsRoute.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "generate", instructions: "write a line" }),
      signal: gone.signal,
    });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(signals[0]?.aborted).toBe(true);
    expect(ended.count).toBe(1);
  });

  it("stops and finishes the run when the request is aborted unread", async () => {
    const { ended, signals } = stoppableRun();
    const leaving = new AbortController();

    const res = await textToolsRoute.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "generate", instructions: "write a line" }),
      signal: leaving.signal,
    });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signals[0]?.aborted).toBe(false);

    leaving.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(signals[0]?.aborted).toBe(true);
    expect(ended.count).toBe(1);
  });
});
