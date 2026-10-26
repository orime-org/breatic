// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The server opening an upload at the ingest Worker (inner#1595 T36–T42,
 * T80, P05).
 *
 * The ticket never leaves our side any more: `openSignedUpload` signs it,
 * hands it to the Worker with the shared secret exactly once, and returns
 * only the opened upload. Any failure inside it — signing or opening — settles
 * the grant and the task row as aborted itself, through `applyIngestReport`,
 * and throws `UploadOpenFailed` carrying either what settling decided or the
 * very error settling threw.
 *
 * The Worker call and registration are stood in; the ticket is signed for
 * real unless a case makes signing fail.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type * as sharedModule from "@breatic/shared";
import type * as coreModule from "@breatic/core";
import type * as ingestReportModule from "@domain/asset/ingest-report.service.js";
import type * as grantRepoModule from "@domain/asset/upload-grant.repo.js";

const PART = 8 * 1024 * 1024;
const SECRET = "secret";
const INGEST_URL = "https://ingest.example";

const openUploadAtIngest = vi.fn();
const signUploadTicket = vi.fn();
const applyIngestReport = vi.fn();
const voidGrant = vi.fn();

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof coreModule>()),
  env: { INGEST_SHARED_SECRET: SECRET, INGEST_BASE_URL: INGEST_URL },
  getStorageConfig: () => ({
    ingest: { part_size_bytes: PART, ticket_expires_seconds: 300, upright_jpeg_quality: 85 },
    upload: { max_upload_bytes: 2 * 1024 * 1024 * 1024, upload_idle_timeout_seconds: 45 },
  }),
}));
vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof sharedModule>()),
  openUploadAtIngest,
  signUploadTicket,
}));
vi.mock("@domain/asset/ingest-report.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ingestReportModule>()),
  applyIngestReport,
}));
vi.mock("@domain/asset/upload-grant.repo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof grantRepoModule>()),
  voidGrant,
}));

const realShared = await vi.importActual<typeof sharedModule>("@breatic/shared");
const {
  DeadlinePassed,
  INGEST_FAILURE_CODES,
  INGEST_NO_ANSWER,
  INGEST_REFUSED_UNNAMED,
  MAX_TIMER_MS,
  UploadHttpError,
  verifyUploadTicket,
} = await import("@breatic/shared");
const { INGEST_SIDE_EFFECT_EVENTS } = await import("@domain/asset/ingest-report.service.js");
const { openSignedUpload } = await import("@domain/asset/upload-ticket.service.js");
const { UploadOpenFailed } = await import("@domain/asset/upload-open-failure.js");

const NOW = Date.now();
const REQ = {
  storageKey: "image/2026-10-26/1_k.png",
  studioId: "studio-1",
  userId: "user-1",
  declaredSize: 3 * PART + 1,
  contentType: "image/png",
  expiresAt: NOW + 300_000,
  deadlineAt: NOW + 7_200_000,
};
/** What settling an aborted grant decided, as registration answers it. */
const SETTLED = { status: "voided" as const, countsPublishFailed: true };

/**
 * Run the opener and hand back what it rejected with.
 * @param request - What to open.
 * @returns The rejection.
 */
async function rejectionOf(request: typeof REQ = REQ): Promise<InstanceType<typeof UploadOpenFailed>> {
  const err: unknown = await openSignedUpload(request).then(
    () => {
      throw new Error("expected openSignedUpload to reject");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UploadOpenFailed);
  expect(err).not.toBeInstanceOf(AggregateError);
  return err as InstanceType<typeof UploadOpenFailed>;
}

beforeEach(() => {
  vi.clearAllMocks();
  openUploadAtIngest.mockReset().mockResolvedValue({ uploadId: "u-1", token: "t-1" });
  signUploadTicket.mockReset().mockImplementation(realShared.signUploadTicket);
  applyIngestReport.mockReset().mockResolvedValue(SETTLED);
  voidGrant.mockReset();
});

describe("openSignedUpload — opening", () => {
  it("T36: opens once with the signed ticket and the secret, and returns no ticket", async () => {
    const before = Date.now();
    const opened = await openSignedUpload(REQ);

    expect(openUploadAtIngest).toHaveBeenCalledTimes(1);
    const [target, secret, bound] = openUploadAtIngest.mock.calls[0] as [
      { ticket: string; uploadUrl: string; partSize: number; totalParts: number },
      string,
      unknown,
    ];
    const verified = await verifyUploadTicket(target.ticket, SECRET, Date.now());
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload).toMatchObject({
      storageKey: REQ.storageKey,
      studioId: REQ.studioId,
      userId: REQ.userId,
      contentType: REQ.contentType,
      expiresAt: REQ.expiresAt,
      deadlineAt: REQ.deadlineAt,
      totalParts: 4,
      partSize: PART,
    });
    expect(target.uploadUrl).toBe(INGEST_URL);
    expect(secret).toBe(SECRET);
    // inner#1595 R1: one request, bounded by a timeout to the task's deadline
    // and no signal, so nothing outlives the call.
    expect(bound).not.toHaveProperty("signal");
    const { timeoutMs } = bound as { timeoutMs: number };
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(REQ.deadlineAt - before);

    expect(opened).toEqual({
      uploadUrl: INGEST_URL,
      uploadId: "u-1",
      token: "t-1",
      partSize: PART,
      totalParts: 4,
    });
    expect(Object.hasOwn(opened, "ticket")).toBe(false);
    expect(applyIngestReport).not.toHaveBeenCalled();
  });

  it("T36: caps the timeout at the longest a timer can wait", async () => {
    await openSignedUpload({ ...REQ, deadlineAt: Date.now() + MAX_TIMER_MS + 60_000 });

    expect(openUploadAtIngest.mock.calls[0]?.[2]).toEqual({ timeoutMs: MAX_TIMER_MS });
  });

  it.each([
    [0, 1],
    [1, 1],
    [PART, 1],
    [PART + 1, 2],
  ])("T37: a declared size of %i travels as %i part(s)", async (declaredSize, totalParts) => {
    const opened = await openSignedUpload({ ...REQ, declaredSize });

    expect(opened.totalParts).toBe(totalParts);
    expect(openUploadAtIngest.mock.calls[0]?.[0]).toMatchObject({ totalParts, partSize: PART });
  });
});

describe("openSignedUpload — failing to open", () => {
  it("T38: settles the grant with the Worker's named refusal and throws UploadOpenFailed", async () => {
    const refused = new UploadHttpError(502, "store_failed");
    openUploadAtIngest.mockRejectedValue(refused);

    const failed = await rejectionOf();

    expect(failed.storageKey).toBe(REQ.storageKey);
    expect(failed.reason).toBe("store_failed");
    expect(failed.settled).toBe(SETTLED);
    expect(failed.cause).toBe(refused);
    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith({
      storageKey: REQ.storageKey,
      outcome: "aborted",
      reason: "store_failed",
    });
    expect(openUploadAtIngest).toHaveBeenCalledTimes(1);
    // Voiding goes through registration only.
    expect(voidGrant).not.toHaveBeenCalled();
  });

  it("T39: an answer that named nothing settles as the unnamed refusal", async () => {
    openUploadAtIngest.mockRejectedValue(new UploadHttpError(503, null));

    const failed = await rejectionOf();

    expect(failed.reason).toBe(INGEST_REFUSED_UNNAMED);
    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith({
      storageKey: REQ.storageKey,
      outcome: "aborted",
      reason: INGEST_REFUSED_UNNAMED,
    });
  });

  it.each([
    ["the line failing", () => new TypeError("fetch failed")],
    ["the deadline passing", () => new DeadlinePassed()],
  ])("T40: no answer (%s) settles as ingest_no_answer", async (_label, make) => {
    const err = make();
    openUploadAtIngest.mockRejectedValue(err);

    const failed = await rejectionOf();

    expect(failed.reason).toBe(INGEST_NO_ANSWER);
    expect(failed.cause).toBe(err);
    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith({
      storageKey: REQ.storageKey,
      outcome: "aborted",
      reason: INGEST_NO_ANSWER,
    });
    expect(openUploadAtIngest).toHaveBeenCalledTimes(1);
  });

  // inner#1595 R1: the deadline is checked inside the opener, so an upload
  // whose task already ran out is settled like any other open that failed.
  it.each([
    ["gone a millisecond ago", -1, false],
    ["reached exactly", 0, false],
    ["gone, with settling failing too", -1, true],
  ])("T91: a task whose deadline is %s settles as ingest_no_answer and opens nothing", async (_label, offset, settleFails) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Date.now();
      const unsettled = new Error("db down");
      if (settleFails) applyIngestReport.mockRejectedValue(unsettled);

      const failed = await rejectionOf({ ...REQ, deadlineAt: now + offset });

      expect(failed.reason).toBe(INGEST_NO_ANSWER);
      expect(failed.cause).toBeInstanceOf(DeadlinePassed);
      expect(openUploadAtIngest).not.toHaveBeenCalled();
      expect(signUploadTicket).not.toHaveBeenCalled();
      expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith({
        storageKey: REQ.storageKey,
        outcome: "aborted",
        reason: INGEST_NO_ANSWER,
      });
      if (settleFails) expect(failed.settleError).toBe(unsettled);
      else expect(failed.settled).toBe(SETTLED);
    } finally {
      vi.useRealTimers();
    }
  });

  it("T41: when settling fails too, carries the settling error itself and no outcome", async () => {
    const refused = new UploadHttpError(502, "store_failed");
    const unsettled = new Error("db down");
    openUploadAtIngest.mockRejectedValue(refused);
    applyIngestReport.mockRejectedValue(unsettled);

    const failed = await rejectionOf();

    expect(failed.storageKey).toBe(REQ.storageKey);
    expect(failed.reason).toBe("store_failed");
    expect(failed.cause).toBe(refused);
    expect(failed.settled).toBeUndefined();
    expect(failed.settleError).toBe(unsettled);
    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith({
      storageKey: REQ.storageKey,
      outcome: "aborted",
      reason: "store_failed",
    });
    expect(openUploadAtIngest).toHaveBeenCalledTimes(1);
  });

  it("T42: hands back every side-effect flag settling raised", async () => {
    const flags = Object.fromEntries(Object.keys(INGEST_SIDE_EFFECT_EVENTS).map((flag) => [flag, true]));
    expect(Object.keys(flags)).toHaveLength(5);
    const settled = { status: "voided" as const, ...flags };
    openUploadAtIngest.mockRejectedValue(new UploadHttpError(502, "store_failed"));
    applyIngestReport.mockResolvedValue(settled);

    const failed = await rejectionOf();

    expect(failed.settled).toMatchObject(flags);
  });

  it.each([
    ["settling goes through", false],
    ["settling fails too", true],
  ])("T80: a ticket that cannot be signed is an UploadOpenFailed as well (%s)", async (_label, settleFails) => {
    const signErr = new Error("sign failed");
    const unsettled = new Error("db down");
    signUploadTicket.mockRejectedValue(signErr);
    if (settleFails) applyIngestReport.mockRejectedValue(unsettled);

    const failed = await rejectionOf();

    expect(failed.storageKey).toBe(REQ.storageKey);
    expect(failed.reason).toBe(INGEST_NO_ANSWER);
    expect(failed.cause).toBe(signErr);
    expect(openUploadAtIngest).not.toHaveBeenCalled();
    expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith({
      storageKey: REQ.storageKey,
      outcome: "aborted",
      reason: INGEST_NO_ANSWER,
    });
    if (settleFails) {
      expect(Object.hasOwn(failed, "settled")).toBe(false);
      expect(failed.settleError).toBe(unsettled);
    } else {
      expect(failed.settled).toBe(SETTLED);
      expect(failed.settleError).toBeUndefined();
    }
  });
});

describe("openSignedUpload — any ending", () => {
  type Mode =
    | "ok"
    | "net"
    | "late"
    | "signFails"
    | "pastDeadline"
    | { status: number; code: (typeof INGEST_FAILURE_CODES)[number] | null };

  it("P05: opens at most once, and every failure settles once and throws UploadOpenFailed", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant<Mode>("ok"),
          fc.record({
            status: fc.integer({ min: 400, max: 599 }),
            code: fc.oneof(fc.constantFrom(...INGEST_FAILURE_CODES), fc.constant(null)),
          }),
          fc.constant<Mode>("net"),
          fc.constant<Mode>("late"),
          fc.constant<Mode>("signFails"),
          fc.constant<Mode>("pastDeadline"),
        ),
        fc.boolean(),
        async (mode: Mode, settleFails) => {
          openUploadAtIngest.mockReset().mockResolvedValue({ uploadId: "u-1", token: "t-1" });
          signUploadTicket.mockReset().mockImplementation(realShared.signUploadTicket);
          applyIngestReport.mockReset();

          let thrown: unknown;
          if (mode === "signFails") {
            thrown = new Error("sign failed");
            signUploadTicket.mockRejectedValue(thrown);
          } else if (mode === "net") {
            thrown = new TypeError("fetch failed");
          } else if (mode === "late") {
            thrown = new DeadlinePassed();
          } else if (typeof mode === "object") {
            thrown = new UploadHttpError(mode.status, mode.code);
          }
          if (thrown !== undefined && mode !== "signFails") openUploadAtIngest.mockRejectedValue(thrown);
          const settled = { status: "voided" as const };
          const unsettled = new Error("db down");
          if (settleFails) applyIngestReport.mockRejectedValue(unsettled);
          else applyIngestReport.mockResolvedValue(settled);

          const request = mode === "pastDeadline" ? { ...REQ, deadlineAt: Date.now() - 1 } : REQ;
          const before = Date.now();
          const result = await openSignedUpload(request).then(
            (opened) => ({ ok: true as const, opened }),
            (err: unknown) => ({ ok: false as const, err }),
          );

          const opensNothing = mode === "signFails" || mode === "pastDeadline";
          expect(openUploadAtIngest).toHaveBeenCalledTimes(opensNothing ? 0 : 1);
          if (!opensNothing) {
            const bound = openUploadAtIngest.mock.calls[0]?.[2] as { timeoutMs: number };
            expect(bound).not.toHaveProperty("signal");
            expect(bound.timeoutMs).toBeGreaterThan(0);
            expect(bound.timeoutMs).toBeLessThanOrEqual(REQ.deadlineAt - before);
          }
          if (mode === "ok") {
            expect(result.ok).toBe(true);
            expect(applyIngestReport).not.toHaveBeenCalled();
            return;
          }
          const reason =
            thrown instanceof UploadHttpError ? (thrown.code ?? INGEST_REFUSED_UNNAMED) : INGEST_NO_ANSWER;
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.err).not.toBeInstanceOf(AggregateError);
          expect(result.err).toBeInstanceOf(UploadOpenFailed);
          const failed = result.err as InstanceType<typeof UploadOpenFailed>;
          expect(failed.reason).toBe(reason);
          if (mode === "pastDeadline") expect(failed.cause).toBeInstanceOf(DeadlinePassed);
          else expect(failed.cause).toBe(thrown);
          expect(applyIngestReport).toHaveBeenCalledExactlyOnceWith({
            storageKey: REQ.storageKey,
            outcome: "aborted",
            reason,
          });
          if (settleFails) {
            expect(failed.settled).toBeUndefined();
            expect(failed.settleError).toBe(unsettled);
          } else {
            expect(failed.settled).toBe(settled);
            expect(failed.settleError).toBeUndefined();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
