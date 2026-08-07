// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one gate every entry point passes a user-named skill through.
 *
 * There are two such entry points -- the chat command and canvas task
 * creation -- and only one of them used to check anything. Canvas took a
 * `skill_name` straight off the request body into the task row and the queue,
 * so any editor could have the worker run any skill, including ones the
 * routing config says nobody may invoke and ones missing from that config
 * entirely (which, by its own rule, means allowed nowhere).
 *
 * Writing the check twice is what let them drift, so it is written once.
 * Both axes are asked here: does this surface serve the skill at all, and may
 * a user fire it directly. Answering only the second is what the chat side
 * did, which is why `surfaces` had no consumer.
 */
import { AppError, getSkillRouting } from "@breatic/core";
import type { SkillSurface } from "@breatic/core";
import { getSkillRegistry } from "@domain/agent/skills-loader.js";

/**
 * Check that a user may invoke this skill from this surface.
 * @param skillName - The skill the request named.
 * @param surface - Where the request came from.
 * @throws {AppError} 404 when no such skill exists, 403 when the routing config does not allow it here.
 */
export function assertUserMayInvoke(
  skillName: string,
  surface: SkillSurface,
): void {
  if (!getSkillRegistry().get(skillName)) {
    throw new AppError(404, `Skill '${skillName}' not found`);
  }

  // Absent from the config means allowed nowhere — silence grants nothing.
  const route = getSkillRouting().skills[skillName];
  if (!route?.surfaces.includes(surface)) {
    throw new AppError(403, `Skill '${skillName}' is not available here`);
  }
  if (!route.user_invocable) {
    throw new AppError(403, `Skill '${skillName}' is not user-invocable`);
  }
}
