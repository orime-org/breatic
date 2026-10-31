// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";
import type * as SharedModule from "@breatic/shared";
import type * as AssetServiceModule from "@domain/asset/asset.service.js";
import type * as GrantRepoModule from "@domain/asset/upload-grant.repo.js";

const h = vi.hoisted(() => ({
  issueGrant: vi.fn(),
  voidGrant: vi.fn(),
  resolveOwnerStudioId: vi.fn(),
  storageKey: vi.fn(),
  getStorageAdapter: vi.fn(),
  httpRequest: vi.fn(),
  applyIngestReport: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    env: { INGEST_BASE_URL: "https://ingest.example", INGEST_SHARED_SECRET: "test-secret" },
    getStorageAdapter: h.getStorageAdapter,
    storageKey: h.storageKey,
  };
});
vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedModule>();
  return { ...actual, httpRequest: h.httpRequest };
});
vi.mock("@domain/asset/upload-grant.repo.js", async (importOriginal) => ({
  ...await importOriginal<typeof GrantRepoModule>(),
  issueGrant: h.issueGrant,
  voidGrant: h.voidGrant,
}));
vi.mock("@domain/asset/asset.service.js", async (importOriginal) => ({
  ...await importOriginal<typeof AssetServiceModule>(),
  resolveOwnerStudioId: h.resolveOwnerStudioId,
}));
vi.mock("@domain/asset/ingest-report.service.js", () => ({ applyIngestReport: h.applyIngestReport }));

const { advanceLongMediaSegmentation, createSegmentGrants } =
  await import("@domain/understand/long-media-segmentation.js");

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveOwnerStudioId.mockResolvedValue("studio-owner");
  h.storageKey.mockImplementation(({ taskType, ext }: { taskType: string; ext: string }) => `${taskType}/segment-${String(h.storageKey.mock.calls.length - 1)}${ext}`);
  h.issueGrant.mockImplementation(async ({ storageKey }: { storageKey: string }) => ({ id: `ledger:${storageKey}` }));
  h.voidGrant.mockResolvedValue(true);
  h.getStorageAdapter.mockResolvedValue({ keyFromUrl: () => "audio/source.wav" });
  h.applyIngestReport.mockImplementation(async ({ storageKey }: { storageKey: string }) => ({
    status: "already_registered",
    fileUrl: `https://assets.example/${storageKey}`,
    mimeType: "audio/mpeg",
    sizeBytes: 900,
  }));
});

describe("advanceLongMediaSegmentation", () => {
  it("returns each registered segment with its original source-time core", async () => {
    const descriptor = { inputKind: "source_file", mediaKind: "audio" } as const;
    h.httpRequest.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        return new Response(JSON.stringify({
          jobId: "understand_operation-1_0",
          operationId: "operation-1",
          sourceIndex: 0,
          phase: "running",
          version: 1,
          deadlineAt: Date.now() + 60_000,
          terminalIntent: null,
        }), { status: 201 });
      }
      if (url.endsWith("/probe")) {
        return new Response(JSON.stringify({
          version: 1,
          sourceFingerprint: "a".repeat(64),
          selectedVideoStreamIndex: null,
          streams: [{ index: 0, kind: "audio", startUs: "-500000", endUs: "20000000" }],
          mediaInputs: [{
            mediaInputId: "source-file-0",
            descriptor,
            sourceRange: { startUs: "-500000", endUs: "20000000" },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify([
        {
          id: "segment-1",
          mediaInputId: "source-file-0",
          descriptor,
          core: { startUs: "10000000", endUs: "20000000" },
          decode: { startUs: "10000000", endUs: "20000000" },
          grantId: "grant-1",
          storageKey: "audio/segment-1.mp3",
          measured: { sha256: "b".repeat(64), sizeBytes: 900, contentType: "audio/mpeg" },
          status: "ready",
          version: 3,
        },
        {
          id: "segment-0",
          mediaInputId: "source-file-0",
          descriptor,
          core: { startUs: "-500000", endUs: "10000000" },
          decode: { startUs: "-500000", endUs: "10000000" },
          grantId: "grant-0",
          storageKey: "audio/segment-0.mp3",
          measured: { sha256: "c".repeat(64), sizeBytes: 900, contentType: "audio/mpeg" },
          status: "ready",
          version: 2,
        },
      ]), { status: 200 });
    });

    const progress = await advanceLongMediaSegmentation({
      source: {
        key: "audio/source.wav",
        sha256: "a".repeat(64),
        sizeBytes: 30_000_000,
        mimeType: "audio/wav",
      },
      sourceUrl: "https://assets.example/audio/source.wav",
      actorUserId: "user-1",
      projectId: "project-1",
      operationId: "operation-1",
      deadlineAt: Date.now() + 60_000,
      maxSourceBytes: 20_000_000,
    });

    expect(progress).toEqual({
      kind: "ready",
      segments: [
        {
          url: "https://assets.example/audio/segment-0.mp3",
          ledgerType: "audio/mpeg",
          sizeBytes: 900,
          startUs: "-500000",
          endUs: "10000000",
        },
        {
          url: "https://assets.example/audio/segment-1.mp3",
          ledgerType: "audio/mpeg",
          sizeBytes: 900,
          startUs: "10000000",
          endUs: "20000000",
        },
      ],
    });
  });
});

describe("createSegmentGrants", () => {
  it("puts the persisted upload grant id in each Ingest write permit", async () => {
    const grants = await createSegmentGrants({
      source: { key: "source.mp4", sha256: "a".repeat(64), sizeBytes: 30_000_000, mimeType: "video/mp4" },
      sourceUrl: "https://assets.example/source.mp4",
      actorUserId: "user-1",
      projectId: "project-1",
      operationId: "operation-1",
      deadlineAt: Date.now() + 60_000,
      maxSourceBytes: 20_000_000,
    }, [
      { id: "segment-0", descriptor: { inputKind: "source_file", mediaKind: "video" } },
      { id: "segment-1", descriptor: { inputKind: "source_file", mediaKind: "video" } },
    ], 20_000_000);

    expect(grants.map(({ grantId }) => grantId)).toEqual([
      "ledger:video/segment-0.mp4",
      "ledger:video/segment-1.mp4",
    ]);
    expect(grants.map(({ segmentId }) => segmentId)).toEqual(["segment-0", "segment-1"]);
    expect(h.issueGrant).toHaveBeenCalledTimes(2);
    expect(h.issueGrant).toHaveBeenNthCalledWith(1, expect.objectContaining({
      userId: "user-1",
      studioId: "studio-owner",
      storageKey: "video/segment-0.mp4",
      declaredSize: 20_000_000,
      context: { projectId: "project-1", derived: true },
    }));
    expect(grants[0]?.candidateId).not.toBe(grants[1]?.candidateId);
  });

  it("voids already issued grants when cancellation interrupts plan preparation", async () => {
    const controller = new AbortController();
    h.issueGrant.mockImplementationOnce(async ({ storageKey }: { storageKey: string }) => {
      controller.abort();
      return { id: `ledger:${storageKey}` };
    });

    await expect(createSegmentGrants({
      source: { key: "source.mp4", sha256: "a".repeat(64), sizeBytes: 30_000_000, mimeType: "video/mp4" },
      sourceUrl: "https://assets.example/source.mp4",
      actorUserId: "user-1",
      projectId: "project-1",
      operationId: "operation-1",
      deadlineAt: Date.now() + 60_000,
      maxSourceBytes: 20_000_000,
    }, [
      { id: "segment-0", descriptor: { inputKind: "source_file", mediaKind: "video" } },
      { id: "segment-1", descriptor: { inputKind: "source_file", mediaKind: "video" } },
    ], 20_000_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(h.issueGrant).toHaveBeenCalledOnce();
    expect(h.voidGrant).toHaveBeenCalledWith("video/segment-0.mp4", "cancelled");
  });
});
