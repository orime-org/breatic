/**
 * Auth critical-path invariants — `projectMembersRepo.getRole` against
 * a real Postgres.
 *
 * `getRole` is the single shared authorization primitive (server
 * `requireRole` middleware + collab `onAuthenticate`, both via
 * `loadProjectRole`). It resolves a caller's role on a project by an
 * inner-join of `project_members` and `projects`, filtering BOTH
 * `deleted_at IS NULL`. The mandated invariants (CLAUDE.md 关键路径 —
 * 鉴权 → 100% + invariant + property-based) are:
 *
 *   1. active member of an active project → that member's role
 *   2. non-member of an active project → null (never leaks existence)
 *   3. member of a SOFT-DELETED project → null, even if the member row
 *      itself still looks active (the project-active join is
 *      defence-in-depth: project soft-delete cascades to member rows in
 *      one transaction, but a lingering member row must still be denied)
 *   4. unknown project / unknown user → null
 *
 * The join semantics (WHERE filters) can only be verified against real
 * SQL — a mocked query builder would happily return whatever rows the
 * test stages regardless of the join. So this runs against the
 * testcontainer Postgres started by global-setup.ts. Seeding is done
 * with a narrow raw client; the assertions call the real `getRole`
 * (which uses core's env-bound `db`, pointed at the same container).
 *
 * Property-based (fast-check): for any pair of fresh random UUIDs with
 * no seeded membership, getRole is ALWAYS null — there is no input that
 * grants a role without an active membership row.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Mock `ai` BEFORE importing @breatic/core. The core barrel pulls
// agent/llm → the `ai` SDK → @opentelemetry/api, whose ESM build uses
// bare relative imports (e.g. './baggage/utils') that Node's native ESM
// rejects. This test only exercises getRole and never calls any ai
// function; the stubs just keep that broken ESM chain from loading at
// import time (same guard canvas-native-e2e uses).
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
import fc from "fast-check";
import { projectMembersRepo, initCore } from "@breatic/core";

// integration-setup.ts injects the container URLs into process.env but
// cannot call initCore itself (importing the core barrel pulls the `ai`
// SDK → otel). Each integration test injects the validated config — so
// getRole's env-bound `db` Proxy resolves to the testcontainer. Guarded
// because the worker process is shared (singleFork) with other suites
// that may have already initialised core.
try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "auth-role-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  const url = inject("DATABASE_URL");
  sql = postgres(url, {
    max: 2,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

async function insertUser(email: string): Promise<string> {
  // Balance lives in `credit_balances` since PR3 (migration 0020) — the
  // `users.credits` column no longer exists, so the seed inserts neither.
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${email}, true)
    RETURNING id
  `;
  return row!.id;
}

async function insertStudio(ownerUserId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO studios (owner_user_id, name)
    VALUES (${ownerUserId}, ${name})
    RETURNING id
  `;
  return row!.id;
}

async function insertProject(
  studioId: string,
  creatorUserId: string,
  name: string,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name)
    VALUES (${studioId}, ${creatorUserId}, ${name})
    RETURNING id
  `;
  return row!.id;
}

async function insertMember(
  projectId: string,
  userId: string,
  role: "owner" | "edit" | "view",
  addedBy: string | null,
): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, ${role}, ${addedBy})
  `;
}

/** Build a fully seeded project owned by a fresh user; returns the ids. */
async function seedProject(
  tag: string,
): Promise<{ studioId: string; projectId: string; ownerId: string }> {
  const ownerId = await insertUser(`owner-${tag}@example.com`);
  const studioId = await insertStudio(ownerId, `studio-${tag}`);
  const projectId = await insertProject(studioId, ownerId, `project-${tag}`);
  await insertMember(projectId, ownerId, "owner", null);
  return { studioId, projectId, ownerId };
}

describe("getRole — auth critical-path invariants (real Postgres)", () => {
  it("returns the role for an active member of an active project", async () => {
    const { projectId, ownerId } = await seedProject("active-owner");
    expect(await projectMembersRepo.getRole(projectId, ownerId)).toBe("owner");

    const editor = await insertUser("editor-active@example.com");
    await insertMember(projectId, editor, "edit", ownerId);
    expect(await projectMembersRepo.getRole(projectId, editor)).toBe("edit");

    const viewer = await insertUser("viewer-active@example.com");
    await insertMember(projectId, viewer, "view", ownerId);
    expect(await projectMembersRepo.getRole(projectId, viewer)).toBe("view");
  });

  it("returns null for a non-member of an active project (no existence leak)", async () => {
    const { projectId } = await seedProject("non-member");
    const stranger = await insertUser("stranger@example.com");
    expect(await projectMembersRepo.getRole(projectId, stranger)).toBeNull();
  });

  it("returns null when the project is soft-deleted, even if the member row still looks active", async () => {
    const { projectId, ownerId } = await seedProject("deleted-project");
    // Sanity: active before deletion.
    expect(await projectMembersRepo.getRole(projectId, ownerId)).toBe("owner");

    // Soft-delete ONLY the project row, leaving the member row active.
    // In production the cascade soft-deletes the member too; the
    // project-active join must deny access regardless (defence-in-depth).
    await sql`UPDATE projects SET deleted_at = NOW() WHERE id = ${projectId}`;

    expect(await projectMembersRepo.getRole(projectId, ownerId)).toBeNull();
  });

  it("returns null when the member row itself is soft-deleted (removed member)", async () => {
    const { projectId, ownerId } = await seedProject("removed-member");
    const removed = await insertUser("removed@example.com");
    await insertMember(projectId, removed, "edit", ownerId);
    expect(await projectMembersRepo.getRole(projectId, removed)).toBe("edit");

    await sql`
      UPDATE project_members SET deleted_at = NOW()
      WHERE project_id = ${projectId} AND user_id = ${removed}
    `;
    expect(await projectMembersRepo.getRole(projectId, removed)).toBeNull();
  });

  it("returns null for unknown project / unknown user uuids", async () => {
    const { projectId, ownerId } = await seedProject("unknown");
    const rows = await sql<{ a: string; b: string }[]>`
      SELECT gen_random_uuid() AS a, gen_random_uuid() AS b
    `;
    const missingProjectId = rows[0]!.a;
    const missingUserId = rows[0]!.b;
    // Real user, project that does not exist.
    expect(await projectMembersRepo.getRole(missingProjectId, ownerId)).toBeNull();
    // Real project, user that does not exist.
    expect(await projectMembersRepo.getRole(projectId, missingUserId)).toBeNull();
  });

  it("property: any fresh random (projectId, userId) with no seeded membership is always null", async () => {
    // No input shape grants a role without an active membership row —
    // the invariant a cross-tenant probe would try to violate.
    await fc.assert(
      fc.asyncProperty(fc.uuid(), fc.uuid(), async (projectId, userId) => {
        return (await projectMembersRepo.getRole(projectId, userId)) === null;
      }),
      { numRuns: 50 },
    );
  });
});
