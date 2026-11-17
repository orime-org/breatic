// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: logged,
  // The route is rate limited (inner#1860); whether a request is throttled is
  // not this file's subject, so every request is admitted.
  checkRateLimit: async () => ({ allowed: true }),
  getRedis: () => ({}),
}));

vi.mock("@server/middleware/auth.js", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "user-1" });
    return next();
  },
}));

const service = vi.hoisted(() => ({ executeTextTool: vi.fn() }));
// The caller is an editor of the project and its studio can pay (inner#1860).
vi.mock("@server/modules", () => ({
  textToolService: service,
  projectService: { assertAccess: async () => undefined },
  precheckCredits: async () => undefined,
}));

// Whether this deployment can serve the tool's model is not this file's subject either.
vi.mock("@server/modules/task/model-servable.js", () => ({ assertLlmServable: () => undefined }));

import { textToolsRoute } from "@server/routes/text-tools.js";

const PID = "11111111-1111-4111-8111-111111111111";
const BODY = JSON.stringify({ tool: "generate", instructions: "write a line", project_id: PID });

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
      body: BODY,
    });
    await res.text();

    expect(logged.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure, userId: "user-1", tool: "generate" }),
      "text_tool_stream_failed",
    );
  });

  it("ends the stream with an error event when the run throws", async () => {
    // Without a closing event the browser cannot tell a failed run from a
    // dropped connection (inner#1860 F22).
    service.executeTextTool.mockImplementation(async function* () {
      yield { type: "text_delta", text: "half" };
      throw new Error("model call failed");
    });

    const res = await textToolsRoute.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: BODY,
    });
    const body = await res.text();

    const events = [...body.matchAll(/^event: ?(.*)$/gm)].map((m) => m[1]);
    expect(events.at(-1)).toBe("error");
  });
});

describe("text tools stream when the client leaves before anything is read", () => {
  /**
   * A run that streams until its signal is raised, then reports the stop the
   * way the real one does and counts that it got that far.
   * @returns The signal each run was handed, and how many runs reached their end.
   */
  function stoppableRun(): { ended: { count: number }; signals: AbortSignal[] } {
    const ended = { count: 0 };
    const signals: AbortSignal[] = [];
    service.executeTextTool.mockImplementation(async function* (
      _user: string,
      _project: string,
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
      body: BODY,
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
      body: BODY,
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
