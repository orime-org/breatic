// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Give Studios seeded straight into the region tables their global directory
 * rows (inner#1955), the way migration 0125 filled the directory from the
 * Studios already present: region NULL, live, the admin member as the admin,
 * every member copied. Product code writes these rows itself when it creates
 * a Studio; a fixture that inserts rows by hand calls this afterwards.
 */

import type postgres from "postgres";

/**
 * Write the directory rows of Studios from their region rows.
 * @param sql - The test connection.
 * @param studioIds - The Studios, already holding their admin membership.
 */
export async function mirrorInDirectory(sql: postgres.Sql, ...studioIds: string[]): Promise<void> {
  for (const studioId of studioIds) {
    await sql`
      INSERT INTO studio_directory
        (studio_id, slug, region, type, name, avatar_url, admin_user_id, created_by_user_id, state, created_at, updated_at, deleted_at)
      SELECT s.id, s.slug, NULL, s.type, s.name, s.avatar_url,
             COALESCE((SELECT m.user_id FROM studio_members m
                        WHERE m.studio_id = s.id AND m.role = 'admin' AND m.deleted_at IS NULL LIMIT 1),
                      s.created_by_user_id),
             s.created_by_user_id, 'live', s.created_at, s.updated_at, s.deleted_at
      FROM studios s WHERE s.id = ${studioId}
      ON CONFLICT (studio_id) DO NOTHING
    `;
    await sql`
      INSERT INTO studio_directory_members (studio_id, user_id, role)
      SELECT m.studio_id, m.user_id, m.role FROM studio_members m
      WHERE m.studio_id = ${studioId} AND m.deleted_at IS NULL
      ON CONFLICT (studio_id, user_id) DO NOTHING
    `;
  }
}
