// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The two routes that write a conversation's own record: creating one on
 * purpose, and giving it a name.
 *
 * Both are new. Until now a conversation could only appear as a side effect of
 * opening chat in a project that had none, and nothing anywhere could change a
 * title — which is why every conversation in the product is called the same
 * thing.
 *
 * What these tests pin is the shape of the request, not the business rule: the
 * rule (who may write to a conversation) belongs to the service and is pinned
 * in the integration suite, where a real database can tell a stranger's id from
 * a missing one.
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

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const PROJECT = "11111111-1111-4111-8111-111111111111";

describe("Conversation write routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /chat/conversations — start one on purpose", () => {
    it("creates one in the named project and answers with it", async () => {
      mocks.conversationService.createConversation.mockResolvedValue({
        id: "conv-new",
        title: null,
        projectId: PROJECT,
      });

      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ project_id: PROJECT }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string } };
      expect(body.data.id).toBe("conv-new");
      expect(mocks.conversationService.createConversation).toHaveBeenCalledWith(
        "user-1",
        PROJECT,
      );
    });

    it("refuses a body with no project to put it in", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(422);
      expect(mocks.conversationService.createConversation).not.toHaveBeenCalled();
    });

    it("refuses a project id that is not one", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ project_id: "not-a-uuid" }),
      });

      expect(res.status).toBe(422);
      expect(mocks.conversationService.createConversation).not.toHaveBeenCalled();
    });

    it("rejects an unauthenticated create with 401", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: PROJECT }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /chat/conversations/:id — give it a name", () => {
    it("renames it and answers with the conversation", async () => {
      mocks.conversationService.rename.mockResolvedValue({
        id: "conv-1",
        title: "Storyboard notes",
        projectId: PROJECT,
      });

      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations/conv-1", {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ project_id: PROJECT, title: "Storyboard notes" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { title: string } };
      expect(body.data.title).toBe("Storyboard notes");
      expect(mocks.conversationService.rename).toHaveBeenCalledWith(
        "conv-1",
        "user-1",
        PROJECT,
        "Storyboard notes",
      );
    });

    it("refuses a rename that does not say which project it is in", async () => {
      // Without it the service cannot ask the second of the three questions it
      // has to ask before writing, so the route must not let the request past.
      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations/conv-1", {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ title: "Storyboard notes" }),
      });

      expect(res.status).toBe(422);
      expect(mocks.conversationService.rename).not.toHaveBeenCalled();
    });

    it("refuses an empty name", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations/conv-1", {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ project_id: PROJECT, title: "" }),
      });

      expect(res.status).toBe(422);
      expect(mocks.conversationService.rename).not.toHaveBeenCalled();
    });

    it("refuses a name that is only spaces", async () => {
      // A row in the list showing nothing at all is worse than the default
      // title, and the reader cannot tell it apart from a rendering fault.
      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations/conv-1", {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ project_id: PROJECT, title: "   " }),
      });

      expect(res.status).toBe(422);
      expect(mocks.conversationService.rename).not.toHaveBeenCalled();
    });

    it("rejects an unauthenticated rename with 401", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/chat/conversations/conv-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: PROJECT, title: "Storyboard notes" }),
      });

      expect(res.status).toBe(401);
    });
  });
});
