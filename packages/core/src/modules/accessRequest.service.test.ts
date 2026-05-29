/**
 * accessRequest.service unit tests — invariant enforcement.
 *
 * Mocks the repo + db.transaction (pass-through) + publishMembersChanged
 * to assert the service refuses owner role / refuses self-promote /
 * propagates partial-UNIQUE conflicts, and to verify approveRequest
 * runs the status transition + member insert atomically + publishes
 * the right event.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";

vi.mock("./accessRequest.repo.js", () => ({
  create: vi.fn(),
  findById: vi.fn(),
  findPendingByRequester: vi.fn(),
  listPendingByProject: vi.fn(),
  listByRequester: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock("./projectMembers.repo.js", () => ({
  getRole: vi.fn(),
  upsertMember: vi.fn(),
}));

// Pass-through transaction — runs the callback immediately with an
// empty tx so the service code path executes against mocked repos.
vi.mock("../db/client.js", () => ({
  db: {
    transaction: vi.fn(
      async (cb: (tx: unknown) => Promise<unknown>) => cb({} as never),
    ),
  },
}));

vi.mock("../infra/control-events.js", () => ({
  publishMembersChanged: vi.fn().mockResolvedValue(undefined),
}));

import * as accessRequestRepo from "./accessRequest.repo.js";
import * as projectMembersRepo from "./projectMembers.repo.js";
import { publishMembersChanged } from "../infra/control-events.js";
import {
  createRequest,
  approveRequest,
  rejectRequest,
  listPendingByProject,
  listByRequester,
} from "./accessRequest.service.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../errors.js";

const PID = "p-1";
const RID = "req-1";
const UID = "u-applicant";
const REVIEWER = "u-owner";

type AccessRequestEntity = NonNullable<
  Awaited<ReturnType<typeof accessRequestRepo.findById>>
>;

function fakeRequest(overrides: Partial<{
  id: string;
  projectId: string;
  requesterUserId: string;
  requestedRole: string;
  status: "pending" | "approved" | "rejected";
  deletedAt: Date | null;
}> = {}): AccessRequestEntity {
  return {
    id: overrides.id ?? RID,
    projectId: overrides.projectId ?? PID,
    requesterUserId: overrides.requesterUserId ?? UID,
    requestedRole: overrides.requestedRole ?? "view",
    message: null,
    status: overrides.status ?? "pending",
    reviewedByUserId: null,
    reviewedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: overrides.deletedAt ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createRequest", () => {
  it("rejects role='owner' with ValidationError", async () => {
    await expect(
      createRequest({
        projectId: PID,
        requesterUserId: UID,
        requestedRole: "owner",
        message: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(accessRequestRepo.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown role string with ValidationError", async () => {
    await expect(
      createRequest({
        projectId: PID,
        requesterUserId: UID,
        requestedRole: "admin",
        message: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects when caller is already an active member with Conflict", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce("edit");
    await expect(
      createRequest({
        projectId: PID,
        requesterUserId: UID,
        requestedRole: "view",
        message: null,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(accessRequestRepo.create).not.toHaveBeenCalled();
  });

  it("translates Postgres unique-violation (23505) to Conflict", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);
    vi.mocked(accessRequestRepo.create).mockRejectedValueOnce(
      Object.assign(new Error("duplicate"), { code: "23505" }),
    );
    await expect(
      createRequest({
        projectId: PID,
        requesterUserId: UID,
        requestedRole: "view",
        message: null,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("creates the request when caller is not a member and role is valid", async () => {
    vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);
    vi.mocked(accessRequestRepo.create).mockResolvedValueOnce(
      fakeRequest({ requestedRole: "edit" }),
    );
    const out = await createRequest({
      projectId: PID,
      requesterUserId: UID,
      requestedRole: "edit",
      message: "please",
    });
    expect(out.requestedRole).toBe("edit");
    expect(accessRequestRepo.create).toHaveBeenCalledWith({
      projectId: PID,
      requesterUserId: UID,
      requestedRole: "edit",
      message: "please",
    });
  });
});

describe("approveRequest", () => {
  it("throws NotFound when the request doesn't exist", async () => {
    vi.mocked(accessRequestRepo.findById).mockResolvedValueOnce(null);
    await expect(approveRequest(RID, REVIEWER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
  });

  it("throws NotFound when the request is already approved", async () => {
    vi.mocked(accessRequestRepo.findById).mockResolvedValueOnce(
      fakeRequest({ status: "approved" }),
    );
    await expect(approveRequest(RID, REVIEWER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws NotFound when the request is soft-deleted", async () => {
    vi.mocked(accessRequestRepo.findById).mockResolvedValueOnce(
      fakeRequest({ deletedAt: new Date() }),
    );
    await expect(approveRequest(RID, REVIEWER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("transitions to approved + inserts the member + publishes invite", async () => {
    vi.mocked(accessRequestRepo.findById)
      .mockResolvedValueOnce(fakeRequest({ requestedRole: "edit" }))
      .mockResolvedValueOnce(
        fakeRequest({ requestedRole: "edit", status: "approved" }),
      );
    vi.mocked(accessRequestRepo.updateStatus).mockResolvedValueOnce(true);

    const out = await approveRequest(RID, REVIEWER);

    expect(out.status).toBe("approved");
    expect(accessRequestRepo.updateStatus).toHaveBeenCalledWith(
      RID,
      "approved",
      REVIEWER,
      expect.anything(),
    );
    expect(projectMembersRepo.upsertMember).toHaveBeenCalledWith(
      PID,
      UID,
      "edit",
      REVIEWER,
      expect.anything(),
    );
    expect(publishMembersChanged).toHaveBeenCalledWith(PID, {
      affectedUserId: UID,
      action: "invite",
      newRole: "edit",
    });
  });

  it("throws NotFound + doesn't publish when updateStatus loses a race", async () => {
    vi.mocked(accessRequestRepo.findById).mockResolvedValueOnce(
      fakeRequest(),
    );
    vi.mocked(accessRequestRepo.updateStatus).mockResolvedValueOnce(false);
    await expect(approveRequest(RID, REVIEWER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(publishMembersChanged).not.toHaveBeenCalled();
  });

  // ── Transaction rollback invariants (TDD backfill for PR-d 04
  // placeholder-bug commit `e503e50`). These would have caught the
  // initial accessRequest.service.ts placeholder where approveRequest
  // had non-atomic tx wiring (status update could land without member
  // insert). The current implementation runs both inside db.transaction,
  // so if either throws, the other must not commit + publishMembersChanged
  // must never fire.

  it("rollback invariant: updateStatus throw → upsertMember not called + no publish", async () => {
    vi.mocked(accessRequestRepo.findById).mockResolvedValueOnce(
      fakeRequest({ requestedRole: "edit" }),
    );
    vi.mocked(accessRequestRepo.updateStatus).mockRejectedValueOnce(
      new Error("db connection lost"),
    );
    await expect(approveRequest(RID, REVIEWER)).rejects.toThrow(
      "db connection lost",
    );
    expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
    expect(publishMembersChanged).not.toHaveBeenCalled();
  });

  it("rollback invariant: upsertMember throw → no publish (tx failure propagates)", async () => {
    vi.mocked(accessRequestRepo.findById).mockResolvedValueOnce(
      fakeRequest({ requestedRole: "edit" }),
    );
    vi.mocked(accessRequestRepo.updateStatus).mockResolvedValueOnce(true);
    vi.mocked(projectMembersRepo.upsertMember).mockRejectedValueOnce(
      new Error("project_members FK violation"),
    );
    await expect(approveRequest(RID, REVIEWER)).rejects.toThrow(
      "project_members FK violation",
    );
    expect(publishMembersChanged).not.toHaveBeenCalled();
  });

  it("rollback invariant: both repo calls happen inside the SAME tx handle", async () => {
    // Captures the tx argument both repos receive to assert they got
    // the same (single) handle. Single-handle = single transaction.
    const txCalls: unknown[] = [];
    vi.mocked(accessRequestRepo.findById).mockResolvedValueOnce(
      fakeRequest({ requestedRole: "edit" }),
    );
    vi.mocked(accessRequestRepo.updateStatus).mockImplementationOnce(
      async (_id, _status, _reviewer, tx) => {
        txCalls.push(tx);
        return true;
      },
    );
    vi.mocked(projectMembersRepo.upsertMember).mockImplementationOnce(
      async (_p, _u, _r, _b, tx) => {
        txCalls.push(tx);
      },
    );
    vi.mocked(accessRequestRepo.findById).mockResolvedValueOnce(
      fakeRequest({ requestedRole: "edit", status: "approved" }),
    );

    await approveRequest(RID, REVIEWER);

    expect(txCalls).toHaveLength(2);
    expect(txCalls[0]).toBe(txCalls[1]);
  });
});

describe("rejectRequest", () => {
  it("throws NotFound when the request doesn't exist", async () => {
    vi.mocked(accessRequestRepo.findById).mockResolvedValueOnce(null);
    await expect(rejectRequest(RID, REVIEWER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("transitions to rejected + does NOT touch members + does NOT publish", async () => {
    vi.mocked(accessRequestRepo.findById)
      .mockResolvedValueOnce(fakeRequest())
      .mockResolvedValueOnce(fakeRequest({ status: "rejected" }));
    vi.mocked(accessRequestRepo.updateStatus).mockResolvedValueOnce(true);

    const out = await rejectRequest(RID, REVIEWER);

    expect(out.status).toBe("rejected");
    expect(accessRequestRepo.updateStatus).toHaveBeenCalledWith(
      RID,
      "rejected",
      REVIEWER,
      expect.anything(),
    );
    expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
    expect(publishMembersChanged).not.toHaveBeenCalled();
  });
});

describe("list functions are thin pass-through", () => {
  it("listPendingByProject delegates to repo", async () => {
    vi.mocked(accessRequestRepo.listPendingByProject).mockResolvedValueOnce([
      {
        ...fakeRequest(),
        requester: { id: UID, username: "alice", email: "alice@example.com" },
      },
    ]);
    const out = await listPendingByProject(PID);
    expect(out).toHaveLength(1);
    expect(out[0]?.requester.username).toBe("alice");
    expect(accessRequestRepo.listPendingByProject).toHaveBeenCalledWith(PID);
  });

  it("listByRequester delegates to repo", async () => {
    vi.mocked(accessRequestRepo.listByRequester).mockResolvedValueOnce([
      fakeRequest(),
    ]);
    const out = await listByRequester(UID);
    expect(out).toHaveLength(1);
    expect(accessRequestRepo.listByRequester).toHaveBeenCalledWith(UID);
  });
});

// ── Fast-check property-based tests (PR-d TDD backfill #613) ───────
//
// CLAUDE.md "关键路径 + property-based" mandate: rights/auth flows
// must hold their invariants under arbitrary input, not just
// hand-picked examples. accessRequest is on the auth critical path
// (it grants project_members rows on approve), so we lock the three
// hard invariants below against any reasonable input distribution.

describe("createRequest — property: only 'view'/'edit' are grantable", () => {
  it("rejects any role string that isn't 'view' or 'edit' with ValidationError", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (role) => {
        if (role === "view" || role === "edit") return; // skip the valid pair
        vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);
        await expect(
          createRequest({
            projectId: PID,
            requesterUserId: UID,
            requestedRole: role,
            message: null,
          }),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(accessRequestRepo.create).not.toHaveBeenCalled();
        vi.clearAllMocks();
      }),
      { numRuns: 50 },
    );
  });

  it("accepts BOTH 'view' and 'edit' on valid input", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("view", "edit"), async (role) => {
        vi.mocked(projectMembersRepo.getRole).mockResolvedValueOnce(null);
        vi.mocked(accessRequestRepo.create).mockResolvedValueOnce(
          fakeRequest({ requestedRole: role }),
        );
        const out = await createRequest({
          projectId: PID,
          requesterUserId: UID,
          requestedRole: role,
          message: null,
        });
        expect(out.requestedRole).toBe(role);
        vi.clearAllMocks();
      }),
      { numRuns: 20 },
    );
  });
});

describe("approveRequest — property: only pending → approved/rejected; never resurrect", () => {
  it("rejects any non-pending status with NotFound (state machine guard)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("approved", "rejected"),
        async (existingStatus) => {
          vi.mocked(accessRequestRepo.findById).mockResolvedValueOnce(
            fakeRequest({ status: existingStatus }),
          );
          await expect(approveRequest(RID, REVIEWER)).rejects.toBeInstanceOf(
            NotFoundError,
          );
          expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
          expect(publishMembersChanged).not.toHaveBeenCalled();
          vi.clearAllMocks();
        },
      ),
      { numRuns: 20 },
    );
  });

  it("rejects soft-deleted requests regardless of status", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("pending", "approved", "rejected"),
        async (status) => {
          vi.mocked(accessRequestRepo.findById).mockResolvedValueOnce(
            fakeRequest({ status, deletedAt: new Date() }),
          );
          await expect(approveRequest(RID, REVIEWER)).rejects.toBeInstanceOf(
            NotFoundError,
          );
          expect(projectMembersRepo.upsertMember).not.toHaveBeenCalled();
          vi.clearAllMocks();
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("approveRequest — property: granted role always equals requestedRole", () => {
  it("upsertMember receives the EXACT requestedRole the applicant asked for", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("view", "edit"), async (requestedRole) => {
        vi.mocked(accessRequestRepo.findById)
          .mockResolvedValueOnce(fakeRequest({ requestedRole }))
          .mockResolvedValueOnce(
            fakeRequest({ requestedRole, status: "approved" }),
          );
        vi.mocked(accessRequestRepo.updateStatus).mockResolvedValueOnce(true);

        await approveRequest(RID, REVIEWER);

        expect(projectMembersRepo.upsertMember).toHaveBeenCalledWith(
          PID,
          UID,
          requestedRole,
          REVIEWER,
          expect.anything(),
        );
        expect(publishMembersChanged).toHaveBeenCalledWith(PID, {
          affectedUserId: UID,
          action: "invite",
          newRole: requestedRole,
        });
        vi.clearAllMocks();
      }),
      { numRuns: 20 },
    );
  });
});
