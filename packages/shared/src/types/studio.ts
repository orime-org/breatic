/**
 * Studio entity (v10 §6).
 *
 * V1 = personal Studio: every user has exactly one, auto-created at
 * registration. The `studios` table exists in V1 only as a foreign-key
 * target for `projects.studio_id`; the `studio_assets` and
 * `asset_models` tables that turn it into a real workspace are
 * deferred to the team-Studio phase (V2+).
 */

/** Studio entity (one per user in V1). */
export interface Studio {
  id: string;
  /**
   * Owner user — for V1 personal Studio this is the user who owns it.
   * Team Studio (V2+) may broaden ownership to a membership table.
   */
  ownerUserId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
