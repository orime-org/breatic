// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Role-upgrade decision concurrency invariant — `approve` / `reject` must
 * decide a single request EXACTLY ONCE under concurrency, against a real
 * Postgres.
 *
 * The decision flow (gate the request → bump member role → create the
 * outcome notification → mark the request read) is supposed to be atomic
 * and once-only: a request can be approved XOR rejected, exactly one time.
 * The `notifications.mark-read` is a compare-and-swap (UPDATE … WHERE
 * read_at IS NULL) that is meant to be the serialization point — only the
 * first decision flips read_at, the rest must abort.
 *
 * This invariant is SQL-level (transaction + row-lock / CAS semantics) and
 * can only be proven against a real Postgres — a mocked query builder can't
 * reproduce two connections racing on the same row. A regression here lets
 * a double-click (or two devices) approve the same request twice, or
 * approve AND reject it, double-bumping roles / sending conflicting
 * notifications.
 *
 * Runs against the testcontainer Postgres + Redis started by global-setup.ts.
 * Seeding uses a narrow raw `postgres` client; the assertions drive the real
 * `roleUpgradeRequest.service` (core's env-bound `db`).
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/core. The core barrel pulls
// agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build uses bare
// relative imports Node's native ESM rejects. This suite never calls any ai
// function; the stubs keep that broken ESM chain from loading at import time
// (same guard the credit-balance / auth-role suites use).
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import postgres from "postgres";
import { initCore } from "@breatic/core";
import * as roleUpgradeService from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";

// integration-setup.ts injects the container URLs into process.env but cannot
// call initCore itself (importing the core barrel pulls the `ai` SDK → otel).
// Inject the validated config so the service's env-bound `db` resolves to the
// testcontainer. Guarded because the worker process is shared (singleFork)
// with sibling suites that may have already initialised core.
try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "role-upgrade-concurrency-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  const url = inject("DATABASE_URL");
  sql = postgres(url, {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

async function insertUser(tag: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`ru-${tag}-${seq++}@example.com`}, true)
    RETURNING id
  `;
  return row!.id;
}

async function insertStudio(createdByUserId: string, tag: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${`ru-studio-${tag}-${seq++}`}, 'personal', ${`studio-${tag}`})
    RETURNING id
  `;
  return row!.id;
}

async function insertProject(
  studioId: string,
  creatorUserId: string,
  tag: string,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${creatorUserId}, ${`proj-${tag}`}, ${`proj-${tag}`})
    RETURNING id
  `;
  return row!.id;
}

async function insertMember(
  projectId: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
  addedBy: string | null,
): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, ${role}, ${addedBy})
  `;
}

async function insertRoleUpgradeRequest(
  ownerId: string,
  requesterId: string,
  projectId: string,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO notifications (user_id, type, payload, project_id)
    VALUES (
      ${ownerId},
      'access.role_upgrade_request',
      ${sql.json({ requesterUserId: requesterId, projectName: "Demo", requestedRole: "editor" })},
      ${projectId}
    )
    RETURNING id
  `;
  return row!.id;
}

interface Seeded {
  ownerId: string;
  requesterId: string;
  projectId: string;
  requestId: string;
}

/** Owner + a `viewer` member + a pending role-upgrade request notification. */
async function seedRequest(tag: string): Promise<Seeded> {
  const ownerId = await insertUser(`owner-${tag}`);
  const requesterId = await insertUser(`viewer-${tag}`);
  const studioId = await insertStudio(ownerId, tag);
  const projectId = await insertProject(studioId, ownerId, tag);
  await insertMember(projectId, ownerId, "owner", null);
  await insertMember(projectId, requesterId, "viewer", ownerId);
  const requestId = await insertRoleUpgradeRequest(ownerId, requesterId, projectId);
  return { ownerId, requesterId, projectId, requestId };
}

async function countByType(userId: string, type: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM notifications
    WHERE user_id = ${userId} AND type = ${type} AND deleted_at IS NULL
  `;
  return rows[0]!.c;
}

async function memberRole(
  projectId: string,
  userId: string,
): Promise<string | null> {
  const rows = await sql<{ role: string }[]>`
    SELECT role FROM project_members
    WHERE project_id = ${projectId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  return rows[0]?.role ?? null;
}

describe("role-upgrade decision is once-only under concurrency", () => {
  it("two concurrent approves decide the request exactly once", async () => {
    const { ownerId, requesterId, projectId, requestId } =
      await seedRequest("dup-approve");

    const results = await Promise.allSettled([
      roleUpgradeService.approve({
        notificationId: requestId,
        ownerUserId: ownerId,
        projectName: "Demo",
        projectSlug: "demo-slug",
      }),
      roleUpgradeService.approve({
        notificationId: requestId,
        ownerUserId: ownerId,
        projectName: "Demo",
        projectSlug: "demo-slug",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;

    // Decide-once: exactly one approve wins, the loser is rejected
    // (request already decided).
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    // The requester must receive EXACTLY ONE approved notification, not two.
    expect(await countByType(requesterId, "access.role_upgrade_approved")).toBe(1);
    // The member is bumped to editor (once).
    expect(await memberRole(projectId, requesterId)).toBe("editor");
  });

  it("concurrent approve + reject lands exactly one outcome, never both", async () => {
    const { ownerId, requesterId, projectId, requestId } =
      await seedRequest("approve-reject");

    const results = await Promise.allSettled([
      roleUpgradeService.approve({
        notificationId: requestId,
        ownerUserId: ownerId,
        projectName: "Demo",
        projectSlug: "demo-slug",
      }),
      roleUpgradeService.reject({
        notificationId: requestId,
        ownerUserId: ownerId,
        projectName: "Demo",
        projectSlug: "demo-slug",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBe(1);

    const approved = await countByType(requesterId, "access.role_upgrade_approved");
    const rejected = await countByType(requesterId, "access.role_upgrade_rejected");
    // The requester gets exactly ONE outcome — approved XOR rejected.
    expect(approved + rejected).toBe(1);

    // The member role must agree with the single winning decision.
    const role = await memberRole(projectId, requesterId);
    if (approved === 1) {
      expect(role).toBe("editor");
    } else {
      expect(role).toBe("viewer");
    }
  });
});
