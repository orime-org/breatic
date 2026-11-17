// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The text tool's door on the payer's own key (inner#1953): when whoever pays for the project's Studio brought an
 * OpenRouter key, the route admits the run on that key whatever the Studio's credit balance, judges whether the tool's
 * model can be served on that key rather than on the deployment's, and hands the run the keys it settled. On our keys
 * the balance is checked and servability judged as before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = { owner: "account" as const, keyOf: (upstream: string) => (upstream === "openrouter" ? "sk-or-v1-route-key" : undefined) };
const DEPLOYMENT = { owner: "deployment" as const, keyOf: () => undefined };

const h = vi.hoisted(() => ({
  resolveKeys: vi.fn(),
  precheckCredits: vi.fn(async () => undefined),
  assertLlmServable: vi.fn(),
  executeTextTool: vi.fn(),
}));

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

vi.mock("@breatic/domain", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveKeys: h.resolveKeys,
}));

vi.mock("@server/modules", () => ({
  textToolService: { executeTextTool: h.executeTextTool },
  projectService: { assertAccess: async () => undefined },
  precheckCredits: h.precheckCredits,
}));

vi.mock("@server/modules/task/model-servable.js", () => ({ assertLlmServable: h.assertLlmServable }));

import { textToolsRoute } from "@server/routes/text-tools.js";

const PID = "11111111-1111-4111-8111-111111111111";
const BODY = JSON.stringify({ tool: "generate", instructions: "write a line", project_id: PID });

/**
 * Send one run and read it to its end.
 * @returns The response's status.
 */
async function send(): Promise<number> {
  const res = await textToolsRoute.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: BODY });
  await res.text();
  return res.status;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.precheckCredits.mockResolvedValue(undefined);
  h.executeTextTool.mockImplementation(async function* () {
    yield { type: "done", tokens: 0, creditsUsed: "0.000000" };
  });
});

describe("a text-tool run on the payer's OpenRouter key", () => {
  it("is admitted without a balance check, judged servable on that key, and runs on the keys the route settled", async () => {
    const resolved = { keys: ACCOUNT, keyId: "key-1", route: { mode: "default" } };
    h.resolveKeys.mockResolvedValue(resolved);
    h.precheckCredits.mockRejectedValue(Object.assign(new Error("no credits"), { statusCode: 402 }));

    expect(await send()).toBe(200);

    expect(h.resolveKeys).toHaveBeenCalledWith({ projectId: PID }, { kind: "llm" });
    expect(h.precheckCredits).not.toHaveBeenCalled();
    expect(h.assertLlmServable).toHaveBeenCalledWith(expect.any(String), "call", undefined, ACCOUNT);
    expect(h.executeTextTool.mock.calls[0]?.[6]).toBe(resolved);
  });

  it("on our keys checks the balance and judges servability as before", async () => {
    h.resolveKeys.mockResolvedValue({ keys: DEPLOYMENT, keyId: null, route: { mode: "default" } });

    expect(await send()).toBe(200);

    expect(h.precheckCredits).toHaveBeenCalledTimes(1);
    expect(h.assertLlmServable).toHaveBeenCalledWith(expect.any(String), "call");
  });
});
