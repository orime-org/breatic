/**
 * Task service unit tests.
 *
 * Tests task creation, ownership enforcement, and status transitions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../modules/task.repo.js", () => ({
  createTask: vi.fn(),
  getTaskById: vi.fn(),
  listTasksByUser: vi.fn(),
  setJobId: vi.fn(),
  updateTaskStatus: vi.fn(),
  setResolvedSkills: vi.fn(),
}));

import * as taskService from "../../modules/task.service.js";
import * as taskRepo from "../../modules/task.repo.js";
import { NotFoundError, ForbiddenError } from "../../errors.js";

const mockTask = {
  id: "task-1",
  userId: "user-1",
  projectId: null,
  taskType: "image",
  model: "nano-banana-2",
  skillName: null,
  status: "pending",
  params: { prompt: "a cat" },
  result: null,
  errorMessage: null,
  arqJobId: null,
  startedAt: null,
  completedAt: null,
  creditsUsed: 0,
  durationMs: null,
  resolvedSkills: [],
  source: "canvas",
  providerResultUrl: null,
  billedAt: null,
  billedCredits: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("task.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("should create a task", async () => {
      vi.mocked(taskRepo.createTask).mockResolvedValue(mockTask);

      const result = await taskService.create(
        "user-1",
        undefined,
        "image",
        { prompt: "a cat" },
        "nano-banana-2",
      );

      expect(result.taskType).toBe("image");
      expect(taskRepo.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          taskType: "image",
        }),
      );
    });
  });

  describe("get", () => {
    it("should return task for the owner", async () => {
      vi.mocked(taskRepo.getTaskById).mockResolvedValue(mockTask);

      const result = await taskService.get("task-1", "user-1");
      expect(result.id).toBe("task-1");
    });

    it("should throw NotFoundError if task doesn't exist", async () => {
      vi.mocked(taskRepo.getTaskById).mockResolvedValue(null);

      await expect(taskService.get("nonexistent", "user-1")).rejects.toThrow(NotFoundError);
    });

    it("should throw ForbiddenError for non-owner", async () => {
      vi.mocked(taskRepo.getTaskById).mockResolvedValue(mockTask);

      await expect(taskService.get("task-1", "other-user")).rejects.toThrow(ForbiddenError);
    });
  });

  describe("markCompleted", () => {
    it("should update status to completed with result", async () => {
      await taskService.markCompleted("task-1", { url: "https://result.png" }, 5.0);

      expect(taskRepo.updateTaskStatus).toHaveBeenCalledWith(
        "task-1",
        "completed",
        { result: { url: "https://result.png" }, creditsUsed: 5.0 },
      );
    });
  });

  describe("markFailed", () => {
    it("should update status to failed with error", async () => {
      await taskService.markFailed("task-1", "Provider timeout");

      expect(taskRepo.updateTaskStatus).toHaveBeenCalledWith(
        "task-1",
        "failed",
        { error: "Provider timeout" },
      );
    });
  });
});
