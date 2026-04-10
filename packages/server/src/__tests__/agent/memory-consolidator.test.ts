/**
 * Memory consolidator tests (Turn-based).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock AI SDK
vi.mock("ai", () => ({
  generateText: vi.fn().mockResolvedValue({
    text: JSON.stringify({
      conversationUpdate: "User discussed cyberpunk city generation.",
      projectUpdate: "Project uses neon-heavy cyberpunk aesthetic.",
      userUpdate: null,
      historyEntry: "Discussed cyberpunk city image generation.",
    }),
  }),
  stepCountIs: vi.fn(),
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
}));

vi.mock("../../agent/llm.js", () => ({
  getModel: vi.fn(() => "mock-model"),
}));

vi.mock("../../modules/conversation.repo.js", () => ({
  getUnconsolidatedTurnCount: vi.fn(),
  getConversation: vi.fn(),
  getMessagesForConsolidation: vi.fn(),
  updateConsolidatedTurn: vi.fn(),
}));

vi.mock("../../modules/memory.repo.js", () => ({
  getConversationMemory: vi.fn().mockResolvedValue(""),
  getUserMemory: vi.fn().mockResolvedValue(""),
  getProjectMemory: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../modules/memory.service.js", () => ({
  applyConsolidation: vi.fn(),
}));

vi.mock("../../config/loader.js", () => ({
  getAgentConfig: vi.fn(() => ({
    default_model: "anthropic/claude-sonnet-4-6",
    consolidation_model: "anthropic/claude-sonnet-4-6",
    memory_window: 20,
    memory_keep_recent_turns: 3,
    full_detail_turns: 3,
    memory_user_max_size: 2048,
    memory_project_max_size: 3072,
    max_tool_iterations: 40,
    web_fetch_max_chars: 50000,
  })),
}));

import { consolidateIfNeeded } from "../../agent/memory-consolidator.js";
import * as conversationRepo from "../../modules/conversation.repo.js";
import * as memoryService from "../../modules/memory.service.js";
import { generateText } from "ai";

describe("memory-consolidator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should do nothing when under turn threshold", async () => {
    vi.mocked(conversationRepo.getUnconsolidatedTurnCount).mockResolvedValue(10);

    await consolidateIfNeeded("user-1", "conv-1");

    expect(generateText).not.toHaveBeenCalled();
    expect(memoryService.applyConsolidation).not.toHaveBeenCalled();
  });

  it("should consolidate when over turn threshold", async () => {
    vi.mocked(conversationRepo.getUnconsolidatedTurnCount).mockResolvedValue(25);
    vi.mocked(conversationRepo.getConversation).mockResolvedValue({
      id: "conv-1",
      userId: "user-1",
      title: "Test",
      projectId: null,
      lastConsolidatedTurn: 0,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(conversationRepo.getMessagesForConsolidation).mockResolvedValue([
      { role: "user", content: "Make a cyberpunk city", ts: "2026-04-01T00:00:00Z", turnIndex: 1 },
      { role: "assistant", content: "Sure!", ts: "2026-04-01T00:00:01Z", turnIndex: 1 },
      { role: "user", content: "Use neon colors", ts: "2026-04-01T00:01:00Z", turnIndex: 2 },
      { role: "assistant", content: "Got it!", ts: "2026-04-01T00:01:01Z", turnIndex: 2 },
    ]);

    await consolidateIfNeeded("user-1", "conv-1", "project-1");

    expect(generateText).toHaveBeenCalled();
    expect(memoryService.applyConsolidation).toHaveBeenCalledWith(
      "user-1",
      "conv-1",
      "project-1",
      expect.objectContaining({
        conversationUpdate: "User discussed cyberpunk city generation.",
        projectUpdate: "Project uses neon-heavy cyberpunk aesthetic.",
        historyEntry: "Discussed cyberpunk city image generation.",
      }),
    );
    // Should advance to turn 2 (max turn in consolidated messages)
    expect(conversationRepo.updateConsolidatedTurn).toHaveBeenCalledWith("conv-1", 2);
  });

  it("should handle LLM parse error gracefully", async () => {
    vi.mocked(conversationRepo.getUnconsolidatedTurnCount).mockResolvedValue(25);
    vi.mocked(conversationRepo.getConversation).mockResolvedValue({
      id: "conv-1",
      userId: "user-1",
      title: "Test",
      projectId: null,
      lastConsolidatedTurn: 0,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(conversationRepo.getMessagesForConsolidation).mockResolvedValue([
      { role: "user", content: "Hello", ts: "2026-04-01T00:00:00Z", turnIndex: 1 },
    ]);

    vi.mocked(generateText).mockResolvedValueOnce({ text: "not json" } as never);

    await consolidateIfNeeded("user-1", "conv-1");

    expect(memoryService.applyConsolidation).not.toHaveBeenCalled();
  });

  it("should skip when no messages to consolidate", async () => {
    vi.mocked(conversationRepo.getUnconsolidatedTurnCount).mockResolvedValue(25);
    vi.mocked(conversationRepo.getConversation).mockResolvedValue({
      id: "conv-1",
      userId: "user-1",
      title: "Test",
      projectId: null,
      lastConsolidatedTurn: 0,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(conversationRepo.getMessagesForConsolidation).mockResolvedValue([]);

    await consolidateIfNeeded("user-1", "conv-1");

    expect(generateText).not.toHaveBeenCalled();
  });
});
