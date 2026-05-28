/**
 * shareLink.service unit tests — invariant enforcement.
 *
 * Covers the single-use vs permanent semantics, expiry gate, role
 * validation, and the consume race-condition path. Repo is mocked
 * so tests run without a PG connection.
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
} from "../errors.js";

const PID = "p-1";
const LID = "link-1";
const TOKEN = "t-base64url";
const OWNER = "u-owner";

type ShareLinkEntity = NonNullable<
  Awaited<ReturnType<typeof shareLinkRepo.findById>>
>;

function fakeLink(overrides: Partial<{
  id: string;
  projectId: string;
  token: string;
  role: string;
  isPermanent: boolean;
  consumedAt: Date | null;
  expiresAt: Date | null;
  deletedAt: Date | null;
}> = {}): ShareLinkEntity {
  return {
    id: overrides.id ?? LID,
    projectId: overrides.projectId ?? PID,
    createdByUserId: OWNER,
    token: overrides.token ?? TOKEN,
    role: overrides.role ?? "view",
    isPermanent: overrides.isPermanent ?? false,
    consumedAt: overrides.consumedAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: overrides.deletedAt ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
        isPermanent: false,
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
        isPermanent: false,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("creates a single-use link with role=view", async () => {
    vi.mocked(shareLinkRepo.create).mockResolvedValueOnce(
      fakeLink({ isPermanent: false }),
    );
    const out = await createLink({
      projectId: PID,
      createdByUserId: OWNER,
      role: "view",
      isPermanent: false,
    });
    expect(out.isPermanent).toBe(false);
    const args = vi.mocked(shareLinkRepo.create).mock.calls[0]?.[0];
    expect(args?.role).toBe("view");
    expect(args?.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("creates a permanent link with role=edit + expiresAt", async () => {
    const expires = new Date(Date.now() + 86400_000);
    vi.mocked(shareLinkRepo.create).mockResolvedValueOnce(
      fakeLink({ isPermanent: true, role: "edit", expiresAt: expires }),
    );
    const out = await createLink({
      projectId: PID,
      createdByUserId: OWNER,
      role: "edit",
      isPermanent: true,
      expiresAt: expires,
    });
    expect(out.isPermanent).toBe(true);
    expect(out.role).toBe("edit");
  });

  it("translates Postgres token collision (23505) to Conflict", async () => {
    vi.mocked(shareLinkRepo.create).mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "23505" }),
    );
    await expect(
      createLink({
        projectId: PID,
        createdByUserId: OWNER,
        role: "view",
        isPermanent: false,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("consumeLink", () => {
  it("throws NotFound when the token doesn't match any active link", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(null);
    await expect(consumeLink(TOKEN)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws Forbidden when the link is expired", async () => {
    const past = new Date(Date.now() - 1000);
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ expiresAt: past }),
    );
    await expect(consumeLink(TOKEN)).rejects.toBeInstanceOf(ForbiddenError);
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
  });

  it("throws Forbidden when single-use link was already consumed", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ isPermanent: false, consumedAt: new Date() }),
    );
    await expect(consumeLink(TOKEN)).rejects.toBeInstanceOf(ForbiddenError);
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
  });

  it("throws Forbidden when concurrent consume races (markConsumed returns false)", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ isPermanent: false, consumedAt: null }),
    );
    vi.mocked(shareLinkRepo.markConsumed).mockResolvedValueOnce(false);
    await expect(consumeLink(TOKEN)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("consumes a single-use link successfully + returns link with consumed_at populated", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ isPermanent: false, consumedAt: null }),
    );
    vi.mocked(shareLinkRepo.markConsumed).mockResolvedValueOnce(true);
    const out = await consumeLink(TOKEN);
    expect(out.consumedAt).toBeInstanceOf(Date);
    expect(shareLinkRepo.markConsumed).toHaveBeenCalledWith(LID);
  });

  it("permanent link consume succeeds + does NOT call markConsumed", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ isPermanent: true }),
    );
    const out = await consumeLink(TOKEN);
    expect(out.isPermanent).toBe(true);
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
  });

  it("permanent link consume succeeds multiple times in a row (idempotent)", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValue(
      fakeLink({ isPermanent: true }),
    );
    const first = await consumeLink(TOKEN);
    const second = await consumeLink(TOKEN);
    expect(first.isPermanent).toBe(true);
    expect(second.isPermanent).toBe(true);
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
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
// project_members. The 3 properties below lock the single-use vs
// permanent invariants under arbitrary input.

describe("createLink — property: only 'view'/'edit' grantable via share link", () => {
  it("rejects any role string that isn't 'view' or 'edit' with ValidationError", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (role) => {
        if (role === "view" || role === "edit") return;
        await expect(
          createLink({
            projectId: PID,
            createdByUserId: OWNER,
            role,
            isPermanent: false,
          }),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(shareLinkRepo.create).not.toHaveBeenCalled();
        vi.clearAllMocks();
      }),
      { numRuns: 50 },
    );
  });
});

describe("consumeLink — property: permanent links are idempotent + never call markConsumed", () => {
  it("any number of consume calls on a permanent link never mutates consumed_at", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (n) => {
        vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValue(
          fakeLink({ isPermanent: true, consumedAt: null }),
        );
        for (let i = 0; i < n; i++) {
          const out = await consumeLink(TOKEN);
          expect(out.isPermanent).toBe(true);
        }
        expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
        vi.clearAllMocks();
      }),
      { numRuns: 20 },
    );
  });
});

describe("consumeLink — property: expired links never reach markConsumed regardless of mode", () => {
  it("any link expired in the past + (single-use OR permanent) is rejected before any mutation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }), // ms in the past
        fc.boolean(),
        async (msInPast, isPermanent) => {
          const past = new Date(Date.now() - msInPast);
          vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
            fakeLink({ isPermanent, expiresAt: past }),
          );
          await expect(consumeLink(TOKEN)).rejects.toBeInstanceOf(
            ForbiddenError,
          );
          expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
          vi.clearAllMocks();
        },
      ),
      { numRuns: 30 },
    );
  });
});
