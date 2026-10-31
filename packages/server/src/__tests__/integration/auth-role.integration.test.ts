// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Auth critical-path invariants — `projectMembersRepo.getRole` against
 * a real Postgres.
 *
 * `getRole` is the single shared authorization primitive (server
 * `requireRole` middleware + collab `onAuthenticate`, both via
 * `loadProjectRole`). It resolves a caller's role on a project by an
 * inner-join of `project_members` and `projects`, filtering BOTH
 * `deleted_at IS NULL`. The mandated invariants (AGENTS.md#critical-paths —
 * auth → 100% + invariant + property-based) are:
 *
 *   1. active member of an active project → that member's role
 *   2. non-member of an active project → null (never leaks existence)
 *   3. member of a SOFT-DELETED project → null, even if the member row
 *      itself still looks active (the project-active join denies it
 *      whatever the member rows say)
 *   4. unknown project / unknown user → null
 *
 * The join semantics (WHERE filters) can only be verified against real
 * SQL — a mocked query builder would happily return whatever rows the
 * test stages regardless of the join. So this runs against the
 * testcontainer Postgres started by @breatic/integration-tests/containers. Seeding is done
 * with a narrow raw client; the assertions call the real `getRole`
 * (which uses core's env-bound `db`, pointed at the same container).
 *
 * Property-based (fast-check): for any pair of fresh random UUIDs with
 * no seeded membership, getRole is ALWAYS null — there is no input that
 * grants a role without an active membership row.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
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

import crypto from "node:crypto";
import postgres from "postgres";
import fc from "fast-check";
import { projectMembersRepo, projectAuthService, initCore } from "@breatic/core";

// @breatic/integration-tests/env injects the container URLs into process.env but
// deliberately does not call initCore itself — a setup file runs for
// every suite, so importing the core barrel there would pull the
// application into every module graph. Each integration test injects the validated config — so
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
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${email}, true)
    RETURNING id
  `;
  return row!.id;
}

let authRoleStudioSeq = 0;
async function insertStudio(createdByUserId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${createdByUserId}, ${`ar-studio-${authRoleStudioSeq++}`}, 'personal', ${name})
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
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${creatorUserId}, ${name}, ${name})
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
    await insertMember(projectId, editor, "editor", ownerId);
    expect(await projectMembersRepo.getRole(projectId, editor)).toBe("editor");

    const viewer = await insertUser("viewer-active@example.com");
    await insertMember(projectId, viewer, "viewer", ownerId);
    expect(await projectMembersRepo.getRole(projectId, viewer)).toBe("viewer");
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
    await insertMember(projectId, removed, "editor", ownerId);
    expect(await projectMembersRepo.getRole(projectId, removed)).toBe("editor");

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

/**
 * What the id columns hold: Postgres's canonical text form of a uuid, any
 * version and variant, either case.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fresh uuid whose version nibble is 0: canonical in shape, not RFC 4122. */
function versionZeroUuid(): string {
  const hex = crypto.randomBytes(16).toString("hex").split("");
  hex[12] = "0";
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

describe("getAccess / loadProjectRole / loadProjectAccess — project id shape (real Postgres)", () => {
  interface ShapeScene {
    userId: string;
    /** U is editor, live. */
    p: string;
    /** U is owner, archived. */
    q: string;
    /** U is not a member. */
    r: string;
    /** Version-0 id, U is viewer. */
    z: string;
  }
  let scene: ShapeScene;

  beforeAll(async () => {
    const userId = await insertUser("shape-u@example.com");
    const other = await seedProject("shape-p");
    await insertMember(other.projectId, userId, "editor", other.ownerId);
    const archivedStudio = await insertStudio(userId, "studio-shape-q");
    const archived = { projectId: await insertProject(archivedStudio, userId, "project-shape-q") };
    await insertMember(archived.projectId, userId, "owner", null);
    await sql`
      UPDATE projects SET archived_at = NOW(), archived_by_user_id = ${userId} WHERE id = ${archived.projectId}
    `;
    const stranger = await seedProject("shape-r");
    const z = versionZeroUuid();
    await sql`
      INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
      VALUES (${z}, ${other.studioId}, ${other.ownerId}, 'shape-z', 'shape-z')
    `;
    await insertMember(z, userId, "viewer", other.ownerId);
    scene = { userId, p: other.projectId, q: archived.projectId, r: stranger.projectId, z };
  });

  /**
   * Ask all three readers about one project id.
   * @param projectId - The id under test
   * @returns The three answers
   */
  async function askAll(projectId: string): Promise<[unknown, unknown, unknown]> {
    return Promise.all([
      projectMembersRepo.getAccess(projectId, scene.userId),
      projectAuthService.loadProjectRole(scene.userId, projectId),
      projectAuthService.loadProjectAccess(scene.userId, projectId),
    ]);
  }

  const notUuid: Array<[string, () => string]> = [
    ["C1 plain text", () => "not-a-uuid"],
    ["C2 empty string", () => ""],
    ["C3 36 chars in uuid layout but not hex", () => "gggggggg-gggg-gggg-gggg-gggggggggggg"],
    ["C4 36 hex-or-hyphen chars in the wrong layout", () => "--------------------------------0123"],
    ["C5 a member's id followed by SQL-looking text", () => `${scene.p}' OR '1'='1`],
    ["C6 a member's id with a trailing newline", () => `${scene.p}\n`],
    ["C7 a member's id in braces", () => `{${scene.p}}`],
    ["C8 a member's id without hyphens", () => scene.p.replaceAll("-", "")],
  ];

  for (const [name, id] of notUuid) {
    it(`${name}: all three answer no access without throwing`, async () => {
      expect(await askAll(id())).toEqual([null, null, null]);
    });
  }

  it("C9 an upper-case uuid keeps the member's answer", async () => {
    expect(await askAll(scene.p.toUpperCase())).toEqual([
      { role: "editor", archived: false },
      "editor",
      { role: "editor", archived: false },
    ]);
  });

  it("C10 the canonical id keeps the member's answer", async () => {
    expect(await askAll(scene.p)).toEqual([
      { role: "editor", archived: false },
      "editor",
      { role: "editor", archived: false },
    ]);
  });

  it("C11 an archived project still caps the role at viewer", async () => {
    expect(await askAll(scene.q)).toEqual([
      { role: "owner", archived: true },
      "viewer",
      { role: "owner", archived: true },
    ]);
  });

  it("C12 a uuid-shaped project the caller is not on answers no access", async () => {
    expect(await askAll(scene.r)).toEqual([null, null, null]);
  });

  it("C13 a version-0 uuid is a uuid: its member gets their role", async () => {
    expect(await askAll(scene.z)).toEqual([
      { role: "viewer", archived: false },
      "viewer",
      { role: "viewer", archived: false },
    ]);
  });

  it("C14 property: no string outside the uuid shape is ever sent to the uuid column", async () => {
    const variants = fc.constantFrom(
      (id: string) => `{${id}}`,
      (id: string) => id.replaceAll("-", ""),
      (id: string) => ` ${id}`,
      (id: string) => `${id} `,
      (id: string) => `${id}\n`,
      (id: string) => `urn:uuid:${id}`,
      (id: string) => id.slice(0, -1),
    );
    const fromMember = fc
      .tuple(variants, fc.string({ maxLength: 2 }))
      .map(([shape, tail]) => shape(scene.p) + tail);
    const arbitrary = fc.oneof(fc.string(), fc.string({ unit: "binary" }), fc.constant("\u0000"));
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(arbitrary, fromMember).filter((s) => !UUID_SHAPE.test(s)),
        async (projectId) => {
          expect(await projectMembersRepo.getAccess(projectId, scene.userId)).toBeNull();
          expect(await projectAuthService.loadProjectAccess(scene.userId, projectId)).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});
