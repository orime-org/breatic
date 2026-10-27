// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The server's upload tickets: `issueTransferTicket` (inner#1006 design
 * §4.2, test spec T28) and, since inner#1595, the server opening every upload
 * at the ingest Worker itself before it answers (test spec §5, T50–T59, T78,
 * T79).
 *
 * A transfer file never becomes an asset and never counts toward storage, so
 * the ticket asks neither the dedup ledger nor the storage allowance; the key,
 * the grant's provenance, the file name and the signed type are all the
 * server's, not the browser's.
 *
 * Opening the upload is domain's `openSignedUpload`, mocked here. When it
 * fails it throws `UploadOpenFailed`, which domain exports at its top level;
 * this file mocks domain whole, so a minimal class of that name stands in and
 * is the very reference the code under test checks with `instanceof`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { INGEST_NO_ANSWER, TRANSFER_MEDIA_TYPE } from "@breatic/shared";
import { MINI_TOOLS, mostOutputsOf } from "@breatic/shared/mini-tools";

const TRANSFER_TYPE = "application/vnd.breatic.transfer";

const h = vi.hoisted(() => {
  /** Domain's typed open failure, as far as the server reads it (test spec T29). */
  class UploadOpenFailed extends Error {
    readonly storageKey: string;
    readonly reason: string;
    readonly settled?: unknown;
    readonly settleError?: unknown;

    /**
     * Build the failure.
     * @param init - The key, the reason, how settling went and the open's own error.
     * @param init.storageKey - The upload's key.
     * @param init.reason - The failure reason.
     * @param init.settled - What settling the grant answered, when it answered.
     * @param init.settleError - What settling threw, when it threw.
     * @param init.cause - The error opening the upload threw.
     */
    constructor(init: {
      storageKey: string;
      reason: string;
      settled?: unknown;
      settleError?: unknown;
      cause: unknown;
    }) {
      super(`upload open failed: ${init.reason}`, { cause: init.cause });
      this.name = "UploadOpenFailed";
      this.storageKey = init.storageKey;
      this.reason = init.reason;
      if ("settled" in init) this.settled = init.settled;
      if ("settleError" in init) this.settleError = init.settleError;
    }
  }
  return {
    UploadOpenFailed,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});
const { UploadOpenFailed, logger } = h;

const K = "image/2026-10-26/1_00000000-0000-4000-8000-000000000000.png";
const UPLOAD_URL = "https://ingest.test.invalid";
const PART = 8388608;
const OK = { uploadUrl: UPLOAD_URL, uploadId: "u-1", token: "t-1", partSize: PART, totalParts: 1 };

const checkUploadDedup = vi.fn();
const settleDedupHit = vi.fn();
const openUpload = vi.fn();
const openSignedUpload = vi.fn();
const uploadDeadlineByKey = vi.fn();
const noteIngestSideEffects = vi.fn();
const assertStudioStorageAllowance = vi.fn();

vi.mock("@breatic/core", () => ({
  AppError: class AppError extends Error {},
  env: { INGEST_SHARED_SECRET: "secret", INGEST_BASE_URL: "https://ingest.test.invalid" },
  getNodeTaskConfig: () => ({ default_budget_ms: 7_200_000 }),
  getStorageConfig: () => ({
    upload: { max_upload_bytes: 2147483648 },
    ingest: { ticket_expires_seconds: 300, part_size_bytes: 8388608 },
    transfer: {
      route_max_bytes: { chat_message: 4194304, canvas_paste: 25165824, node_history_snapshot: 25165824 },
      reference_ttl_seconds: 3600,
      read_lock_seconds: 60,
    },
  }),
  logger: h.logger,
}));

vi.mock("@breatic/domain", () => ({
  assetService: {
    detectAssetKind: (contentType: string) => (contentType.startsWith("image/") ? "image" : "file"),
  },
  safeExt: (filename: string) => filename.slice(filename.lastIndexOf(".")),
  uploadDeadlineByKey,
  uploadTicketService: { openSignedUpload },
  UploadOpenFailed: h.UploadOpenFailed,
}));

vi.mock("@server/modules/asset/assetUpload.service.js", () => ({ checkUploadDedup, settleDedupHit }));
vi.mock("@server/modules/asset/storageQuota.service.js", () => ({
  INSUFFICIENT_STORAGE: 507,
  assertStudioStorageAllowance,
}));
vi.mock("@server/modules/asset/upload-opening.js", () => ({ openUpload }));
vi.mock("@server/modules/asset/ingest-side-effects.js", () => ({ noteIngestSideEffects }));

const { issueTransferTicket, issueUploadTicket, issueUploadTicketBatch } = await import(
  "@server/modules/asset/upload-ticket.service.js"
);

const SCOPE = {
  userId: "22222222-2222-4222-8222-222222222222",
  studioId: "studio-1",
  projectId: "11111111-1111-4111-8111-111111111111",
};

/** The size the browser asks for: the whole transfer file, signature included. */
const SIZE = 1500019;

/** One picture onto one node. */
const ITEM = {
  filename: "photo.png",
  content_type: "image/png",
  size: 4096,
  client_hash: "hash-1",
  node_id: "33333333-3333-4333-8333-333333333333",
  space_id: "44444444-4444-4444-8444-444444444444",
};

/** What settling an aborted grant answered: the grant voided, one side effect lost. */
const S = { status: "voided", countsPublishFailed: true };
/** The error opening the upload threw. */
const C = new Error("open failed at the Worker");
/** The error settling the grant threw. */
const D = new Error("db down");
/** The open failed and settling worked. */
const F = new UploadOpenFailed({ storageKey: K, reason: "store_failed", settled: S, cause: C });
/** The open failed and settling failed too. */
const G = new UploadOpenFailed({ storageKey: K, reason: "store_failed", settleError: D, cause: C });

/** The largest batch a grouped browser tool asks for, read the way the route reads it. */
const BATCH_MAX = Math.max(
  ...MINI_TOOLS.filter((spec) => spec.run.kind === "browser" && spec.groupOutputs === true).map(mostOutputsOf),
);

/**
 * Every `upload_open_failed` line logged so far.
 * @returns Each line's fields.
 */
function openFailedLines(): Record<string, unknown>[] {
  return logger.error.mock.calls
    .filter((call) => call[1] === "upload_open_failed")
    .map((call) => call[0] as Record<string, unknown>);
}

/**
 * The fields of the one info line named `event`.
 * @param event - The log message.
 * @returns Its fields.
 */
function infoLine(event: string): Record<string, unknown> {
  const lines = logger.info.mock.calls.filter((call) => call[1] === event);
  expect(lines).toHaveLength(1);
  return lines[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  checkUploadDedup.mockReset().mockResolvedValue(null);
  settleDedupHit.mockReset().mockResolvedValue(undefined);
  openUpload.mockReset().mockResolvedValue({ key: K, studioId: "studio-1", taskId: "task-1" });
  openSignedUpload.mockReset().mockResolvedValue(OK);
  uploadDeadlineByKey.mockReset().mockImplementation(async () => Date.now() + 7_200_000);
  noteIngestSideEffects.mockReset();
  assertStudioStorageAllowance.mockReset().mockResolvedValue(undefined);
});

describe("T28: issueTransferTicket", () => {
  it("names the shared transfer type", () => {
    expect(TRANSFER_MEDIA_TYPE).toBe(TRANSFER_TYPE);
  });

  it("asks neither dedup nor the storage allowance", async () => {
    // Settled either way: what is asserted is which questions were asked.
    await issueTransferTicket(SCOPE, SIZE).catch(() => undefined);

    expect(checkUploadDedup).toHaveBeenCalledTimes(0);
    expect(settleDedupHit).toHaveBeenCalledTimes(0);
    expect(assertStudioStorageAllowance).toHaveBeenCalledTimes(0);
  });

  it("opens a transfer grant with no node and no space, under a .transfer key", async () => {
    await issueTransferTicket(SCOPE, SIZE);

    expect(openUpload).toHaveBeenCalledTimes(1);
    const [grant] = openUpload.mock.calls[0] as unknown as [
      { taskType: string; ext: string; declaredSize: number; context: Record<string, unknown> },
    ];
    expect(grant.taskType).toBe("transfer");
    expect(grant.ext).toBe(".transfer");
    expect(grant.declaredSize).toBe(1500019);
    expect(grant.context).toMatchObject({
      assetSource: "transfer",
      derived: true,
      nodeId: null,
      spaceId: null,
      filename: "body.transfer",
    });
  });

  // inner#1595 T50: replaces "signs the ticket with the transfer type"; the
  // signed values are the same, read off what the server opens now.
  it("T50: opens the transfer upload once, signed with the transfer type, and answers no ticket", async () => {
    const DL = Date.now() + 3_600_000;
    uploadDeadlineByKey.mockResolvedValue(DL);

    const issued = await issueTransferTicket(SCOPE, SIZE);

    expect(openSignedUpload).toHaveBeenCalledTimes(1);
    // inner#1595 R1: the opener bounds itself by the request's deadline.
    expect(openSignedUpload.mock.calls[0]).toHaveLength(1);
    const [request] = openSignedUpload.mock.calls[0] as [
      { contentType: string; declaredSize: number; storageKey: string; deadlineAt: number },
    ];
    expect(request.contentType).toBe(TRANSFER_TYPE);
    expect(request.declaredSize).toBe(1500019);
    expect(request.storageKey).toBe(K);
    expect(request.deadlineAt).toBe(DL);
    expect(issued).toMatchObject({ kind: "ticket", uploadId: "u-1", token: "t-1", storageKey: K });
    expect(issued).not.toHaveProperty("ticket");
    expect(infoLine("transfer_ticket_issued")).toMatchObject({ uploadId: "u-1" });
  });

  it.each([
    ["settling worked", F, 1],
    ["settling failed too", G, 0],
  ])("T51: rethrows the open failure untouched when %s, logging only its side effects", async (_label, failure, notes) => {
    openSignedUpload.mockRejectedValue(failure);

    const thrown = await issueTransferTicket(SCOPE, SIZE).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(thrown).toBe(failure);
    // The error is logged once, by errorHandler (T75), not here.
    expect(logger.error).toHaveBeenCalledTimes(0);
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(notes);
    if (notes === 1) expect(noteIngestSideEffects).toHaveBeenCalledWith(K, S);
  });
});

describe("inner#1595: issueUploadTicket opens the upload itself", () => {
  it("T52: opens once under the task row's own deadline and answers the upload id and token", async () => {
    const DL = Date.now() + 3_600_000;
    uploadDeadlineByKey.mockResolvedValue(DL);

    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => true);

    expect(openSignedUpload).toHaveBeenCalledTimes(1);
    // inner#1595 R1: the opener bounds itself by the request's deadline.
    expect(openSignedUpload.mock.calls[0]).toHaveLength(1);
    const [request] = openSignedUpload.mock.calls[0] as [
      { deadlineAt: number; storageKey: string; contentType: string },
    ];
    expect(request.deadlineAt).toBe(DL);
    expect(request.storageKey).toBe(K);
    expect(request.contentType).toBe("image/png");
    expect(outcome).toEqual({
      kind: "ticket",
      uploadId: "u-1",
      token: "t-1",
      storageKey: K,
      uploadUrl: UPLOAD_URL,
      assetKind: "image",
      partSize: PART,
      totalParts: 1,
      taskId: "task-1",
    });
    expect(outcome).not.toHaveProperty("ticket");
    expect(infoLine("upload_ticket_issued")).toMatchObject({ uploadId: "u-1" });
  });

  it("T53: answers openFailed with the task id, logs it once and writes down the side effects", async () => {
    openSignedUpload.mockRejectedValue(F);

    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => true);

    expect(outcome).toEqual({ kind: "openFailed", reason: "store_failed", taskId: "task-1" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [fields, event] = logger.error.mock.calls[0]!;
    expect(event).toBe("upload_open_failed");
    expect(fields).toEqual({
      err: C,
      settleError: undefined,
      key: K,
      userId: SCOPE.userId,
      projectId: SCOPE.projectId,
      reason: "store_failed",
    });
    expect((fields as { err: unknown }).err).toBe(C);
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(1);
    expect(noteIngestSideEffects).toHaveBeenCalledWith(K, S);
  });

  it("T54: answers openFailed with no task id for an upload with no node", async () => {
    openUpload.mockResolvedValue({ key: K, studioId: "studio-1", taskId: undefined });
    openSignedUpload.mockRejectedValue(
      new UploadOpenFailed({ storageKey: K, reason: INGEST_NO_ANSWER, settled: S, cause: C }),
    );

    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => true);

    expect(outcome).toEqual({ kind: "openFailed", reason: INGEST_NO_ANSWER, taskId: undefined });
  });

  it("T55: still answers openFailed with the task id when settling failed too", async () => {
    openSignedUpload.mockRejectedValue(G);

    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => true);

    expect(outcome).toEqual({ kind: "openFailed", reason: "store_failed", taskId: "task-1" });
    const lines = openFailedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      err: C,
      settleError: D,
      key: K,
      userId: SCOPE.userId,
      projectId: SCOPE.projectId,
      reason: "store_failed",
    });
    // The original settle error, not anything wrapping it.
    expect(lines[0]!.settleError).toBe(D);
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(0);
  });

  it("T78a: lets an error from before the open through, opening nothing", async () => {
    const X = new Error("boom");
    openUpload.mockRejectedValue(X);

    const thrown = await issueUploadTicket(SCOPE, ITEM, async () => true).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(thrown).toBe(X);
    expect(openSignedUpload).toHaveBeenCalledTimes(0);
    expect(openFailedLines()).toEqual([]);
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(0);
  });

  it("T78b: catches only UploadOpenFailed and lets any other error through", async () => {
    const Y = new Error("not an open failure");
    openSignedUpload.mockRejectedValue(Y);

    const thrown = await issueUploadTicket(SCOPE, ITEM, async () => true).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(thrown).toBe(Y);
    expect(openSignedUpload).toHaveBeenCalledTimes(1);
    expect(openFailedLines()).toEqual([]);
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(0);
  });

  it("T56a: opens nothing on a dedup hit", async () => {
    checkUploadDedup.mockResolvedValue({
      assetId: "asset-1",
      fileUrl: "https://cdn.test.invalid/a.png",
      kind: "image",
      width: 10,
      height: 20,
    });

    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => true);

    expect(outcome).toEqual({
      kind: "alreadyExists",
      assetId: "asset-1",
      fileUrl: "https://cdn.test.invalid/a.png",
      assetKind: "image",
      width: 10,
      height: 20,
    });
    expect(openSignedUpload).toHaveBeenCalledTimes(0);
  });

  it("T56b: opens nothing for a file over the cap", async () => {
    const outcome = await issueUploadTicket(SCOPE, { ...ITEM, size: 2147483649 }, async () => true);

    expect(outcome).toEqual({ kind: "refused", reason: "too_large" });
    expect(openSignedUpload).toHaveBeenCalledTimes(0);
  });

  it("T56c: opens nothing when storage is full", async () => {
    const outcome = await issueUploadTicket(SCOPE, ITEM, async () => false);

    expect(outcome).toEqual({ kind: "refused", reason: "storage" });
    expect(openSignedUpload).toHaveBeenCalledTimes(0);
  });
});

describe("inner#1595: issueUploadTicketBatch", () => {
  const CONTEXT = { spaceId: ITEM.space_id, toolName: "image.grid" };
  const Ka = "image/2026-10-26/a.png";
  const Kb = "image/2026-10-26/b.png";
  const Kd = "image/2026-10-26/d.png";

  /**
   * One tile of the batch.
   * @param name - Its name, which is also its hash.
   * @returns The tile.
   */
  function tileNamed(name: string): typeof ITEM {
    return { ...ITEM, filename: `${name}.png`, client_hash: `hash-${name}`, node_id: `node-${name}` };
  }

  /** Four tiles, the third already held by the studio, opened as Ka, Kb, Kd. */
  function fourTiles(): (typeof ITEM)[] {
    checkUploadDedup.mockImplementation(async ({ contentHash }: { contentHash: string }) =>
      contentHash === "hash-c"
        ? { assetId: "asset-c", fileUrl: "https://cdn.test.invalid/c.png", kind: "image", width: 1, height: 1 }
        : null,
    );
    openUpload
      .mockResolvedValueOnce({ key: Ka, studioId: "studio-1", taskId: "task-a" })
      .mockResolvedValueOnce({ key: Kb, studioId: "studio-1", taskId: "task-b" })
      .mockResolvedValueOnce({ key: Kd, studioId: "studio-1", taskId: "task-d" });
    return ["a", "b", "c", "d"].map(tileNamed);
  }

  /**
   * Answer each key's open with what `byKey` says, or open it.
   * @param byKey - The failure to throw for a key.
   */
  function openFailsFor(byKey: Record<string, unknown>): void {
    openSignedUpload.mockImplementation(async (request: { storageKey: string }) => {
      const failure = byKey[request.storageKey];
      if (failure !== undefined) throw failure;
      return OK;
    });
  }

  it("T57: lets one file's open failure touch only that file", async () => {
    const items = fourTiles();
    openFailsFor({ [Kb]: new UploadOpenFailed({ storageKey: Kb, reason: "store_failed", settled: S, cause: C }) });

    const outcomes = await issueUploadTicketBatch(SCOPE, CONTEXT, items);

    expect(outcomes).toHaveLength(4);
    expect(outcomes[0]).toMatchObject({ kind: "ticket", storageKey: Ka, uploadId: "u-1", token: "t-1", taskId: "task-a" });
    expect(outcomes[1]).toEqual({ kind: "openFailed", reason: "store_failed", taskId: "task-b" });
    expect(outcomes[2]).toMatchObject({ kind: "alreadyExists", assetId: "asset-c" });
    expect(outcomes[3]).toMatchObject({ kind: "ticket", storageKey: Kd, taskId: "task-d" });
    const keys = openSignedUpload.mock.calls.map((call) => (call[0] as { storageKey: string }).storageKey);
    expect(keys.sort()).toEqual([Ka, Kb, Kd].sort());
    // inner#1595 R1: the opener bounds itself by each request's deadline.
    for (const call of openSignedUpload.mock.calls) expect(call).toHaveLength(1);
    expect(assertStudioStorageAllowance).toHaveBeenCalledTimes(1);
    const lines = openFailedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ key: Kb });
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(1);
    expect(noteIngestSideEffects).toHaveBeenCalledWith(Kb, S);
  });

  it("T79: settles the batch when one file's settling failed too, with no AggregateError", async () => {
    const items = fourTiles();
    openFailsFor({ [Kb]: new UploadOpenFailed({ storageKey: Kb, reason: "store_failed", settleError: D, cause: C }) });

    const outcomes = await issueUploadTicketBatch(SCOPE, CONTEXT, items);

    expect(outcomes[0]).toMatchObject({ kind: "ticket", storageKey: Ka });
    expect(outcomes[1]).toEqual({ kind: "openFailed", reason: "store_failed", taskId: "task-b" });
    expect(outcomes[2]).toMatchObject({ kind: "alreadyExists" });
    expect(outcomes[3]).toMatchObject({ kind: "ticket", storageKey: Kd });
    const lines = openFailedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.settleError).toBe(D);
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(0);
  });

  it("T79: answers every file on its own when the whole batch fails to open", async () => {
    const items = fourTiles();
    openFailsFor({
      [Ka]: new UploadOpenFailed({ storageKey: Ka, reason: "store_failed", settled: S, cause: C }),
      [Kb]: new UploadOpenFailed({ storageKey: Kb, reason: "store_failed", settleError: D, cause: C }),
      [Kd]: new UploadOpenFailed({ storageKey: Kd, reason: "store_failed", settled: S, cause: C }),
    });

    const outcomes = await issueUploadTicketBatch(SCOPE, CONTEXT, items);

    expect(outcomes).toEqual([
      { kind: "openFailed", reason: "store_failed", taskId: "task-a" },
      { kind: "openFailed", reason: "store_failed", taskId: "task-b" },
      expect.objectContaining({ kind: "alreadyExists" }),
      { kind: "openFailed", reason: "store_failed", taskId: "task-d" },
    ]);
    const lines = openFailedLines();
    expect(lines).toHaveLength(3);
    const byKey = new Map(lines.map((line) => [line.key, line]));
    expect(byKey.get(Kb)!.settleError).toBe(D);
    expect(byKey.get(Ka)!.settleError).toBeUndefined();
    expect(byKey.get(Kd)!.settleError).toBeUndefined();
    expect(noteIngestSideEffects).toHaveBeenCalledTimes(2);
    expect(noteIngestSideEffects).toHaveBeenCalledWith(Ka, S);
    expect(noteIngestSideEffects).toHaveBeenCalledWith(Kd, S);
  });

  it("T58: opens every grant and row first, then opens every upload at once", async () => {
    let n = 0;
    openUpload.mockImplementation(async () => {
      n += 1;
      return { key: `image/2026-10-26/${n}.png`, studioId: "studio-1", taskId: `task-${n}` };
    });
    const pending: Array<() => void> = [];
    openSignedUpload.mockImplementation(
      (request: { storageKey: string }) =>
        new Promise((resolve) => {
          pending.push(() => resolve({ ...OK, uploadId: `u-${request.storageKey}` }));
        }),
    );
    const items = Array.from({ length: 8 }, (_, i) => tileNamed(`t${i}`));

    const running = issueUploadTicketBatch(SCOPE, CONTEXT, items);

    // Every open is in flight before any of them has answered.
    await vi.waitFor(() => expect(openSignedUpload).toHaveBeenCalledTimes(8));
    expect(openUpload).toHaveBeenCalledTimes(8);
    const firstOpen = Math.min(...openSignedUpload.mock.invocationCallOrder);
    expect(Math.max(...openUpload.mock.invocationCallOrder)).toBeLessThan(firstOpen);
    for (const answer of pending) answer();

    const outcomes = await running;
    expect(outcomes.map((outcome) => (outcome as { storageKey?: string }).storageKey)).toEqual(
      Array.from({ length: 8 }, (_, i) => `image/2026-10-26/${i + 1}.png`),
    );
    expect(outcomes.every((outcome) => outcome.kind === "ticket")).toBe(true);
  });

  it("T59: opens BATCH_MAX files, each once", async () => {
    expect(BATCH_MAX).toBe(64);
    let n = 0;
    openUpload.mockImplementation(async () => {
      n += 1;
      return { key: `image/2026-10-26/${n}.png`, studioId: "studio-1", taskId: `task-${n}` };
    });
    const items = Array.from({ length: BATCH_MAX }, (_, i) => tileNamed(`t${i}`));

    const outcomes = await issueUploadTicketBatch(SCOPE, CONTEXT, items);

    expect(openSignedUpload).toHaveBeenCalledTimes(BATCH_MAX);
    const keys = openSignedUpload.mock.calls.map((call) => (call[0] as { storageKey: string }).storageKey);
    expect(new Set(keys).size).toBe(BATCH_MAX);
    expect(outcomes.every((outcome) => outcome.kind === "ticket")).toBe(true);
  });
});
