/**
 * Skill service unit tests.
 *
 * Mocks skillRepo to test built-in listing, user skill CRUD,
 * and marketplace install logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing service
vi.mock("../../modules/skill.repo.js", () => ({
  createSkill: vi.fn(),
  getSkillById: vi.fn(),
  getSkillByOwnerAndName: vi.fn(),
  listSkillsForUser: vi.fn(),
  listPublishedSkills: vi.fn(),
  updateSkill: vi.fn(),
  setPublished: vi.fn(),
  incrementInstallCount: vi.fn(),
  softDeleteSkill: vi.fn(),
  createInstall: vi.fn(),
  getInstall: vi.fn(),
  softDeleteInstall: vi.fn(),
}));

import * as skillService from "../../modules/skill.service.js";
import * as skillRepo from "../../modules/skill.repo.js";
import { NotFoundError, ForbiddenError, ConflictError } from "../../errors.js";

const mockSkill = {
  id: "skill-1",
  ownerUserId: "user-1",
  name: "my-skill",
  description: "A custom skill",
  version: "1.0.0",
  tags: ["ai"],
  files: { "SKILL.md": { type: "text", data: "# Skill" } },
  isPublished: false,
  installCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const mockInstall = {
  id: "install-1",
  userId: "user-2",
  skillId: "skill-1",
  installedAt: new Date(),
  deletedAt: null,
};

describe("skill.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listBuiltin", () => {
    it("should return an empty array (placeholder)", () => {
      const result = skillService.listBuiltin();
      expect(result).toEqual([]);
    });
  });

  describe("createUserSkill", () => {
    it("should create a skill when name is unique for owner", async () => {
      vi.mocked(skillRepo.getSkillByOwnerAndName).mockResolvedValue(null);
      vi.mocked(skillRepo.createSkill).mockResolvedValue(mockSkill);

      const result = await skillService.createUserSkill(
        "user-1",
        "my-skill",
        "A custom skill",
        { "SKILL.md": { type: "text", data: "# Skill" } },
        "1.0.0",
        ["ai"],
      );

      expect(result).toEqual(mockSkill);
      expect(skillRepo.createSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: "user-1",
          name: "my-skill",
          description: "A custom skill",
        }),
      );
    });

    it("should throw ConflictError on duplicate name for same owner", async () => {
      vi.mocked(skillRepo.getSkillByOwnerAndName).mockResolvedValue(mockSkill);

      await expect(
        skillService.createUserSkill(
          "user-1",
          "my-skill",
          "duplicate",
          {},
        ),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe("updateUserSkill", () => {
    it("should update skill for valid owner", async () => {
      vi.mocked(skillRepo.getSkillById).mockResolvedValue(mockSkill);
      const updatedSkill = { ...mockSkill, description: "Updated" };
      vi.mocked(skillRepo.updateSkill).mockResolvedValue(updatedSkill);

      const result = await skillService.updateUserSkill(
        "skill-1",
        "user-1",
        { "SKILL.md": { type: "text", data: "# Updated" } },
        "Updated",
        "2.0.0",
      );

      expect(result).toEqual(updatedSkill);
      expect(skillRepo.updateSkill).toHaveBeenCalledWith("skill-1", {
        files: { "SKILL.md": { type: "text", data: "# Updated" } },
        description: "Updated",
        version: "2.0.0",
      });
    });

    it("should throw NotFoundError when skill does not exist", async () => {
      vi.mocked(skillRepo.getSkillById).mockResolvedValue(null);

      await expect(
        skillService.updateUserSkill("skill-nonexistent", "user-1", {}),
      ).rejects.toThrow(NotFoundError);
    });

    it("should throw ForbiddenError when user does not own skill", async () => {
      vi.mocked(skillRepo.getSkillById).mockResolvedValue(mockSkill);

      await expect(
        skillService.updateUserSkill("skill-1", "user-other", {}),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("deleteUserSkill", () => {
    it("should soft-delete skill for valid owner", async () => {
      vi.mocked(skillRepo.getSkillById).mockResolvedValue(mockSkill);
      vi.mocked(skillRepo.softDeleteSkill).mockResolvedValue(undefined);

      await skillService.deleteUserSkill("skill-1", "user-1");

      expect(skillRepo.softDeleteSkill).toHaveBeenCalledWith("skill-1");
    });

    it("should throw NotFoundError when skill does not exist", async () => {
      vi.mocked(skillRepo.getSkillById).mockResolvedValue(null);

      await expect(
        skillService.deleteUserSkill("skill-nonexistent", "user-1"),
      ).rejects.toThrow(NotFoundError);
    });

    it("should throw ForbiddenError when user does not own skill", async () => {
      vi.mocked(skillRepo.getSkillById).mockResolvedValue(mockSkill);

      await expect(
        skillService.deleteUserSkill("skill-1", "user-other"),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("installSkill", () => {
    it("should install a published skill for a different user", async () => {
      const publishedSkill = { ...mockSkill, isPublished: true };
      vi.mocked(skillRepo.getSkillById).mockResolvedValue(publishedSkill);
      vi.mocked(skillRepo.getInstall).mockResolvedValue(null);
      vi.mocked(skillRepo.createInstall).mockResolvedValue(mockInstall);
      vi.mocked(skillRepo.incrementInstallCount).mockResolvedValue(undefined);

      const result = await skillService.installSkill("skill-1", "user-2");

      expect(result).toEqual(mockInstall);
      expect(skillRepo.createInstall).toHaveBeenCalledWith("user-2", "skill-1");
      expect(skillRepo.incrementInstallCount).toHaveBeenCalledWith("skill-1");
    });

    it("should throw NotFoundError when skill does not exist", async () => {
      vi.mocked(skillRepo.getSkillById).mockResolvedValue(null);

      await expect(
        skillService.installSkill("skill-nonexistent", "user-2"),
      ).rejects.toThrow(NotFoundError);
    });

    it("should throw ForbiddenError when skill is not published", async () => {
      vi.mocked(skillRepo.getSkillById).mockResolvedValue(mockSkill);

      await expect(
        skillService.installSkill("skill-1", "user-2"),
      ).rejects.toThrow(ForbiddenError);
    });

    it("should throw ConflictError when owner tries to self-install", async () => {
      const publishedSkill = { ...mockSkill, isPublished: true };
      vi.mocked(skillRepo.getSkillById).mockResolvedValue(publishedSkill);

      await expect(
        skillService.installSkill("skill-1", "user-1"),
      ).rejects.toThrow(ConflictError);
    });

    it("should throw ConflictError when skill is already installed", async () => {
      const publishedSkill = { ...mockSkill, isPublished: true };
      vi.mocked(skillRepo.getSkillById).mockResolvedValue(publishedSkill);
      vi.mocked(skillRepo.getInstall).mockResolvedValue(mockInstall);

      await expect(
        skillService.installSkill("skill-1", "user-2"),
      ).rejects.toThrow(ConflictError);
    });
  });
});
