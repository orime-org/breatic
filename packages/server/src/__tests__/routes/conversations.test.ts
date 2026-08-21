// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";
import { getAgentConfig } from "@breatic/core";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };

describe("Conversation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationService.assertAccess.mockResolvedValue(undefined);
  });

  describe("GET /chat/conversations — list", () => {
    it("returns one page, and whether the list goes on past it", async () => {
      mocks.conversationService.list.mockResolvedValue({
        conversations: [
          { id: "22222222-2222-4222-8222-222222222222", title: "Chat 1" },
          { id: "conv-2", title: "Chat 2" },
        ],
        hasMore: true,
      });

      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations", { headers: AUTH });

      expect(res.status).toBe(200);
      const body = await res.json() as { data: { conversations: unknown[]; hasMore: boolean } };
      expect(body.data.conversations).toHaveLength(2);
      expect(body.data.hasMore).toBe(true);
      // A caller that names no window gets the configured page size. The size
      // is not the schema's to default, because the call that opens the panel
      // reads the same one and the two have to agree.
      expect(mocks.conversationService.list).toHaveBeenCalledWith(expect.any(String), {
        projectId: undefined,
        limit: getAgentConfig().conversation_page_size,
        // 不给位置就是第一页。位置说的是「上一页停在哪一行」,不是「跳过几行」。
        after: undefined,
      });
    });

    it("forwards project_id query to the service", async () => {
      mocks.conversationService.list.mockResolvedValue({ conversations: [], hasMore: false });
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
        after: undefined,
      });
    });

    it("rejects a malformed project_id with 422", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/chat/conversations?project_id=not-a-uuid",
        { headers: AUTH },
      );

      expect(res.status).toBe(422);
      expect(mocks.conversationService.list).not.toHaveBeenCalled();
    });
  });

  describe("GET /chat/conversations/:id — get with messages", () => {
    it("returns conversation with messages", async () => {
      // The shape the service actually returns. What was here before was a
      // flat `{ id, title, messages }` with message rows that had no parts --
      // a shape nothing produces, so the assertions on it said nothing about
      // this endpoint.
      mocks.conversationService.getWithMessages.mockResolvedValue({
        conversation: {
          id: "22222222-2222-4222-8222-222222222222",
          title: "Chat 1",
        },
        messages: [
          {
            id: "row-1",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
            content: "hi",
            ts: "2026-08-19T00:00:00Z",
            turnIndex: 1,
          },
        ],
        hasMore: false,
      });

      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations/22222222-2222-4222-8222-222222222222", { headers: AUTH });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { conversation: { id: string }; messages: unknown[] };
      };
      expect(body.data.conversation.id).toBe("22222222-2222-4222-8222-222222222222");
      expect(body.data.messages).toHaveLength(1);
    });
  });

  describe("DELETE /chat/conversations/:id — soft delete", () => {
    it("soft-deletes and returns 200", async () => {
      mocks.conversationService.deleteConversation.mockResolvedValue(undefined);

      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations/22222222-2222-4222-8222-222222222222", {
        method: "DELETE",
        headers: AUTH,
      });

      expect(res.status).toBe(200);
      expect(mocks.conversationService.deleteConversation).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", "user-1");
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
