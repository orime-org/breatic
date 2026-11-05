// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { getRedis, sessionCookieName, setSession } from "@breatic/core";

export interface ActivityProject {
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
}

export interface ActivityRow {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: string;
  visit_id: string | null;
  occurred_at: string;
}

/**
 * Create one verified user with a real session.
 * @param sql - Fixture connection.
 * @returns The account id and authenticating cookie.
 * @throws {Error} When a fixture insert or session write fails.
 */
export async function seedActivityUser(sql: Sql): Promise<{ userId: string; cookie: string }> {
  const tag = randomUUID().replaceAll("-", "").slice(0, 16);
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`activity-${tag}@example.test`}, true) RETURNING id
  `;
  if (!user) throw new Error("activity fixture user was not inserted");
  const token = randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user.id);
  return { userId: user.id, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * Create a real account, Studio, Project, memberships and session.
 * @param sql - Fixture connection.
 * @returns The account and Project identifiers plus the real session cookie.
 * @throws {Error} When a fixture insert or session write fails.
 */
export async function seedActivityProject(sql: Sql): Promise<ActivityProject> {
  const account = await seedActivityUser(sql);
  const tag = randomUUID().replaceAll("-", "").slice(0, 16);
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${account.userId}, ${`activity-s-${tag}`}, 'team', 'Activity Studio') RETURNING id
  `;
  if (!studio) throw new Error("activity fixture Studio was not inserted");
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studio.id}, ${account.userId}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studio.id}, ${account.userId}, ${`activity-p-${tag}`}, 'Activity Project') RETURNING id
  `;
  if (!project) throw new Error("activity fixture Project was not inserted");
  await sql`
    INSERT INTO project_members (project_id, user_id, role)
    VALUES (${project.id}, ${account.userId}, 'owner')
  `;
  return { ...account, studioId: studio.id, projectId: project.id };
}

/**
 * Read exact event identities and server timestamps for one account.
 * @param sql - Fixture connection.
 * @param userId - The account whose events are inspected.
 * @returns Events in insertion order, retaining timestamp precision as text.
 * @throws {Error} When the database query fails.
 */
export async function activityRows(sql: Sql, userId: string): Promise<ActivityRow[]> {
  return sql<ActivityRow[]>`
    SELECT id, user_id, project_id, kind, visit_id, occurred_at::text
    FROM account_activity_events
    WHERE user_id = ${userId}
    ORDER BY created_at, id
  `;
}

/**
 * Temporarily reject activity writes for one account in a real database.
 * @param sql - Fixture connection.
 * @param userId - The account whose append should fail.
 * @returns An async function that removes this fixture's trigger and function.
 * @throws {Error} When the database cannot install the trigger.
 */
export async function rejectActivityWrites(sql: Sql, userId: string): Promise<() => Promise<void>> {
  const functionName = `activity_reject_${randomUUID().replaceAll("-", "")}`;
  const triggerName = `${functionName}_trigger`;
  await sql.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.user_id = '${userId}'::uuid THEN RAISE EXCEPTION 'activity fixture append rejected'; END IF;
      RETURN NEW;
    END $$`);
  try {
    await sql.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON account_activity_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  } catch (error) {
    await sql.unsafe(`DROP FUNCTION ${functionName}()`);
    throw error;
  }
  return async (): Promise<void> => {
    await sql.unsafe(`DROP TRIGGER ${triggerName} ON account_activity_events`);
    await sql.unsafe(`DROP FUNCTION ${functionName}()`);
  };
}
