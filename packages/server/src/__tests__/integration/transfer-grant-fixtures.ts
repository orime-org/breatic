// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Seeding and reading helpers for the transfer ticket, finish and grant-state
 * suites (inner#1006 §4.2–§4.4, §7). Not a test file: the suites that import
 * it are `transfer-ticket.*`, `transfer-finish.*` and `transfer-grant-model.*`.
 *
 * A transfer grant in a given state is written by the grant repository
 * directly, so a case about one cell of the transition table never depends on
 * the ticket route having worked.
 */

import crypto from "node:crypto";
import { vi } from "vitest";
import type postgres from "postgres";
import { getRedis, setSession, sessionCookieName, storageKey } from "@breatic/core";
import { uploadGrantRepo, type UploadFinishJob } from "@breatic/domain";
import { INGEST_FAILURE_HEADER } from "@breatic/shared";

export type Sql = ReturnType<typeof postgres>;

/** The content type every transfer ticket signs (design §4.8). */
export const TRANSFER_TYPE = "application/vnd.breatic.transfer";

let seq = 0;

/** A user with a session. */
export interface SeededUser {
  userId: string;
  cookie: string;
}

/** A user who owns a project in their own personal studio. */
export interface SeededOwner extends SeededUser {
  studioId: string;
  projectId: string;
}

/**
 * A fresh verified user with a live session.
 * @param sql - The test's own connection.
 * @param tier - The membership tier to give the account.
 * @returns The user id and the session cookie.
 */
export async function seedUser(sql: Sql, tier = "base"): Promise<SeededUser> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`tr-${seq++}-${crypto.randomUUID()}@example.com`}, true, ${tier}) RETURNING id
  `;
  const userId = rows[0]!.id;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * A user, their personal studio, and a project they own in it.
 * @param sql - The test's own connection.
 * @returns The ids and the session cookie.
 */
export async function seedOwner(sql: Sql): Promise<SeededOwner> {
  const user = await seedUser(sql);
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user.userId}, ${`tr-s-${seq++}-${crypto.randomBytes(3).toString("hex")}`}, 'personal', 'Personal')
    RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${user.userId}, 'admin')
  `;
  const slug = `tr-p-${seq++}-${crypto.randomBytes(3).toString("hex")}`;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${user.userId}, ${`P ${slug}`}, ${slug}) RETURNING id
  `;
  const projectId = projects[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${user.userId}, 'owner', null)
  `;
  return { ...user, studioId, projectId };
}

/**
 * A fresh user who is a member of `projectId` with `role`.
 * @param sql - The test's own connection.
 * @param projectId - The project to join.
 * @param role - Their project role.
 * @returns The user id and the session cookie.
 */
export async function seedMember(
  sql: Sql,
  projectId: string,
  role: "editor" | "viewer",
): Promise<SeededUser> {
  const user = await seedUser(sql);
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${user.userId}, ${role}, null)
  `;
  return user;
}

/**
 * Open a transfer grant the way the ticket route records one (design §4.2),
 * straight through the grant repository.
 * @param owner - Whose upload it is and where it lands.
 * @param declaredSize - The whole transfer file's size, signature included.
 * @returns The minted storage key.
 */
export async function openTransferGrant(owner: SeededOwner, declaredSize = 1500019): Promise<string> {
  const key = storageKey({ taskType: "transfer", ext: ".transfer" });
  await uploadGrantRepo.issueGrant({
    userId: owner.userId,
    studioId: owner.studioId,
    storageKey: key,
    declaredSize,
    expiresAt: new Date(Date.now() + 300_000),
    context: {
      projectId: owner.projectId,
      nodeId: null,
      spaceId: null,
      derived: true,
      filename: "body.transfer",
      // The grant's type does not admit "transfer" until the design lands;
      // the column is plain text, so the row is written as production will.
      assetSource: "transfer" as unknown as "upload",
    },
  });
  return key;
}

/** The grant columns the state cases read, timestamps as full-precision SQL text. */
export interface GrantRow {
  consumed_at: string | null;
  voided_at: string | null;
  asset_id: string | null;
  failure_reason: string | null;
  finalizing_upload_id: string | null;
  asset_source: string | null;
}

/**
 * Read a grant's state columns. Timestamps come back as text so a later
 * comparison keeps microseconds, which `Date` would drop.
 * @param sql - The test's own connection.
 * @param key - The grant's storage key.
 * @returns The row, or null when no grant has that key.
 */
export async function grantRow(sql: Sql, key: string): Promise<GrantRow | null> {
  const rows = await sql<GrantRow[]>`
    SELECT consumed_at::text AS consumed_at, voided_at::text AS voided_at,
           asset_id, failure_reason, finalizing_upload_id, asset_source
    FROM upload_grants WHERE storage_key = ${key}
  `;
  return rows[0] ?? null;
}

/**
 * The finish job the route would queue for a transfer grant.
 * @param key - The grant's storage key.
 * @param uploadId - The multipart upload id.
 * @returns The job.
 */
export function transferJob(key: string, uploadId = "transfer-upload-1"): UploadFinishJob {
  return {
    storageKey: key,
    uploadId,
    token: "transfer-session-token",
    parts: [{ partNumber: 1, etag: "etag-1" }],
    // The job type does not admit "transfer" until the design lands.
    assetSource: "transfer" as unknown as UploadFinishJob["assetSource"],
  };
}

/** What the stubbed Worker saw on its finish endpoint. */
export interface WorkerCall {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Stand the ingest Worker's finish endpoint in with a 200 measurement.
 * @param answer - What the Worker measured.
 * @param answer.contentType - The type it read off the stored bytes.
 * @param answer.sizeBytes - The stored object's size.
 * @returns Every call the stub received, in order.
 */
export function workerAnswers(answer: { contentType: string; sizeBytes: number }): WorkerCall[] {
  const calls: WorkerCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> });
      return new Response(
        JSON.stringify({ sha256: crypto.randomBytes(32).toString("hex"), ...answer }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return calls;
}

/**
 * Stand the ingest Worker's finish endpoint in with a refusal.
 * @param status - The HTTP status it answers.
 * @param code - The failure code in its failure header.
 * @returns Every call the stub received, in order.
 */
export function workerRefuses(status: number, code: string): WorkerCall[] {
  const calls: WorkerCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> });
      return new Response("", { status, headers: { [INGEST_FAILURE_HEADER]: code } });
    }),
  );
  return calls;
}

/**
 * Make the ingest Worker's finish endpoint throw `error` instead of answering.
 * @param error - What the call throws.
 */
export function workerThrows(error: Error): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw error;
    }),
  );
}
