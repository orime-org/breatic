/**
 * Project service unit tests.
 *
 * Mocks projectRepo to test business logic and ownership checks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing service
vi.mock("../../modules/project.repo.js", () => ({
  createProject: vi.fn(),
  getProjectById: vi.fn(),
  listProjectsByUser: vi.fn(),
  updateCanvas: vi.fn(),
  updateProjectMeta: vi.fn(),
  duplicateProject: vi.fn(),
  deleteProject: vi.fn(),
}));

import * as projectService from "../../modules/project.service.js";
import * as projectRepo from "../../modules/project.repo.js";
import { NotFoundError, ForbiddenError } from "../../errors.js";

const mockProject = {
  id: "proj-1",
  userId: "user-1",
  name: "Test Project",
  description: "A test project",
  canvasData: {},
  thumbnailUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

describe("project.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("should delegate to repo and return created project", async () => {
      vi.mocked(projectRepo.createProject).mockResolvedValue(mockProject);

      const result = await projectService.create("user-1", "Test Project", "A test project");

      expect(result.id).toBe("proj-1");
      expect(projectRepo.createProject).toHaveBeenCalledWith(
        "user-1",
        "Test Project",
        "A test project",
      );
    });

    it("should handle optional description", async () => {
      vi.mocked(projectRepo.createProject).mockResolvedValue(mockProject);

      await projectService.create("user-1", "Test Project");

      expect(projectRepo.createProject).toHaveBeenCalledWith(
        "user-1",
        "Test Project",
        undefined,
      );
    });
  });

  describe("get", () => {
    it("should return project for valid owner", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);

      const result = await projectService.get("proj-1", "user-1");

      expect(result.id).toBe("proj-1");
    });

    it("should throw NotFoundError when project does not exist", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(null);

      await expect(
        projectService.get("proj-nonexistent", "user-1"),
      ).rejects.toThrow(NotFoundError);
    });

    it("should throw ForbiddenError when user does not own project", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);

      await expect(
        projectService.get("proj-1", "user-other"),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("list", () => {
    it("should delegate to repo with correct parameters", async () => {
      vi.mocked(projectRepo.listProjectsByUser).mockResolvedValue([mockProject]);

      const result = await projectService.list("user-1", 10, 0);

      expect(result).toEqual([mockProject]);
      expect(projectRepo.listProjectsByUser).toHaveBeenCalledWith("user-1", 10, 0);
    });
  });

  describe("saveCanvas", () => {
    it("should update canvas for valid owner", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);
      vi.mocked(projectRepo.updateCanvas).mockResolvedValue(undefined);

      const canvasData = { nodes: [], edges: [] };
      await projectService.saveCanvas("proj-1", "user-1", canvasData);

      expect(projectRepo.updateCanvas).toHaveBeenCalledWith("proj-1", canvasData);
    });

    it("should throw NotFoundError when project does not exist", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(null);

      await expect(
        projectService.saveCanvas("proj-nonexistent", "user-1", {}),
      ).rejects.toThrow(NotFoundError);
    });

    it("should throw ForbiddenError when user does not own project", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);

      await expect(
        projectService.saveCanvas("proj-1", "user-other", {}),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("update", () => {
    it("should update project metadata for the owner", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);
      vi.mocked(projectRepo.updateProjectMeta).mockResolvedValue({
        ...mockProject,
        name: "Renamed",
      });

      const result = await projectService.update("proj-1", "user-1", {
        name: "Renamed",
      });

      expect(result.name).toBe("Renamed");
      expect(projectRepo.updateProjectMeta).toHaveBeenCalledWith("proj-1", {
        name: "Renamed",
        description: undefined,
        thumbnailUrl: undefined,
      });
    });

    it("should throw ForbiddenError when user does not own project", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);

      await expect(
        projectService.update("proj-1", "user-other", { name: "x" }),
      ).rejects.toThrow(ForbiddenError);
      expect(projectRepo.updateProjectMeta).not.toHaveBeenCalled();
    });

    it("should throw NotFoundError when repo returns null (row vanished)", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);
      vi.mocked(projectRepo.updateProjectMeta).mockResolvedValue(null);

      await expect(
        projectService.update("proj-1", "user-1", { name: "x" }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe("duplicate", () => {
    const duplicated = {
      ...mockProject,
      id: "proj-2",
      name: "Test Project (copy)",
    };

    it("should duplicate the project for the owner", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);
      vi.mocked(projectRepo.duplicateProject).mockResolvedValue(duplicated);

      const result = await projectService.duplicate("proj-1", "user-1");

      expect(result.id).toBe("proj-2");
      expect(result.name).toBe("Test Project (copy)");
      expect(projectRepo.duplicateProject).toHaveBeenCalledWith(
        "user-1",
        "proj-1",
      );
    });

    it("should refuse to duplicate a project owned by another user", async () => {
      // Critical: without this check, any authenticated user could
      // duplicate any project whose UUID they know. The ownership
      // check must reject BEFORE the repo sees the request.
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);

      await expect(
        projectService.duplicate("proj-1", "user-other"),
      ).rejects.toThrow(ForbiddenError);
      expect(projectRepo.duplicateProject).not.toHaveBeenCalled();
    });

    it("should throw NotFoundError when source project does not exist", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(null);

      await expect(
        projectService.duplicate("missing", "user-1"),
      ).rejects.toThrow(NotFoundError);
      expect(projectRepo.duplicateProject).not.toHaveBeenCalled();
    });

    it("should throw NotFoundError when repo returns null mid-transaction", async () => {
      // Simulates a race where the source was soft-deleted between
      // the ownership check and the transaction's SELECT.
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);
      vi.mocked(projectRepo.duplicateProject).mockResolvedValue(null);

      await expect(
        projectService.duplicate("proj-1", "user-1"),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe("deleteProject", () => {
    it("should soft-delete project for valid owner", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);
      vi.mocked(projectRepo.deleteProject).mockResolvedValue(undefined);

      await projectService.deleteProject("proj-1", "user-1");

      expect(projectRepo.deleteProject).toHaveBeenCalledWith("proj-1");
    });

    it("should throw NotFoundError when project does not exist", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(null);

      await expect(
        projectService.deleteProject("proj-nonexistent", "user-1"),
      ).rejects.toThrow(NotFoundError);
    });

    it("should throw ForbiddenError when user does not own project", async () => {
      vi.mocked(projectRepo.getProjectById).mockResolvedValue(mockProject);

      await expect(
        projectService.deleteProject("proj-1", "user-other"),
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
