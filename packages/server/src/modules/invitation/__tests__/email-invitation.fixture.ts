// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type postgres from "postgres";
import * as projectInvites from "@server/modules/project-invite/projectInvite.service.js";
import * as studioInvites from "@server/modules/studio/studioInvite.service.js";

export type Sql = ReturnType<typeof postgres>;
export type Scope = "project" | "studio";

/** An isolated invitation target and its inviting administrator. */
export interface InvitationFixture {
  adminId: string;
  studioId: string;
  studioSlug: string;
  projectId: string;
  email: string;
}

/** Fields whose invariants are checked across invitation transitions. */
export interface InvitationRow {
  id: string;
  invited_user_id: string | null;
  invited_email: string | null;
  notification_id: string | null;
  share_token: string;
  status: string;
  failed_reason: string | null;
  claimed_at: Date | null;
  expires_at: Date;
}

/**
 * Create isolated real database records for one invitation flow.
 * @param sql - The integration database connection.
 * @returns The target and administrator ids, and an unregistered address.
 * @throws {Error} When the database refuses the fixture.
 */
export async function seedInvitationFixture(sql: Sql): Promise<InvitationFixture> {
  const tag = `ei-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const [admin] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`${tag}-admin@example.test`}, true, 'pro') RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${admin!.id}, ${tag}, 'team', 'Invitation Studio') RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studio!.id}, ${admin!.id}, 'admin')
  `;
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${admin!.id}, ${`${tag}-personal`}, 'personal', 'Inviting Admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${admin!.id}, 'Invitation Project', ${`${tag}-project`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role)
    VALUES (${project!.id}, ${admin!.id}, 'owner')
  `;
  return {
    adminId: admin!.id,
    studioId: studio!.id,
    studioSlug: tag,
    projectId: project!.id,
    email: `${tag}-invitee@example.test`,
  };
}

/**
 * Invoke the public invitation service for the selected kind.
 * @param scope - The invitation kind.
 * @param fixture - The target and inviter.
 * @param email - The recipient address.
 * @returns The result returned to the route.
 * @throws {Error} When the service rejects the request.
 */
export async function createInvitation(
  scope: Scope,
  fixture: InvitationFixture,
  email = fixture.email,
): Promise<{ invitationId: string }> {
  return scope === "project"
    ? projectInvites.createInvite(fixture.projectId, fixture.adminId, email, "viewer", "http://localhost:8000")
    : studioInvites.createInvite(fixture.studioSlug, fixture.adminId, email, "guest", "http://localhost:8000");
}

/**
 * Read every invitation on the isolated target.
 * @param sql - The integration database connection.
 * @param scope - The invitation kind.
 * @param fixture - The isolated target.
 * @returns Invitation rows in creation order.
 * @throws {Error} When a database query fails.
 */
export async function invitationRows(sql: Sql, scope: Scope, fixture: InvitationFixture): Promise<InvitationRow[]> {
  const table = scope === "project" ? "project_invitations" : "studio_invitations";
  const targetColumn = scope === "project" ? "project_id" : "studio_id";
  const targetId = scope === "project" ? fixture.projectId : fixture.studioId;
  return sql<InvitationRow[]>`
    SELECT id, invited_user_id, invited_email, notification_id, share_token,
           status, failed_reason, claimed_at, expires_at
    FROM ${sql(table)} WHERE ${sql(targetColumn)} = ${targetId}
    ORDER BY created_at, id
  `;
}

/**
 * Revoke through the corresponding service.
 * @param scope - The invitation kind.
 * @param fixture - The target.
 * @param id - The invitation to revoke.
 * @returns Once the revocation commits.
 * @throws {Error} When the invitation cannot be revoked.
 */
export async function revokeInvitation(scope: Scope, fixture: InvitationFixture, id: string): Promise<void> {
  if (scope === "project") await projectInvites.revokeInvite(fixture.projectId, id);
  else await studioInvites.revokeInvite(fixture.studioSlug, id);
}

/**
 * Accept or decline through the existing invitation service.
 * @param scope - The invitation kind.
 * @param id - The invitation id.
 * @param userId - Its recipient.
 * @param accept - Whether the recipient accepts.
 * @returns Once the decision commits.
 * @throws {Error} When the invitation cannot be answered.
 */
export async function answerInvitation(scope: Scope, id: string, userId: string, accept: boolean): Promise<void> {
  const service = scope === "project" ? projectInvites : studioInvites;
  if (accept) await service.confirmInvite(id, userId);
  else await service.declineInvite(id, userId);
}

/**
 * Count actual memberships for the recipient on this target.
 * @param sql - The integration database connection.
 * @param scope - The invitation kind.
 * @param fixture - The target.
 * @param userId - The recipient.
 * @returns The number of active membership rows.
 * @throws {Error} When a database query fails.
 */
export async function membershipCount(sql: Sql, scope: Scope, fixture: InvitationFixture, userId: string): Promise<number> {
  const table = scope === "project" ? "project_members" : "studio_members";
  const targetColumn = scope === "project" ? "project_id" : "studio_id";
  const targetId = scope === "project" ? fixture.projectId : fixture.studioId;
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM ${sql(table)}
    WHERE ${sql(targetColumn)} = ${targetId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  return row!.count;
}

/** A controllable operation boundary used instead of elapsed-time guesses. */
export interface Gate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: Error) => void;
}

/**
 * Create a controllable boundary for one asynchronous operation.
 * @returns The promise and its completion controls.
 */
export function gate(): Gate {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Insert an email invitation before a registration or closing event.
 * @param sql - The integration database connection.
 * @param scope - The invitation kind.
 * @param fixture - The target and recipient.
 * @returns The persisted invitation.
 * @throws {Error} When a database query fails.
 */
export async function seedEmailInvitation(sql: Sql, scope: Scope, fixture: InvitationFixture): Promise<InvitationRow> {
  const table = scope === "project" ? "project_invitations" : "studio_invitations";
  const targetColumn = scope === "project" ? "project_id" : "studio_id";
  const targetId = scope === "project" ? fixture.projectId : fixture.studioId;
  const [row] = await sql<InvitationRow[]>`
    INSERT INTO ${sql(table)} (${sql(targetColumn)}, invited_email, invited_by, role, status, expires_at, share_token)
    VALUES (${targetId}, ${fixture.email}, ${fixture.adminId}, ${scope === "project" ? "viewer" : "guest"},
            'pending', now() + interval '2 days', ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "a")})
    RETURNING id, invited_user_id, invited_email, notification_id, share_token,
              status, failed_reason, claimed_at, expires_at
  `;
  return row!;
}

/**
 * Set the stored deadline before a transition.
 * @param sql - The integration database connection.
 * @param scope - The invitation kind.
 * @param id - The invitation id.
 * @returns Once the deadline is committed.
 * @throws {Error} When a database query fails.
 */
export async function expireInvitation(sql: Sql, scope: Scope, id: string): Promise<void> {
  const table = scope === "project" ? "project_invitations" : "studio_invitations";
  await sql`UPDATE ${sql(table)} SET expires_at = now() - interval '1 hour' WHERE id = ${id}`;
}

/**
 * Hold the target row while another connection reaches its serialization point.
 * @param sql - A pool distinct from the application's connection pool.
 * @param scope - The target kind.
 * @param fixture - The target to hold.
 * @returns A control that releases and awaits the holding transaction.
 * @throws {Error} When the database cannot lock the target.
 */
export async function holdTarget(sql: Sql, scope: Scope, fixture: InvitationFixture): Promise<{ release: () => void; done: Promise<unknown> }> {
  const entered = gate();
  const resume = gate();
  const table = scope === "project" ? "projects" : "studios";
  const id = scope === "project" ? fixture.projectId : fixture.studioId;
  const done = sql.begin(async (tx) => {
    await tx`SELECT id FROM ${tx(table)} WHERE id = ${id} FOR UPDATE`;
    entered.resolve();
    await resume.promise;
  });
  await Promise.race([entered.promise, done]);
  return { release: resume.resolve, done };
}

/**
 * Make real notification inserts fail until the returned cleanup is called.
 * @param sql - The integration database connection.
 * @param projectOnly - Whether Studio notifications may still commit.
 * @returns Cleanup for this test's trigger and function.
 * @throws {Error} When the database cannot install the failure boundary.
 */
export async function rejectNotificationWrites(sql: Sql, projectOnly = false): Promise<() => Promise<void>> {
  const triggerName = `reject_claim_${crypto.randomUUID().replaceAll("-", "")}`;
  await sql`CREATE FUNCTION ${sql(triggerName)}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_ARGV[0] = 'all' OR NEW.type = 'project.invite_request' THEN
        RAISE EXCEPTION 'notification insertion unavailable';
      END IF;
      RETURN NEW;
    END
  $$`;
  if (projectOnly) {
    await sql`CREATE TRIGGER ${sql(triggerName)} BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION ${sql(triggerName)}('project')`;
  } else {
    await sql`CREATE TRIGGER ${sql(triggerName)} BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION ${sql(triggerName)}('all')`;
  }
  return async () => {
    await sql`DROP TRIGGER ${sql(triggerName)} ON notifications`;
    await sql`DROP FUNCTION ${sql(triggerName)}()`;
  };
}
