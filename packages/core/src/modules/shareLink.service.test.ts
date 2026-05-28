/**
 * shareLink.service unit tests — invariant enforcement.
 *
 * 2026-05-28 spec rewrite: tests now follow the boundEmail discriminator
 * (NULL = Generate multi-use, NOT NULL = Email-invite single-use).
 *
 * Covers the email-invite vs Generate semantics, expiry gate, role
 * validation, bound-email match gate, and the consume race-condition
 * path. Repo is mocked so tests run without a PG connection.
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
  boundEmail: string | null;
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
    boundEmail: overrides.boundEmail ?? null,
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
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("creates a Generate link (boundEmail=null) with role=view, no expiry", async () => {
    vi.mocked(shareLinkRepo.create).mockResolvedValueOnce(
      fakeLink({ boundEmail: null, expiresAt: null }),
    );
    const out = await createLink({
      projectId: PID,
      createdByUserId: OWNER,
      role: "view",
    });
    expect(out.boundEmail).toBeNull();
    expect(out.expiresAt).toBeNull();
    const args = vi.mocked(shareLinkRepo.create).mock.calls[0]?.[0];
    expect(args?.role).toBe("view");
    expect(args?.boundEmail).toBeNull();
    expect(args?.expiresAt).toBeNull();
    expect(args?.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("creates an email-invite link (boundEmail set) with role=edit + 7-day expiry", async () => {
    vi.mocked(shareLinkRepo.create).mockImplementationOnce(async (input) =>
      fakeLink({
        boundEmail: input.boundEmail,
        role: input.role,
        expiresAt: input.expiresAt,
      }),
    );
    const before = Date.now();
    const out = await createLink({
      projectId: PID,
      createdByUserId: OWNER,
      role: "edit",
      boundEmail: BOUND_EMAIL,
    });
    expect(out.boundEmail).toBe(BOUND_EMAIL);
    expect(out.role).toBe("edit");
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
        role: "view",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("consumeLink", () => {
  it("throws NotFound when the token doesn't match any active link", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(null);
    await expect(consumeLink(TOKEN, CALLER_EMAIL)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws Forbidden when the link is expired", async () => {
    const past = new Date(Date.now() - 1000);
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ boundEmail: BOUND_EMAIL, expiresAt: past }),
    );
    await expect(consumeLink(TOKEN, BOUND_EMAIL)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
  });

  it("throws Forbidden when bound email doesn't match caller email", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ boundEmail: BOUND_EMAIL }),
    );
    await expect(consumeLink(TOKEN, "other@example.com")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
  });

  it("throws Forbidden when email-invite link was already consumed", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ boundEmail: BOUND_EMAIL, consumedAt: new Date() }),
    );
    await expect(consumeLink(TOKEN, BOUND_EMAIL)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
  });

  it("throws Forbidden when concurrent consume races (markConsumed returns false)", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ boundEmail: BOUND_EMAIL, consumedAt: null }),
    );
    vi.mocked(shareLinkRepo.markConsumed).mockResolvedValueOnce(false);
    await expect(consumeLink(TOKEN, BOUND_EMAIL)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("consumes an email-invite link successfully + returns link with consumed_at populated", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ boundEmail: BOUND_EMAIL, consumedAt: null }),
    );
    vi.mocked(shareLinkRepo.markConsumed).mockResolvedValueOnce(true);
    const out = await consumeLink(TOKEN, BOUND_EMAIL);
    expect(out.consumedAt).toBeInstanceOf(Date);
    expect(shareLinkRepo.markConsumed).toHaveBeenCalledWith(LID);
  });

  it("Generate link (boundEmail=null) consume succeeds + does NOT call markConsumed", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
      fakeLink({ boundEmail: null }),
    );
    const out = await consumeLink(TOKEN, CALLER_EMAIL);
    expect(out.boundEmail).toBeNull();
    expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
  });

  it("Generate link consume succeeds multiple times in a row (idempotent)", async () => {
    vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValue(
      fakeLink({ boundEmail: null }),
    );
    const first = await consumeLink(TOKEN, CALLER_EMAIL);
    const second = await consumeLink(TOKEN, "another@example.com");
    expect(first.boundEmail).toBeNull();
    expect(second.boundEmail).toBeNull();
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
// project_members. The properties below lock the email-invite vs
// Generate invariants under arbitrary input.

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
          }),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(shareLinkRepo.create).not.toHaveBeenCalled();
        vi.clearAllMocks();
      }),
      { numRuns: 50 },
    );
  });
});

describe("consumeLink — property: Generate links are idempotent + never call markConsumed", () => {
  it("any number of consume calls on a Generate link never mutates consumed_at", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (n) => {
        vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValue(
          fakeLink({ boundEmail: null, consumedAt: null }),
        );
        for (let i = 0; i < n; i++) {
          const out = await consumeLink(TOKEN, CALLER_EMAIL);
          expect(out.boundEmail).toBeNull();
        }
        expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
        vi.clearAllMocks();
      }),
      { numRuns: 20 },
    );
  });
});

describe("consumeLink — property: expired links never reach markConsumed regardless of variant", () => {
  it("any link expired in the past + (email-invite OR Generate) is rejected before any mutation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.boolean(),
        async (msInPast, isEmailInvite) => {
          const past = new Date(Date.now() - msInPast);
          vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
            fakeLink({
              boundEmail: isEmailInvite ? BOUND_EMAIL : null,
              expiresAt: past,
            }),
          );
          await expect(
            consumeLink(TOKEN, isEmailInvite ? BOUND_EMAIL : CALLER_EMAIL),
          ).rejects.toBeInstanceOf(ForbiddenError);
          expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
          vi.clearAllMocks();
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("consumeLink — property: email-invite link always rejects mismatched caller email", () => {
  it("any caller email that isn't the bound email gets Forbidden", async () => {
    await fc.assert(
      fc.asyncProperty(fc.emailAddress(), async (callerEmail) => {
        if (callerEmail === BOUND_EMAIL) return;
        vi.mocked(shareLinkRepo.findActiveByToken).mockResolvedValueOnce(
          fakeLink({ boundEmail: BOUND_EMAIL, consumedAt: null }),
        );
        await expect(consumeLink(TOKEN, callerEmail)).rejects.toBeInstanceOf(
          ForbiddenError,
        );
        expect(shareLinkRepo.markConsumed).not.toHaveBeenCalled();
        vi.clearAllMocks();
      }),
      { numRuns: 30 },
    );
  });
});
