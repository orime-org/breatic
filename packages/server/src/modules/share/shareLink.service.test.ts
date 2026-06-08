// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * shareLink.service unit tests — invariant enforcement.
 *
 * 2026-05-29 follow-up: tests now branch on the explicit `kind`
 * discriminator ('email' single-use vs 'link' multi-use) instead of
 * `boundEmail` nullness. DB-level CHECK keeps the two fields paired,
 * but application code reads `kind`.
 *
 * Covers email vs link kind semantics, expiry gate, role validation,
 * bound-email match gate, kind/boundEmail consistency, and the
 * consume race-condition path. Repo is mocked so tests run without
 * a PG connection.
 *
 * Spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 3.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";

vi.mock("./shareLink.repo.js", () => ({
  create: vi.fn(),
  findById: vi.fn(),
  findActiveByToken: vi.fn(),
  listByProject: vi.fn(),
  markConsumed: vi.fn(),
  softDelete: vi.fn(),
}));

vi.mock("@server/modules/project/project.repo.js", () => ({
  getProjectById: vi.fn(async () => ({ id: "p-1", name: "Proj" })),
}));

vi.mock("@server/modules/notification/notification.service.js", () => ({
  createMemberJoined: vi.fn(async () => ({ id: "n-1" })),
}));

// `db.transaction(cb)` runs `cb` with a fake tx handle so the unit
// tests exercise the consume flow without a Postgres connection.
// `projectMembersRepo` is mocked so the membership write / owner lookup
// can be asserted in isolation (real-PG coverage lives in the
// share-link-consume-membership integration suite).
const fakeTx = { __tx: true } as const;
vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      transaction: vi.fn(
        async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx),
      ),
    },
    projectMembersRepo: {
      getRole: vi.fn(async () => null),
      getOwner: vi.fn(async () => "u-owner"),
      upsertMember: vi.fn(async () => undefined),
    },
  };
});

import * as shareLinkRepo from "./shareLink.repo.js";
import {
  createLink,
  consumeLink,
  revokeLink,
  listByProject,
  generateToken,
} from "./shareLink.service.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  projectMembersRepo,
} from "@breatic/core";
import * as notificationService from "@server/modules/notification/notification.service.js";

const PID = "p-1";
const LID = "link-1";
const TOKEN = "t-base64url";
const OWNER = "u-owner";
const CONSUMER = "u-consumer";
const CALLER_EMAIL = "caller@example.com";
const BOUND_EMAIL = "invited@example.com";

type ShareLinkEntity = NonNullable<
  Awaited<ReturnType<typeof shareLinkRepo.findById>>
>;

function fakeLink(overrides: Partial<{
  id: string;
  projectId: string;
  token: string;
  role: string;
  kind: "email" | "link";
  boundEmail: string | null;
  consumedAt: Date | null;
  expiresAt: Date | null;
  deletedAt: Date | null;
}> = {}): ShareLinkEntity {
  // Default to a kind that's consistent with the boundEmail override
  // so each test doesn't have to spell out both — but tests that need
  // to assert the invariant pass `kind` explicitly.
  const boundEmail = overrides.boundEmail ?? null;
  const kind = overrides.kind ?? (boundEmail !== null ? "email" : "link");
  return {
    id: overrides.id ?? LID,
    projectId: overrides.projectId ?? PID,
    createdByUserId: OWNER,
    token: overrides.token ?? TOKEN,
    role: overrides.role ?? "viewer",
    kind,
    boundEmail,
    consumedAt: overrides.consumedAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: overrides.deletedAt ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-arm the default "caller is not yet a member" + owner-lookup mocks
  // that clearAllMocks wiped (the factory's default impls are cleared).
  vi.mocked(projectMembersRepo.getRole).mockResolvedValue(null);
  vi.mocked(projectMembersRepo.getOwner).mockResolvedValue(OWNER);
  vi.mocked(projectMembersRepo.upsertMember).mockResolvedValue(undefined);
});

describe("generateToken", () => {
  it("returns a base64url-encoded string of ~43 chars (32 bytes)", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token.length).toBeLessThanOrEqual(50);
  });

  it("generates a different token on each call", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

describe("createLink", () => {
  it("rejects role='owner' with ValidationError", async () => {
    await expect(
      createLink({
        projectId: PID,
        createdByUserId: OWNER,
        role: "owner",
        kind: "link",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(shareLinkRepo.create).not.toHaveBeenCalled();
  });

  it("rejects unknown role string with ValidationError", async () => {
    await expect(
      createLink({
        projectId: PID,
        createdByUserId: OWNER,
        role: "admin",
        kind: "link",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects kind='email' without boundEmail with ValidationError", async () => {
    await expect(
      createLink({
        projectId: PID,
        createdByUserId: OWNER,
        role: "viewer",
        kind: "email",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(shareLinkRepo.create).not.toHaveBeenCalled();
  });

  it("rejects kind='link' WITH a boundEmail with ValidationError", async () => {
    await expect(
      createLink({
        projectId: PID,
        createdByUserId: OWNER,
        role: "viewer",
        kind: "link",
        boundEmail: BOUND_EMAIL,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(shareLinkRepo.create).not.toHaveBeenCalled();
  });

  it("creates a kind='link' (multi-use, no boundEmail, no expiry) with role=viewer", async () => {
    vi.mocked(shareLinkRepo.create).mockResolvedValueOnce(
      fakeLink({ kind: "link", boundEmail: null, expiresAt: null }),
    );
    const out = await createLink({
      projectId: PID,
      createdByUserId: OWNER,
      role: "viewer",
      kind: "link",
    });
    expect(out.kind).toBe("link");
    expect(out.boundEmail).toBeNull();
    expect(out.expiresAt).toBeNull();
    const args = vi.mocked(shareLinkRepo.create).mock.calls[0]?.[0];
    expect(args?.role).toBe("viewer");
    expect(args?.kind).toBe("link");
    expect(args?.boundEmail).toBeNull();
    expect(args?.expiresAt).toBeNull();
    expect(args?.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("creates a kind='email' link (single-use, boundEmail set) with role=editor + 7-day expiry", async () => {
    vi.mocked(shareLinkRepo.create).mockImplementationOnce(async (input) =>
      fakeLink({
        kind: input.kind,
        boundEmail: input.boundEmail,
        role: input.role,
        expiresAt: input.expiresAt,
      }),
    );
    const before = Date.now();
    const out = await createLink({
      projectId: PID,
      createdByUserId: OWNER,
      role: "editor",
      kind: "email",
      boundEmail: BOUND_EMAIL,
    });
    expect(out.kind).toBe("email");
    expect(out.boundEmail).toBe(BOUND_EMAIL);
    expect(out.role).toBe("editor");
    // 7-day TTL: ~604_800_000 ms in the future (slack ± 1 minute).
    expect(out.expiresAt).not.toBeNull();
    const delta = out.expiresAt!.getTime() - before;
    expect(delta).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 60_000);
    expect(delta).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 60_000);
  });

  it("translates Postgres token collision (23505) to Conflict", async () => {
    vi.mocked(shareLinkRepo.create).mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "23505" }),
    );
    await expect(
      createLink({
        projectId: PID,
        createdByUserId: OWNER,
        role: "viewer",
        kind: "link",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("consumeLink", () => {
  it("throws NotFound when the token doesn't match any active link", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(null);
    await expect(
      consumeLink(TOKEN, CONSUMER, CALLER_EMAIL),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws Forbidden when the link is expired", async () => {
    const past = new Date(Date.now() - 1000);
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ kind: "email", boundEmail: BOUND_EMAIL, expiresAt: past }),
    );
    await expect(
      consumeLink(TOKEN, CONSUMER, BOUND_EMAIL),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
    expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
  });

  it("throws Forbidden when bound email doesn't match caller email (kind='email')", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ kind: "email", boundEmail: BOUND_EMAIL }),
    );
    await expect(
      consumeLink(TOKEN, CONSUMER, "other@example.com"),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
    expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
  });

  it("throws Forbidden when kind='email' link was already consumed", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ kind: "email", boundEmail: BOUND_EMAIL, consumedAt: new Date() }),
    );
    await expect(
      consumeLink(TOKEN, CONSUMER, BOUND_EMAIL),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
    expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
  });

  it("throws Forbidden when concurrent consume races (markConsumed returns false)", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ kind: "email", boundEmail: BOUND_EMAIL, consumedAt: null }),
    );
    vi.mocked(shareLinkRepo.markConsumed).mockResolvedValueOnce(false);
    await expect(
      consumeLink(TOKEN, CONSUMER, BOUND_EMAIL),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // The race aborts the transaction before any membership write.
    expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
  });

  it("consumes a kind='email' link: spends token + enrolls member + notifies owner", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ kind: "email", boundEmail: BOUND_EMAIL, role: "editor", consumedAt: null }),
    );
    vi.mocked(shareLinkRepo.markConsumed).mockResolvedValueOnce(true);
    const out = await consumeLink(TOKEN, CONSUMER, BOUND_EMAIL);
    expect(out.consumedAt).toBeInstanceOf(Date);
    expect(shareLinkRepo.markConsumed).toHaveBeenCalledWith(LID, expect.anything());
    expect(projectMembersRepo.upsertMember).toHaveBeenCalledWith(
      PID,
      CONSUMER,
      "editor",
      OWNER, // link.createdByUserId
      expect.anything(),
    );
    expect(notificationService.createMemberJoined).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: OWNER,
        projectId: PID,
        payload: expect.objectContaining({ newMemberUserId: CONSUMER, role: "editor" }),
      }),
    );
  });

  it("kind='link' consume: enrolls member without touching consumed_at", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ kind: "link", boundEmail: null, role: "viewer" }),
    );
    const out = await consumeLink(TOKEN, CONSUMER, CALLER_EMAIL);
    expect(out.kind).toBe("link");
    expect(out.boundEmail).toBeNull();
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
    expect(projectMembersRepo.upsertMember).toHaveBeenCalledWith(
      PID,
      CONSUMER,
      "viewer",
      OWNER,
      expect.anything(),
    );
  });

  it("does NOT downgrade / re-notify when the caller is already a member", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce("owner");
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ kind: "link", boundEmail: null, role: "viewer" }),
    );
    const out = await consumeLink(TOKEN, CONSUMER, CALLER_EMAIL);
    expect(out.kind).toBe("link");
    expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
    expect(notificationService.createMemberJoined).not.toHaveBeenCalled();
  });

  it("kind='email' already-member: still spends the token but does NOT re-enroll/notify", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce("editor");
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ kind: "email", boundEmail: BOUND_EMAIL, consumedAt: null }),
    );
    vi.mocked(shareLinkRepo.markConsumed).mockResolvedValueOnce(true);
    await consumeLink(TOKEN, CONSUMER, BOUND_EMAIL);
    expect(shareLinkRepo.markConsumed).toHaveBeenCalledWith(LID, expect.anything());
    expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
    expect(notificationService.createMemberJoined).not.toHaveBeenCalled();
  });

  it("does NOT notify when the consumer IS the owner (owner clicking own link)", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);
    vi.mocked(projectMembersRepo.getOwner).mockResolvedValueOnce(CONSUMER);
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ kind: "link", boundEmail: null, role: "viewer" }),
    );
    await consumeLink(TOKEN, CONSUMER, CALLER_EMAIL);
    expect(notificationService.createMemberJoined).not.toHaveBeenCalled();
  });
});

describe("revokeLink", () => {
  it("throws NotFound when the link doesn't exist or already revoked", async () => {
    vi.mocked(shareLinkRepo.softDelete).mockResolvedValueOnce(false);
    await expect(revokeLink(LID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("soft-deletes successfully when the link is active", async () => {
    vi.mocked(shareLinkRepo.softDelete).mockResolvedValueOnce(true);
    await expect(revokeLink(LID)).resolves.toBeUndefined();
    expect(shareLinkRepo.softDelete).toHaveBeenCalledWith(LID);
  });
});

describe("listByProject", () => {
  it("delegates to repo", async () => {
    vi.mocked(shareLinkRepo.listByProject).mockResolvedValueOnce([fakeLink()]);
    const out = await listByProject(PID);
    expect(out).toHaveLength(1);
    expect(shareLinkRepo.listByProject).toHaveBeenCalledWith(PID);
  });
});

// ── Fast-check property-based tests (PR-d TDD backfill #614) ───────
//
// shareLink sits on the auth critical path: every consume can mint
// project_members. The properties below lock the email-invite vs
// Generate invariants under arbitrary input.

describe("createLink — property: only 'viewer'/'editor' grantable via share link", () => {
  it("rejects any role string that isn't 'viewer' or 'editor' with ValidationError", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (role) => {
        if (role === "viewer" || role === "editor") return;
        await expect(
          createLink({
            projectId: PID,
            createdByUserId: OWNER,
            role,
            kind: "link",
          }),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(shareLinkRepo.create).not.toHaveBeenCalled();
        vi.clearAllMocks();
      }),
      { numRuns: 50 },
    );
  });
});

describe("consumeLink — property: kind='link' is idempotent + never calls markConsumed", () => {
  it("any number of consume calls on a kind='link' link never mutates consumed_at", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (n) => {
        vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValue(
          fakeLink({ kind: "link", boundEmail: null, consumedAt: null }),
        );
        for (let i = 0; i < n; i++) {
          const out = await consumeLink(TOKEN, CONSUMER, CALLER_EMAIL);
          expect(out.kind).toBe("link");
        }
        expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
        vi.clearAllMocks();
        vi.mocked(projectMembersRepo.getRole).mockResolvedValue(null);
        vi.mocked(projectMembersRepo.getOwner).mockResolvedValue(OWNER);
      }),
      { numRuns: 20 },
    );
  });
});

describe("consumeLink — property: expired links never reach markConsumed regardless of kind", () => {
  it("any link expired in the past + (kind='email' OR kind='link') is rejected before any mutation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.boolean(),
        async (msInPast, isEmailKind) => {
          const past = new Date(Date.now() - msInPast);
          vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
            fakeLink({
              kind: isEmailKind ? "email" : "link",
              boundEmail: isEmailKind ? BOUND_EMAIL : null,
              expiresAt: past,
            }),
          );
          await expect(
            consumeLink(TOKEN, CONSUMER, isEmailKind ? BOUND_EMAIL : CALLER_EMAIL),
          ).rejects.toBeInstanceOf(ForbiddenError);
          expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
          vi.clearAllMocks();
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("consumeLink — property: kind='email' link always rejects mismatched caller email", () => {
  it("any caller email that isn't the bound email gets Forbidden", async () => {
    await fc.assert(
      fc.asyncProperty(fc.emailAddress(), async (callerEmail) => {
        if (callerEmail === BOUND_EMAIL) return;
        vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
          fakeLink({ kind: "email", boundEmail: BOUND_EMAIL, consumedAt: null }),
        );
        await expect(
          consumeLink(TOKEN, CONSUMER, callerEmail),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
        vi.clearAllMocks();
      }),
      { numRuns: 30 },
    );
  });
});
