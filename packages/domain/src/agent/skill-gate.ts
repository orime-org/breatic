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
 * Writing the check twice is what let them drift, so it is written once, and
 * it answers everything that has to be true before a request proceeds:
 *
 * - the skill exists
 * - this surface serves it (the axis the chat side used to skip entirely)
 * - a user may fire it directly
 * - the model it pinned itself to has a provider this deployment can reach
 *
 * The last one is here rather than left to the factory because of when it
 * happens: the factory runs after the user's message is saved and the stream
 * is open, and by then there is no clean way to tell them the deployment is
 * missing a key. The factory checks too — it is the one place that resolves
 * a model, so nothing can reach a provider without passing it — but this is
 * where the answer is still useful.
 */
import { AppError, getSkillRouting } from "@breatic/core";
import type { SkillSurface } from "@breatic/core";
import { assertSkillModelRunnable } from "@domain/agent/skill-availability.js";
import { getSkillRegistry } from "@domain/agent/skills-loader.js";

/**
 * Check that this skill can be used, by this user, from this surface, here.
 * @param skillName - The skill the request named.
 * @param surface - Where the request came from.
 * @throws {AppError} 404 when no such skill exists, 403 when the routing config does not allow it here, 503 when its model has no reachable provider.
 */
export function assertSkillUsable(
  skillName: string,
  surface: SkillSurface,
): void {
  const skill = getSkillRegistry().getInternal(skillName);
  if (!skill) {
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

  assertSkillModelRunnable(skillName, skill.model);
}
