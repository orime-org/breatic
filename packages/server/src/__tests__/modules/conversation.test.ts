/**
 * Conversation service unit tests.
 *
 * Mocks conversationRepo to test business logic and ownership checks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing service
vi.mock("../../modules/conversation.repo.js", () => ({
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  listConversations: vi.fn(),
  getMessages: vi.fn(),
  softDeleteConversation: vi.fn(),
  setProjectId: vi.fn(),
}));

import * as conversationService from "../../modules/conversation.service.js";
import * as conversationRepo from "../../modules/conversation.repo.js";
import { NotFoundError, ForbiddenError } from "../../errors.js";

const mockConversation = {
  id: "conv-1",
  userId: "user-1",
  title: "Test conversation",
  projectId: null,
  lastConsolidatedTurn: 0,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockMessages = [
  { role: "user" as const, content: "Hello", ts: new Date().toISOString(), turnIndex: 1 },
  { role: "assistant" as const, content: "Hi there", ts: new Date().toISOString(), turnIndex: 1 },
];

describe("conversation.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getOrCreate", () => {
    it("should create a new conversation when no conversationId is provided", async () => {
      vi.mocked(conversationRepo.createConversation).mockResolvedValue(mockConversation);

      const result = await conversationService.getOrCreate(
        "user-1",
        undefined,
        "Hello world, this is a test message",
      );

      expect(result.id).toBe("conv-1");
      expect(conversationRepo.createConversation).toHaveBeenCalledWith(
        "user-1",
        "Hello world, this is a test message",
      );
    });

    it("should truncate title to 100 characters for new conversations", async () => {
      vi.mocked(conversationRepo.createConversation).mockResolvedValue(mockConversation);

      const longMessage = "A".repeat(200);
      await conversationService.getOrCreate("user-1", undefined, longMessage);

      expect(conversationRepo.createConversation).toHaveBeenCalledWith(
        "user-1",
        "A".repeat(100),
      );
    });

    it("should set projectId when provided for new conversations", async () => {
      vi.mocked(conversationRepo.createConversation).mockResolvedValue(mockConversation);
      vi.mocked(conversationRepo.setProjectId).mockResolvedValue(undefined);

      const result = await conversationService.getOrCreate(
        "user-1",
        undefined,
        "Hello",
        "proj-1",
      );

      expect(conversationRepo.setProjectId).toHaveBeenCalledWith("conv-1", "proj-1");
      expect(result.projectId).toBe("proj-1");
    });

    it("should validate ownership when conversationId is provided", async () => {
      vi.mocked(conversationRepo.getConversation).mockResolvedValue(mockConversation);

      const result = await conversationService.getOrCreate(
        "user-1",
        "conv-1",
        "ignored message",
      );

      expect(result.id).toBe("conv-1");
      expect(conversationRepo.createConversation).not.toHaveBeenCalled();
    });

    it("should throw NotFoundError when conversationId does not exist", async () => {
      vi.mocked(conversationRepo.getConversation).mockResolvedValue(null);

      await expect(
        conversationService.getOrCreate("user-1", "conv-nonexistent", "hello"),
      ).rejects.toThrow(NotFoundError);
    });

    it("should throw ForbiddenError when user does not own conversation", async () => {
      vi.mocked(conversationRepo.getConversation).mockResolvedValue(mockConversation);

      await expect(
        conversationService.getOrCreate("user-other", "conv-1", "hello"),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("list", () => {
    it("should delegate to repo with correct parameters", async () => {
      vi.mocked(conversationRepo.listConversations).mockResolvedValue([mockConversation]);

      const result = await conversationService.list("user-1", 10, 5);

      expect(result).toEqual([mockConversation]);
      expect(conversationRepo.listConversations).toHaveBeenCalledWith("user-1", 10, 5);
    });
  });

  describe("getWithMessages", () => {
    it("should return conversation and messages for valid owner", async () => {
      vi.mocked(conversationRepo.getConversation).mockResolvedValue(mockConversation);
      vi.mocked(conversationRepo.getMessages).mockResolvedValue(mockMessages);

      const result = await conversationService.getWithMessages("conv-1", "user-1");

      expect(result.conversation.id).toBe("conv-1");
      expect(result.messages).toEqual(mockMessages);
    });

    it("should throw NotFoundError when conversation does not exist", async () => {
      vi.mocked(conversationRepo.getConversation).mockResolvedValue(null);

      await expect(
        conversationService.getWithMessages("conv-nonexistent", "user-1"),
      ).rejects.toThrow(NotFoundError);
    });

    it("should throw ForbiddenError when user does not own conversation", async () => {
      vi.mocked(conversationRepo.getConversation).mockResolvedValue(mockConversation);

      await expect(
        conversationService.getWithMessages("conv-1", "user-other"),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("deleteConversation", () => {
    it("should soft-delete conversation for valid owner", async () => {
      vi.mocked(conversationRepo.getConversation).mockResolvedValue(mockConversation);
      vi.mocked(conversationRepo.softDeleteConversation).mockResolvedValue(undefined);

      await conversationService.deleteConversation("conv-1", "user-1");

      expect(conversationRepo.softDeleteConversation).toHaveBeenCalledWith("conv-1");
    });

    it("should throw NotFoundError when conversation does not exist", async () => {
      vi.mocked(conversationRepo.getConversation).mockResolvedValue(null);

      await expect(
        conversationService.deleteConversation("conv-nonexistent", "user-1"),
      ).rejects.toThrow(NotFoundError);
    });

    it("should throw ForbiddenError when user does not own conversation", async () => {
      vi.mocked(conversationRepo.getConversation).mockResolvedValue(mockConversation);

      await expect(
        conversationService.deleteConversation("conv-1", "user-other"),
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
