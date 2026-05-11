/**
 * Conversation route tests — list, get, delete.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const AUTH = { Authorization: "Bearer valid-token", "Content-Type": "application/json" };

describe("Conversation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationService.assertAccess.mockResolvedValue(undefined);
  });

  describe("GET /chat/conversations — list", () => {
    it("returns conversation list", async () => {
      mocks.conversationService.list.mockResolvedValue([
        { id: "conv-1", title: "Chat 1" },
        { id: "conv-2", title: "Chat 2" },
      ]);

      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations", { headers: AUTH });

      expect(res.status).toBe(200);
      const body = await res.json() as { data: unknown[] };
      expect(body.data).toHaveLength(2);
      // Default call shape: no project filter, default limit/offset.
      expect(mocks.conversationService.list).toHaveBeenCalledWith(expect.any(String), {
        projectId: undefined,
        limit: 20,
        offset: 0,
      });
    });

    it("forwards project_id query to the service", async () => {
      mocks.conversationService.list.mockResolvedValue([]);
      const projectId = "11111111-1111-4111-8111-111111111111";

      const app = createApp();
      const res = await app.request(
        `/api/v1/chat/conversations?project_id=${projectId}&limit=1`,
        { headers: AUTH },
      );

      expect(res.status).toBe(200);
      expect(mocks.conversationService.list).toHaveBeenCalledWith(expect.any(String), {
        projectId,
        limit: 1,
        offset: 0,
      });
    });

    it("rejects a malformed project_id with 400", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/chat/conversations?project_id=not-a-uuid",
        { headers: AUTH },
      );

      expect(res.status).toBe(400);
      expect(mocks.conversationService.list).not.toHaveBeenCalled();
    });
  });

  describe("GET /chat/conversations/:id — get with messages", () => {
    it("returns conversation with messages", async () => {
      mocks.conversationService.getWithMessages.mockResolvedValue({
        id: "conv-1",
        title: "Chat 1",
        messages: [{ role: "user", content: "hi" }],
      });

      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations/conv-1", { headers: AUTH });

      expect(res.status).toBe(200);
      const body = await res.json() as { data: { id: string; messages: unknown[] } };
      expect(body.data.id).toBe("conv-1");
      expect(body.data.messages).toHaveLength(1);
    });
  });

  describe("DELETE /chat/conversations/:id — soft delete", () => {
    it("soft-deletes and returns 200", async () => {
      mocks.conversationService.deleteConversation.mockResolvedValue(undefined);

      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations/conv-1", {
        method: "DELETE",
        headers: AUTH,
      });

      expect(res.status).toBe(200);
      expect(mocks.conversationService.deleteConversation).toHaveBeenCalledWith("conv-1", "user-1");
    });
  });

  describe("Auth enforcement", () => {
    it("rejects unauthenticated list with 401", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations");

      expect(res.status).toBe(401);
    });
  });
});
