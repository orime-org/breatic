// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent's save, as the server runs it (inner#1315): the gates the canvas
 * paste goes through, in its order, then the transfer in the request; every
 * refusal handed to the tool as the kind it tells the model about.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const checkRateLimit = vi.fn();
const assertAccess = vi.fn();
const assertStorageAllowance = vi.fn();
const transferReaderUrlToStorage = vi.fn();
const noteIngestSideEffects = vi.fn();
const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

class ReaderUrlTransferError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  checkRateLimit,
  getRedis: () => ({}),
  logger: log,
}));
vi.mock("@breatic/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof DomainModule>()),
  backendUploadService: { transferReaderUrlToStorage, ReaderUrlTransferError },
}));
vi.mock("@server/config/rate-limits.js", () => ({ getRateLimit: () => ({ max: 30, windowSeconds: 60 }) }));
vi.mock("@server/modules/project/project.service.js", () => ({ assertAccess }));
vi.mock("@server/modules/asset/storageQuota.service.js", () => ({ assertStorageAllowance }));
vi.mock("@server/modules/asset/ingest-side-effects.js", () => ({ noteIngestSideEffects }));

const { AppError } = await import("@breatic/core");
const { SaveRefused } = await import("@breatic/domain");
const { saveToStorageFor } = await import("@server/agent/save-to-storage.js");

const LINK = "https://imgs.example/cat.jpg";
const STORED = {
  storageKey: "url/2026-10-08/k.jpg",
  assetId: "a1",
  fileUrl: "https://resource.example/url/k.jpg",
  kind: "image",
  coverUrl: null,
  width: 500,
  height: 375,
  durationSeconds: null,
  mimeType: "image/jpeg",
  sizeBytes: 400,
};

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockResolvedValue(true);
  assertAccess.mockResolvedValue(undefined);
  assertStorageAllowance.mockResolvedValue(undefined);
  transferReaderUrlToStorage.mockResolvedValue(STORED);
});

const save = saveToStorageFor({ projectId: "p1", userId: "u1" });

/**
 * The refusal a save ended with.
 * @param call - The pending save.
 * @returns The error.
 */
async function refusalOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => err,
  );
}

describe("saveToStorageFor", () => {
  it("passes the gates in order and answers with the stored picture", async () => {
    const stop = new AbortController();

    const saved = await save(LINK, stop.signal);

    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), "ingest-url:u1", 30, 60);
    expect(assertAccess).toHaveBeenCalledWith("p1", "u1", "editor");
    expect(assertStorageAllowance).toHaveBeenCalledWith("p1", "upload");
    expect(transferReaderUrlToStorage).toHaveBeenCalledWith(LINK, { projectId: "p1", actingUserId: "u1" }, stop.signal);
    expect(noteIngestSideEffects).toHaveBeenCalledWith(STORED.storageKey, STORED);
    expect(saved).toEqual({ url: STORED.fileUrl, mimeType: "image/jpeg", width: 500, height: 375 });
  });

  it("refuses over the canvas paste's rate, logged as a hit", async () => {
    checkRateLimit.mockResolvedValue(false);

    const err = await refusalOf(save(LINK));

    expect(err).toBeInstanceOf(SaveRefused);
    expect((err as InstanceType<typeof SaveRefused>).kind).toBe("rate_limited");
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ action: "ingest-url", key: "u1" }), "rate_limit_hit");
    expect(transferReaderUrlToStorage).not.toHaveBeenCalled();
  });

  it.each([403, 404])("refuses a reader with no edit access (%s)", async (status) => {
    assertAccess.mockRejectedValue(new AppError(status, "no"));

    const err = await refusalOf(save(LINK));

    expect((err as InstanceType<typeof SaveRefused>).kind).toBe("no_access");
  });

  it("refuses when the studio has no storage left", async () => {
    assertStorageAllowance.mockRejectedValue(new AppError(507, "full"));

    const err = await refusalOf(save(LINK));

    expect((err as InstanceType<typeof SaveRefused>).kind).toBe("storage_full");
    expect(transferReaderUrlToStorage).not.toHaveBeenCalled();
  });

  it("refuses a link that did not land, at warn for the reader's own link", async () => {
    transferReaderUrlToStorage.mockRejectedValue(new ReaderUrlTransferError("source_unreachable"));

    const err = await refusalOf(save(LINK));

    expect(err).toMatchObject({ kind: "link", detail: "source_unreachable" });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", userId: "u1", url: LINK }), "agent_save_failed");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs a failure on our side as an error and lets it through", async () => {
    transferReaderUrlToStorage.mockRejectedValue(new ReaderUrlTransferError("store_failed"));

    await refusalOf(save(LINK));

    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ reason: "store_failed" }), "agent_save_failed");
  });

  it("logs anything else as an error and rethrows it", async () => {
    const boom = new Error("db down");
    transferReaderUrlToStorage.mockRejectedValue(boom);

    const err = await refusalOf(save(LINK));

    expect(err).toBe(boom);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: boom }), "agent_save_failed");
  });

  it("rethrows a stop without logging it as a failure", async () => {
    const stop = new AbortController();
    stop.abort();
    const aborted = new DOMException("aborted", "AbortError");
    transferReaderUrlToStorage.mockRejectedValue(aborted);

    const err = await refusalOf(save(LINK, stop.signal));

    expect(err).toBe(aborted);
    expect(log.error).not.toHaveBeenCalled();
  });
});
