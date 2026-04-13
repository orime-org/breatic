/**
 * Cross-tenant ownership tests for REST routes.
 *
 * Pins the behavior that client-supplied `project_id` / `conversation_id`
 * cannot be used to reach another user's data or inject content into
 * another user's canvas. Each suite targets one route and asserts
 * that a ForbiddenError from `projectService.assertAccess` (resp.
 * `conversationService.assertAccess`) propagates to a 403 response
 * BEFORE any write / enqueue / publish side effect runs.
 *
 * The test uses Hono's in-process client and a comprehensive mock
 * layer so no real DB, Redis, or BullMQ is involved.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenError } from "@breatic/core";

// AI SDK boilerplate mocks
vi.mock("ai", () => ({
  tool: (config: Record<string, unknown>) => config,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
}));

// Infra mocks
vi.mock("../../db/client.js", () => ({
  rawPg: Object.assign(
    (_s: TemplateStringsArray) => Promise.resolve([]),
    { end: () => Promise.resolve() },
  ),
  db: {},
  closeDb: () => Promise.resolve(),
}));

vi.mock("../../infra/redis.js", () => {
  const mockRedis = {
    ping: () => Promise.resolve("PONG"),
    on: () => mockRedis,
    get: (key: string) =>
      key.includes("session:valid-token") ? Promise.resolve("user-1") : Promise.resolve(null),
    set: () => Promise.resolve("OK"),
    del: () => Promise.resolve(1),
    sadd: () => Promise.resolve(1),
    smembers: () => Promise.resolve([]),
  };
  return { getRedis: () => mockRedis, closeRedis: () => Promise.resolve() };
});

vi.mock("@breatic/core", async (importOriginal) => { const actual = await importOriginal() as Record<string, unknown>; return { ...actual, // FIXME: specific mock }; }); // was: user.repo.js", () => ({
  getUserById: vi.fn().mockResolvedValue({ id: "user-1", email: "u@x.com" }),
}));

// ── Services we assert on ───────────────────────────────────────────
const assertProjectAccess = vi.fn();
vi.mock("@breatic/core", async (importOriginal) => { const actual = await importOriginal() as Record<string, unknown>; return { ...actual, // FIXME: specific mock }; }); // was: project.service.js", () => ({
  assertAccess: (...args: unknown[]) => assertProjectAccess(...args),
  get: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  saveCanvas: vi.fn(),
  deleteProject: vi.fn(),
}));

const assertConversationAccess = vi.fn();
vi.mock("@breatic/core", async (importOriginal) => { const actual = await importOriginal() as Record<string, unknown>; return { ...actual, // FIXME: specific mock }; }); // was: conversation.service.js", () => ({
  assertAccess: (...args: unknown[]) => assertConversationAccess(...args),
  getOrCreate: vi.fn().mockResolvedValue({ id: "conv-1", userId: "user-1" }),
  list: vi.fn(),
  getWithMessages: vi.fn(),
  deleteConversation: vi.fn(),
}));

// Stub the downstream services so we can prove they are NOT called
// when assertAccess rejects.
const taskCreate = vi.fn();
const taskSetJobId = vi.fn();
vi.mock("@breatic/core", async (importOriginal) => { const actual = await importOriginal() as Record<string, unknown>; return { ...actual, // FIXME: specific mock }; }); // was: task.service.js", () => ({
  create: (...args: unknown[]) => taskCreate(...args),
  setJobId: (...args: unknown[]) => taskSetJobId(...args),
  list: vi.fn(),
  markRunning: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  setResolvedSkills: vi.fn(),
}));

const nodeHistoryList = vi.fn();
vi.mock("@breatic/core", async (importOriginal) => { const actual = await importOriginal() as Record<string, unknown>; return { ...actual, // FIXME: specific mock }; }); // was: node-history.service.js", () => ({
  listByNode: (...args: unknown[]) => nodeHistoryList(...args),
  recordGenerationFailure: vi.fn(),
  recordGenerationSuccess: vi.fn(),
  recordUpload: vi.fn(),
}));

const attachmentList = vi.fn().mockResolvedValue([]);
vi.mock("@breatic/core", async (importOriginal) => { const actual = await importOriginal() as Record<string, unknown>; return { ...actual, // FIXME: specific mock }; }); // was: conversation-attachment.service.js", () => ({
  listByConversation: (...args: unknown[]) => attachmentList(...args),
  create: vi.fn(),
  softDelete: vi.fn(),
}));

const uploadPrepare = vi.fn().mockResolvedValue({
  upload_id: "u1",
  upload_url: "http://x/u1",
  key: "k",
});
vi.mock("@breatic/core", async (importOriginal) => { const actual = await importOriginal() as Record<string, unknown>; return { ...actual, // FIXME: specific mock }; }); // was: upload.service.js", () => ({
  prepare: (...args: unknown[]) => uploadPrepare(...args),
  loadTicket: vi.fn(),
  consumeTicket: vi.fn(),
}));

// BullMQ queue - prevent real connection
vi.mock("../../infra/queue.js", () => ({
  createQueue: () => ({ add: vi.fn().mockResolvedValue({ id: "job-1" }) }),
  defaultJobOpts: () => ({}),
}));

// Canvas lock + event publish: we want to prove these are skipped on
// ForbiddenError.
const acquireNodeLock = vi.fn().mockResolvedValue(true);
const releaseNodeLock = vi.fn();
vi.mock("../../infra/canvas-lock.js", () => ({
  acquireNodeLock: (...args: unknown[]) => acquireNodeLock(...args),
  releaseNodeLock: (...args: unknown[]) => releaseNodeLock(...args),
}));

const publishNodeEvent = vi.fn();
vi.mock("../../infra/event-stream.js", () => ({
  publishNodeEvent: (...args: unknown[]) => publishNodeEvent(...args),
}));

// Memory / conversation history mocks so chat handler boots
vi.mock("@breatic/core", async (importOriginal) => { const actual = await importOriginal() as Record<string, unknown>; return { ...actual, // FIXME: specific mock }; }); // was: memory.service.js", () => ({
  buildContext: vi.fn().mockResolvedValue({
    userMemory: "",
    projectMemory: "",
    conversationMemory: "",
  }),
}));

vi.mock("@breatic/core", async (importOriginal) => { const actual = await importOriginal() as Record<string, unknown>; return { ...actual, // FIXME: specific mock }; }); // was: conversation.repo.js", () => ({
  getConversation: vi.fn().mockResolvedValue({ id: "conv-1", lastConsolidatedTurn: 0 }),
  getMessagesForLlm: vi.fn().mockResolvedValue([]),
}));

// Agent should never actually run in these tests
vi.mock("../../agent/main-agent.js", () => ({
  MainAgent: class {
    async *chat(): AsyncGenerator<unknown> {
      yield { event: "done", data: {} };
    }
    async *handleSkillCommand(): AsyncGenerator<unknown> {
      yield { event: "done", data: {} };
    }
  },
}));

vi.mock("../../agent/skills-loader.js", () => ({
  getSkillRegistry: () => ({
    get: () => ({ name: "x", description: "x", tools: [] }),
    canUserInvoke: () => true,
  }),
}));

// ─────────────────────────────────────────────────────────────────
beforeEach(() => {
  assertProjectAccess.mockReset();
  assertConversationAccess.mockReset();
  taskCreate.mockReset();
  nodeHistoryList.mockReset();
  attachmentList.mockReset().mockResolvedValue([]);
  uploadPrepare.mockReset().mockResolvedValue({
    upload_id: "u1",
    upload_url: "http://x/u1",
    key: "k",
  });
  acquireNodeLock.mockReset().mockResolvedValue(true);
  publishNodeEvent.mockReset();
});

async function buildApp() {
  const { createApp } = await import("../../app.js");
  return createApp();
}

const AUTH = { Authorization: "Bearer valid-token", "Content-Type": "application/json" };

// ── POST /canvas/tasks ─────────────────────────────────────────────
describe("POST /canvas/tasks — project_id ownership", () => {
  it("rejects with 403 when the caller does not own the project", async () => {
    assertProjectAccess.mockRejectedValue(new ForbiddenError("nope"));

    const app = await buildApp();
    const res = await app.request("/api/v1/canvas/tasks", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        project_id: "11111111-1111-4111-8111-111111111111",
        task_type: "image",
        params: { prompt: "hi", node_id: "n-1" },
        model: "nano-banana-2",
      }),
    });

    expect(res.status).toBe(403);
    expect(assertProjectAccess).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "user-1",
    );
    // Critical: no task created, no lock taken, no event published.
    expect(taskCreate).not.toHaveBeenCalled();
    expect(acquireNodeLock).not.toHaveBeenCalled();
    expect(publishNodeEvent).not.toHaveBeenCalled();
  });
});

// ── GET /canvas/nodes/:nodeId/history ──────────────────────────────
describe("GET /canvas/nodes/:nodeId/history — project_id ownership", () => {
  it("rejects with 403 when the caller does not own the project", async () => {
    assertProjectAccess.mockRejectedValue(new ForbiddenError("nope"));

    const app = await buildApp();
    const res = await app.request(
      "/api/v1/canvas/nodes/n-1/history?project_id=11111111-1111-4111-8111-111111111111",
      { headers: AUTH },
    );

    expect(res.status).toBe(403);
    expect(nodeHistoryList).not.toHaveBeenCalled();
  });
});

// ── POST /assets/upload/prepare ────────────────────────────────────
describe("POST /assets/upload/prepare — project + conversation ownership", () => {
  it("rejects with 403 when the caller does not own the canvas project", async () => {
    assertProjectAccess.mockRejectedValue(new ForbiddenError("nope"));

    const app = await buildApp();
    const res = await app.request("/api/v1/assets/upload/prepare", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        filename: "a.png",
        content_type: "image/png",
        size: 123,
        context: "canvas",
        project_id: "11111111-1111-4111-8111-111111111111",
        node_id: "n-1",
      }),
    });

    expect(res.status).toBe(403);
    expect(uploadPrepare).not.toHaveBeenCalled();
    expect(acquireNodeLock).not.toHaveBeenCalled();
    expect(publishNodeEvent).not.toHaveBeenCalled();
  });

  it("rejects with 403 when the caller does not own the agent conversation", async () => {
    assertProjectAccess.mockResolvedValue(undefined);
    assertConversationAccess.mockRejectedValue(new ForbiddenError("nope"));

    const app = await buildApp();
    const res = await app.request("/api/v1/assets/upload/prepare", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        filename: "a.png",
        content_type: "image/png",
        size: 123,
        context: "agent",
        project_id: "11111111-1111-4111-8111-111111111111",
        conversation_id: "22222222-2222-4222-8222-222222222222",
      }),
    });

    expect(res.status).toBe(403);
    expect(uploadPrepare).not.toHaveBeenCalled();
  });
});

// ── GET /chat/conversations/:id/attachments ────────────────────────
describe("GET /chat/conversations/:id/attachments — conversation ownership", () => {
  it("rejects with 403 when the caller does not own the conversation", async () => {
    assertConversationAccess.mockRejectedValue(new ForbiddenError("nope"));

    const app = await buildApp();
    const res = await app.request(
      "/api/v1/chat/conversations/22222222-2222-4222-8222-222222222222/attachments",
      { headers: AUTH },
    );

    expect(res.status).toBe(403);
    expect(attachmentList).not.toHaveBeenCalled();
  });
});
