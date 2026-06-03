// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Skill service — built-in skill listing, user skill CRUD, and marketplace.
 *
 * Enforces ownership checks for user-created skills and handles
 * publish/install workflows with atomic counters.
 */

import * as skillRepo from "@server/modules/skill/skill.repo.js";
import { NotFoundError, ForbiddenError, ConflictError } from "@breatic/core";
import type { SkillMeta } from "@breatic/shared";

/**
 * List all built-in skills from the SkillRegistry.
 *
 * Returns an empty array until Phase 3 when the registry is migrated.
 * @returns Array of built-in skill metadata
 */
export function listBuiltin(): SkillMeta[] {
  return [];
}

/**
 * Create a user-defined custom skill.
 * @param ownerUserId - Creator user UUID
 * @param name - Unique skill name (per owner)
 * @param description - Skill description
 * @param files - Skill file contents keyed by filename
 * @param version - Semantic version (default "1.0.0")
 * @param tags - Optional tags for marketplace filtering
 * @returns The created skill record
 * @throws {ConflictError} if a skill with the same name already exists for this user
 */
export async function createUserSkill(
  ownerUserId: string,
  name: string,
  description: string,
  files: Record<string, { type: string; data: string }>,
  version?: string,
  tags?: string[],
): Promise<unknown> {
  const existing = await skillRepo.getSkillByOwnerAndName(ownerUserId, name);
  if (existing) throw new ConflictError("Skill with this name already exists");
  return skillRepo.createSkill({ ownerUserId, name, description, files, version, tags });
}

/**
 * Update a user-defined skill with ownership enforcement.
 * @param skillId - Skill UUID
 * @param userId - Requesting user UUID
 * @param files - Updated file contents
 * @param description - Optional updated description
 * @param version - Optional updated version
 * @returns The updated skill record
 * @throws {NotFoundError} if skill does not exist
 * @throws {ForbiddenError} if userId does not match the skill owner
 */
export async function updateUserSkill(
  skillId: string,
  userId: string,
  files: Record<string, { type: string; data: string }>,
  description?: string,
  version?: string,
): Promise<unknown> {
  const skill = await skillRepo.getSkillById(skillId);
  if (!skill) throw new NotFoundError("Skill not found");
  if (skill.ownerUserId !== userId) throw new ForbiddenError("Access denied");
  return skillRepo.updateSkill(skillId, { files, description, version });
}

/**
 * Soft-delete a user-defined skill with ownership enforcement.
 * @param skillId - Skill UUID
 * @param userId - Requesting user UUID
 * @throws {NotFoundError} if skill does not exist
 * @throws {ForbiddenError} if userId does not match the skill owner
 */
export async function deleteUserSkill(skillId: string, userId: string): Promise<void> {
  const skill = await skillRepo.getSkillById(skillId);
  if (!skill) throw new NotFoundError("Skill not found");
  if (skill.ownerUserId !== userId) throw new ForbiddenError("Access denied");
  await skillRepo.softDeleteSkill(skillId);
}

/**
 * List skills owned by or installed for a user.
 * @param userId - User UUID
 * @returns Array of skill records
 */
export async function listUserSkills(userId: string): Promise<unknown[]> {
  return skillRepo.listSkillsForUser(userId);
}

/**
 * Publish a skill to the marketplace.
 * @param skillId - Skill UUID
 * @param userId - Requesting user UUID
 * @returns The updated skill record
 * @throws {NotFoundError} if skill does not exist
 * @throws {ForbiddenError} if userId does not match the skill owner
 */
export async function publishSkill(skillId: string, userId: string): Promise<unknown> {
  const skill = await skillRepo.getSkillById(skillId);
  if (!skill) throw new NotFoundError("Skill not found");
  if (skill.ownerUserId !== userId) throw new ForbiddenError("Access denied");
  return skillRepo.setPublished(skillId, true);
}

/**
 * Unpublish a skill from the marketplace.
 * @param skillId - Skill UUID
 * @param userId - Requesting user UUID
 * @returns The updated skill record
 * @throws {NotFoundError} if skill does not exist
 * @throws {ForbiddenError} if userId does not match the skill owner
 */
export async function unpublishSkill(skillId: string, userId: string): Promise<unknown> {
  const skill = await skillRepo.getSkillById(skillId);
  if (!skill) throw new NotFoundError("Skill not found");
  if (skill.ownerUserId !== userId) throw new ForbiddenError("Access denied");
  return skillRepo.setPublished(skillId, false);
}

/**
 * List published marketplace skills, optionally filtered by tags.
 * @param tags - Optional tag filter
 * @param offset - Pagination offset
 * @param limit - Maximum number of results
 * @returns Array of published skill records
 */
export async function listMarketSkills(
  tags?: string[],
  offset?: number,
  limit?: number,
): Promise<unknown[]> {
  return skillRepo.listPublishedSkills(tags, limit, offset);
}

/**
 * Install a published marketplace skill for a user.
 * @param skillId - Skill UUID to install
 * @param userId - Installing user UUID
 * @returns The install record
 * @throws {NotFoundError} if skill does not exist
 * @throws {ForbiddenError} if skill is not published
 * @throws {ConflictError} if user is the owner or skill is already installed
 */
export async function installSkill(skillId: string, userId: string): Promise<unknown> {
  const skill = await skillRepo.getSkillById(skillId);
  if (!skill) throw new NotFoundError("Skill not found");
  if (!skill.isPublished) throw new ForbiddenError("Skill is not published");
  if (skill.ownerUserId === userId) throw new ConflictError("Cannot install your own skill");

  const existing = await skillRepo.getInstall(userId, skillId);
  if (existing) throw new ConflictError("Skill already installed");

  const install = await skillRepo.createInstall(userId, skillId);
  await skillRepo.incrementInstallCount(skillId);
  return install;
}

/**
 * Uninstall a marketplace skill for a user (soft-delete).
 *
 * Marks the install record as deleted but keeps the row. Re-installing
 * the same skill will recreate the install (install_count increments).
 * @param skillId - Skill UUID to uninstall
 * @param userId - User UUID
 */
export async function uninstallSkill(skillId: string, userId: string): Promise<void> {
  await skillRepo.softDeleteInstall(userId, skillId);
}
