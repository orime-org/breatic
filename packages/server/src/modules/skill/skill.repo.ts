// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Skill repository — custom skills and marketplace installs.
 *
 * Supports soft deletes, atomic install count, and PostgreSQL ARRAY filtering.
 */

import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import { customSkills, skillInstalls } from "@breatic/core";

type SkillRow = typeof customSkills.$inferSelect;
type InstallRow = typeof skillInstalls.$inferSelect;

/**
 * Create a custom skill.
 * @param data - Skill fields to insert
 * @param data.ownerUserId - User who owns the skill
 * @param data.name - Skill name (unique per owner)
 * @param data.description - Skill description
 * @param data.version - Semantic version (defaults to "1.0.0")
 * @param data.tags - Optional marketplace tags
 * @param data.files - Skill file contents keyed by filename
 * @returns The inserted skill row
 */
export async function createSkill(data: {
  ownerUserId: string;
  name: string;
  description: string;
  version?: string;
  tags?: string[];
  files?: Record<string, { type: string; data: string }>;
}): Promise<SkillRow> {
  const rows = await db
    .insert(customSkills)
    .values({
      ownerUserId: data.ownerUserId,
      name: data.name,
      description: data.description,
      version: data.version ?? "1.0.0",
      tags: data.tags,
      files: data.files,
    })
    .returning();
  return rows[0]!;
}

/**
 * Get a skill by ID (excludes soft-deleted).
 * @param id - Skill UUID
 * @returns The skill row, or null if not found or soft-deleted
 */
export async function getSkillById(id: string): Promise<SkillRow | null> {
  const rows = await db
    .select()
    .from(customSkills)
    .where(and(eq(customSkills.id, id), isNull(customSkills.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Get a skill by owner + name (excludes soft-deleted).
 * @param ownerUserId - User who owns the skill
 * @param name - Skill name
 * @returns The skill row, or null if not found or soft-deleted
 */
export async function getSkillByOwnerAndName(
  ownerUserId: string,
  name: string,
): Promise<SkillRow | null> {
  const rows = await db
    .select()
    .from(customSkills)
    .where(
      and(
        eq(customSkills.ownerUserId, ownerUserId),
        eq(customSkills.name, name),
        isNull(customSkills.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * List skills for a user (owned + installed).
 * @param userId - User whose owned and installed skills to list
 * @returns Deduplicated skill rows (owned skills followed by distinct installed skills)
 */
export async function listSkillsForUser(userId: string): Promise<SkillRow[]> {
  // Owned skills
  const owned = await db
    .select()
    .from(customSkills)
    .where(and(eq(customSkills.ownerUserId, userId), isNull(customSkills.deletedAt)));

  // Installed skills (via join) — excludes soft-deleted installs and skills
  const installed = await db
    .select({ skill: customSkills })
    .from(skillInstalls)
    .innerJoin(customSkills, eq(skillInstalls.skillId, customSkills.id))
    .where(
      and(
        eq(skillInstalls.userId, userId),
        isNull(skillInstalls.deletedAt),
        isNull(customSkills.deletedAt),
      ),
    );

  const installedSkills = installed.map((r) => r.skill);

  // Deduplicate by ID
  const seen = new Set(owned.map((s) => s.id));
  for (const s of installedSkills) {
    if (!seen.has(s.id)) {
      owned.push(s);
      seen.add(s.id);
    }
  }

  return owned;
}

/**
 * List published skills, optionally filtered by tags.
 * @param tags - Optional tags; matched with the PostgreSQL ARRAY overlap operator
 * @param limit - Page size
 * @param offset - Pagination offset
 * @returns Published skill rows ordered by install count, descending
 */
export async function listPublishedSkills(
  tags?: string[],
  limit = 20,
  offset = 0,
): Promise<SkillRow[]> {
  if (tags && tags.length > 0) {
    // PostgreSQL ARRAY overlap operator
    return db.execute(
      sql`SELECT * FROM custom_skills
          WHERE is_published = true AND deleted_at IS NULL
          AND tags && ${sql.raw(`ARRAY[${tags.map((t) => `'${t}'`).join(",")}]::text[]`)}
          ORDER BY install_count DESC
          LIMIT ${limit} OFFSET ${offset}`,
    ) as Promise<SkillRow[]>;
  }

  return db
    .select()
    .from(customSkills)
    .where(and(eq(customSkills.isPublished, true), isNull(customSkills.deletedAt)))
    .orderBy(desc(customSkills.installCount))
    .limit(limit)
    .offset(offset);
}

/**
 * Update selective skill fields.
 * @param id - Skill UUID
 * @param data - Fields to update; only defined keys are written
 * @param data.description - New description
 * @param data.version - New semantic version
 * @param data.files - New skill file contents keyed by filename
 * @returns The updated skill row, or null if no row matched
 */
export async function updateSkill(
  id: string,
  data: { description?: string; version?: string; files?: Record<string, { type: string; data: string }> },
): Promise<SkillRow | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.description !== undefined) updates.description = data.description;
  if (data.version !== undefined) updates.version = data.version;
  if (data.files !== undefined) updates.files = data.files;

  const rows = await db
    .update(customSkills)
    .set(updates)
    .where(eq(customSkills.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Set published status.
 * @param id - Skill UUID
 * @param published - Whether the skill is listed on the marketplace
 * @returns The updated skill row, or null if no row matched
 */
export async function setPublished(id: string, published: boolean): Promise<SkillRow | null> {
  const rows = await db
    .update(customSkills)
    .set({ isPublished: published, updatedAt: new Date() })
    .where(eq(customSkills.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Atomically increment install count.
 * @param id - Skill UUID
 */
export async function incrementInstallCount(id: string): Promise<void> {
  await db.execute(
    sql`UPDATE custom_skills SET install_count = install_count + 1 WHERE id = ${id}`,
  );
}

/**
 * Soft-delete a skill.
 * @param id - Skill UUID
 */
export async function softDeleteSkill(id: string): Promise<void> {
  await db
    .update(customSkills)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(customSkills.id, id));
}

/**
 * Create a skill install record.
 * @param userId - User installing the skill
 * @param skillId - Skill being installed
 * @returns The inserted install row
 */
export async function createInstall(userId: string, skillId: string): Promise<InstallRow> {
  const rows = await db
    .insert(skillInstalls)
    .values({ userId, skillId })
    .returning();
  return rows[0]!;
}

/**
 * Get an active (non-soft-deleted) skill install record.
 * @param userId - User who installed the skill
 * @param skillId - Installed skill
 * @returns The active install row, or null if none exists
 */
export async function getInstall(userId: string, skillId: string): Promise<InstallRow | null> {
  const rows = await db
    .select()
    .from(skillInstalls)
    .where(
      and(
        eq(skillInstalls.userId, userId),
        eq(skillInstalls.skillId, skillId),
        isNull(skillInstalls.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Soft-delete a skill install record (uninstall).
 * @param userId - User uninstalling the skill
 * @param skillId - Skill being uninstalled
 */
export async function softDeleteInstall(userId: string, skillId: string): Promise<void> {
  await db
    .update(skillInstalls)
    .set({ deletedAt: new Date() })
    .where(and(eq(skillInstalls.userId, userId), eq(skillInstalls.skillId, skillId)));
}
