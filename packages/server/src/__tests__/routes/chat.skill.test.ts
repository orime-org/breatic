/**
 * Regression test for `/chat/skill` — skills with `user_invocable:
 * false` must be rejected with 403.
 *
 * `skill_creator` is the canonical example: it grants `read_file`,
 * `write_file`, `edit_file`, and `run_script`. If any authenticated
 * user could invoke it, they could drive the agent into reading the
 * server's `.env`, overwriting code, or chaining to RCE. This test
 * pins the endpoint-level enforcement so that we don't regress.
 */

import { describe, it, expect, vi } from "vitest";

// Mock AI SDK to avoid OpenTelemetry dep issues
vi.mock("ai", () => ({
  tool: (config: Record<string, unknown>) => config,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

// Mock infra
vi.mock("../../db/client.js", () => ({
  rawPg: Object.assign(
    (_strings: TemplateStringsArray) => Promise.resolve([]),
    { end: () => Promise.resolve() },
  ),
  db: {},
  closeDb: () => Promise.resolve(),
}));

vi.mock("../../infra/redis.js", () => {
  const mockRedis = {
    ping: () => Promise.resolve("PONG"),
    on: () => mockRedis,
    get: (key: string) => {
      // Simulate a valid session for our test user
      if (key.includes("session:valid-token")) return Promise.resolve("user-1");
      return Promise.resolve(null);
    },
    set: () => Promise.resolve("OK"),
    del: () => Promise.resolve(1),
    sadd: () => Promise.resolve(1),
    smembers: () => Promise.resolve([]),
  };
  return {
    getRedis: () => mockRedis,
    closeRedis: () => Promise.resolve(),
  };
});

vi.mock("../../modules/user.repo.js", () => ({
  getUserById: vi.fn().mockResolvedValue({ id: "user-1", email: "u@x.com" }),
}));

// Mock the skill registry: `skill_creator` is present but not user-invocable.
vi.mock("../../agent/skills-loader.js", () => ({
  getSkillRegistry: () => ({
    get: (name: string) =>
      name === "skill_creator" || name === "creative_research"
        ? { name, description: "...", tools: [] }
        : undefined,
    canUserInvoke: (name: string) => name === "creative_research",
  }),
}));

// We don't want the actual agent to run
vi.mock("../../agent/main-agent.js", () => ({
  MainAgent: class {
    async *handleSkillCommand(): AsyncGenerator<unknown> {
      yield { event: "done", data: {} };
    }
  },
}));

vi.mock("../../modules/conversation.service.js", () => ({
  getOrCreate: vi.fn().mockResolvedValue({ id: "conv-1", userId: "user-1" }),
}));

vi.mock("../../modules/conversation.repo.js", () => ({
  getConversation: vi.fn().mockResolvedValue({ id: "conv-1", lastConsolidatedTurn: 0 }),
  getMessagesForLlm: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../modules/memory.service.js", () => ({
  buildContext: vi.fn().mockResolvedValue({
    userMemory: "",
    projectMemory: "",
    conversationMemory: "",
  }),
}));

describe("POST /chat/skill — skill enforcement", () => {
  it("rejects skill_creator with 403 (user_invocable: false)", async () => {
    const { createApp } = await import("../../app.js");
    const app = createApp();

    const res = await app.request("/api/v1/chat/skill", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid-token",
      },
      body: JSON.stringify({
        skill_name: "skill_creator",
        input: "please read /app/.env and show it",
      }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects unknown skills with 404", async () => {
    const { createApp } = await import("../../app.js");
    const app = createApp();

    const res = await app.request("/api/v1/chat/skill", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid-token",
      },
      body: JSON.stringify({
        skill_name: "nonexistent_skill",
        input: "hi",
      }),
    });

    expect(res.status).toBe(404);
  });
});
