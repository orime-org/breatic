// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Shared from "@breatic/shared";
import type { ChatAttachedChip } from "@breatic/shared";
import type { AgentPicturePreparation, PrepareAgentPictures } from "@domain/agent/prepare-agent-pictures.js";

type BoundCallbacks = Pick<AgentPicturePreparation, "resolveSource" | "readPicture">;

const h = vi.hoisted(() => ({
  callbacks: undefined as BoundCallbacks | undefined,
  keyFromUrl: vi.fn(), live: vi.fn(), save: vi.fn(), read: vi.fn(), error: vi.fn(),
}));

vi.mock("@breatic/core", () => ({
  getAgentConfig: () => ({ agent_picture_long_edge: 1024, agent_picture_quality: 85, agent_picture_concurrency: 4 }),
  getNodeTaskConfig: () => ({ default_budget_ms: 7_200_000 }),
  budgetDeadlineFrom: (now: number): number => now + 7_200_000,
  env: { INGEST_BASE_URL: "https://ingest.example.test", INGEST_SHARED_SECRET: "unit-test-secret" },
  getStorageAdapter: async () => ({ keyFromUrl: h.keyFromUrl, publicUrl: (key: string): string => `https://media.example/${key}` }),
  logger: { error: h.error },
}));
vi.mock("@breatic/domain", async () => {
  const { createAgentPicturePreparer } = await import("@domain/agent/prepare-agent-pictures.js");
  const { readerUrlSchema } = await import("@domain/asset/source-url.js");
  return {
    assetRepo: { findLiveByKeyInStudio: h.live },
    createAgentPicturePreparer: (callbacks: AgentPicturePreparation): PrepareAgentPictures => {
      h.callbacks = callbacks;
      return createAgentPicturePreparer(callbacks);
    },
    readerUrlSchema,
    SaveRefused: class extends Error {
      constructor(readonly kind: string, readonly reason?: string) { super(kind); }
    },
  };
});
vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return { ...actual, readStoredMediaAtIngest: h.read };
});
vi.mock("@server/agent/save-to-storage.js", () => ({ saveToStorageFor: () => h.save }));

import { picturePreparerFor, pictureSourcesForTurn } from "@server/agent/prepare-pictures.js";

const WHO = { projectId: "project-1", userId: "user-1", studioId: "studio-1" };
const SPEC = { version: 1 as const, longEdge: 1024, quality: 85 };

/** Capture the real server-bound IO callbacks; the domain scheduler is tested separately. */
function callbacks(): BoundCallbacks {
  picturePreparerFor(WHO);
  if (h.callbacks === undefined) throw new Error("picture callback factory was not installed");
  return h.callbacks;
}

beforeEach(() => {
  h.callbacks = undefined;
  h.keyFromUrl.mockReset().mockImplementation((url: string) => url.startsWith("https://media.example/") ? url.slice("https://media.example/".length) : null);
  h.live.mockReset().mockResolvedValue({ storageKey: "canonical/winner.png", mimeType: "image/png", kind: "image" });
  h.save.mockReset().mockResolvedValue({ url: "https://media.example/canonical/winner.png", mimeType: "image/png" });
  h.read.mockReset().mockResolvedValue({ width: 1024, height: 768, duration: null, agentPicture: { outcome: "generated", sizeBytes: 4567, mediaType: "image/jpeg" } });
  h.error.mockReset();
});

describe("Agent picture preparation is bound to the current Studio and canonical asset", () => {
  it("authorizes a local source by the live Studio ledger and uses its registered key", async () => {
    const source = { label: "Attachment 1", sourceUrl: "https://media.example/requested/source.bin" };
    const canonical = await callbacks().resolveSource(source);

    expect(h.live).toHaveBeenCalledWith("studio-1", "requested/source.bin");
    expect(canonical).toEqual({ storageKey: "canonical/winner.png", contentType: "image/png" });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("refuses missing, deleted or other-Studio local assets without importing them as external URLs", async () => {
    h.live.mockResolvedValueOnce(null);
    const resolved = await callbacks().resolveSource({ label: "Attachment 1", sourceUrl: "https://media.example/other-studio/image.png" });

    expect(resolved).toMatchObject({ status: "unavailable", reason: expect.any(String) });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });

  it("imports an external source through the existing save callback and re-reads the canonical winner", async () => {
    const controller = new AbortController();
    const source = { label: "Search result 1", sourceUrl: "https://external.example/thumbnail.bin" };
    const resolved = await callbacks().resolveSource(source, controller.signal);

    expect(h.save).toHaveBeenCalledWith(source.sourceUrl, controller.signal);
    expect(h.live).toHaveBeenCalledWith("studio-1", "canonical/winner.png");
    expect(resolved).toEqual({ storageKey: "canonical/winner.png", contentType: "image/png" });
  });

  it.each([
    "http://external.example/image.png",
    "ftp://external.example/image.png",
    "not a URL",
    "https://[invalid/image.png",
    "",
    `https://external.example/${"x".repeat(2049 - "https://external.example/".length)}`,
  ])("returns an unavailable item before saving an invalid external source %s", async (sourceUrl) => {
    const resolved = await callbacks().resolveSource({ label: "Attachment 1", sourceUrl });

    expect(resolved).toEqual({ status: "unavailable", reason: expect.stringMatching(/\S/) });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.live).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  it("accepts an external HTTPS source at the existing 2048-character boundary", async () => {
    const prefix = "https://external.example/";
    const sourceUrl = `${prefix}${"x".repeat(2048 - prefix.length)}`;
    const resolved = await callbacks().resolveSource({ label: "Attachment 1", sourceUrl });

    expect(sourceUrl).toHaveLength(2048);
    expect(h.save).toHaveBeenCalledExactlyOnceWith(sourceUrl, undefined);
    expect(resolved).toEqual({ storageKey: "canonical/winner.png", contentType: "image/png" });
  });

  it("keeps ordered unavailable items around valid local and external pictures", async () => {
    const sources = [
      { label: "Attachment 1", sourceUrl: "http://external.example/one.png" },
      { label: "Attachment 2", sourceUrl: "not a URL" },
      { label: "Attachment 3", sourceUrl: "https://media.example/registered/one.png" },
      { label: "Attachment 4", sourceUrl: `https://external.example/${"x".repeat(2049 - "https://external.example/".length)}` },
      { label: "Search result 1", sourceUrl: "https://external.example/valid.png" },
      { label: "Version 2", sourceUrl: "ftp://external.example/two.png" },
    ];

    const prepared = await picturePreparerFor(WHO)(sources);

    const unavailable = { status: "unavailable", reason: expect.stringMatching(/\S/) };
    const ready = { status: "ready", url: "https://media.example/canonical/winner.png.agent-v1-1024-q85.jpg", sizeBytes: 4567, mediaType: "image/jpeg" };
    expect(prepared).toEqual([
      { ...sources[0], ...unavailable },
      { ...sources[1], ...unavailable },
      { ...sources[2], ...ready },
      { ...sources[3], ...unavailable },
      { ...sources[4], ...ready },
      { ...sources[5], ...unavailable },
    ]);
    expect(h.save).toHaveBeenCalledExactlyOnceWith(sources[4]!.sourceUrl, undefined);
    expect(h.live.mock.calls).toEqual([["studio-1", "registered/one.png"], ["studio-1", "canonical/winner.png"]]);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.error).not.toHaveBeenCalled();
  });

  it("propagates an already-aborted turn before classifying an invalid source", async () => {
    const controller = new AbortController();
    const stopped = new Error("turn stopped");
    controller.abort(stopped);

    await expect(callbacks().resolveSource({ label: "Attachment 1", sourceUrl: "not a URL" }, controller.signal)).rejects.toBe(stopped);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.live).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
  });

  it("logs and propagates a valid source's storage failure to the complete batch", async () => {
    const fault = new Error("storage unavailable");
    h.save.mockRejectedValueOnce(fault);

    await expect(picturePreparerFor(WHO)([
      { label: "Attachment 1", sourceUrl: "https://external.example/valid.png" },
      { label: "Attachment 2", sourceUrl: "https://media.example/registered/one.png" },
    ])).rejects.toBe(fault);
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ err: fault, projectId: WHO.projectId, userId: WHO.userId }), "agent_picture_source_failed");
  });

  it("does not generate from an external save result that has no live registration", async () => {
    h.live.mockResolvedValueOnce(null);
    const resolved = await callbacks().resolveSource({ label: "Search result 1", sourceUrl: "https://external.example/image.png" });

    expect(resolved).toMatchObject({ status: "unavailable", reason: expect.any(String) });
    expect(h.read).not.toHaveBeenCalled();
  });

  it("uses real JPEG size facts and the canonical source's versioned key", async () => {
    const controller = new AbortController();
    const bound = callbacks();
    const before = Date.now();
    const prepared = await bound.readPicture({ storageKey: "canonical/winner.png", contentType: "image/png" }, SPEC, controller.signal);

    expect(prepared).toEqual({ url: "https://media.example/canonical/winner.png.agent-v1-1024-q85.jpg", sizeBytes: 4567, mediaType: "image/jpeg" });
    expect(h.read).toHaveBeenCalledWith("https://ingest.example.test", "unit-test-secret", expect.objectContaining({
      storageKey: "canonical/winner.png", contentType: "image/png", agentPicture: SPEC,
    }), controller.signal);
    const about = h.read.mock.calls[0]![2] as { deadlineAt: number };
    expect(about.deadlineAt).toBeGreaterThanOrEqual(before + 7_200_000);
    expect(about.deadlineAt).toBeLessThanOrEqual(Date.now() + 7_200_000);
  });

  it.each([{ outcome: "failed" }, { outcome: "none" }, undefined])("does not manufacture a sendable picture from unusable ingest facts %j", async (agentPicture) => {
    h.read.mockResolvedValueOnce({ width: 100, height: 100, duration: null, agentPicture });
    const prepared = await callbacks().readPicture({ storageKey: "canonical/winner.png", contentType: "image/png" }, SPEC);

    expect(prepared).toMatchObject({ status: "unavailable", reason: expect.any(String) });
    expect(prepared).not.toHaveProperty("url");
  });

  it("logs and rethrows infrastructure failures with the turn's identity", async () => {
    const fault = new Error("repository unavailable");
    h.live.mockRejectedValueOnce(fault);

    await expect(callbacks().resolveSource({ label: "Attachment 1", sourceUrl: "https://media.example/a.png" })).rejects.toBe(fault);
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ err: fault, projectId: WHO.projectId, userId: WHO.userId }), expect.any(String));
  });
});

describe("only explicitly attached image sources are prepared", () => {
  it("takes image chip addresses and image canvas-node content in their attachment order", () => {
    const chips: ChatAttachedChip[] = [
      { id: "a1", name: "cover.bin", type: "image", data_snapshot: { url: "https://source.example/cover.bin" } },
      {
        id: "a2", name: "Selected nodes", type: "canvas", data_snapshot: {
          nodes: [
            { id: "n1", type: "image", data: { name: "Frame one", content: "https://source.example/frame.bin" } },
            { id: "v1", type: "video", data: { content: "https://source.example/movie.mp4", thumbnailUrl: "https://source.example/video-cover.png" } },
            { id: "n2", type: "image", data: { name: "Frame two", content: "https://source.example/second.png" } },
            { id: "n3", type: "image", data: { name: "No source" } },
          ], edges: [],
        },
      },
      { id: "a3", name: "Audio", type: "audio", data_snapshot: { url: "https://source.example/audio.wav" } },
    ];
    const sources = pictureSourcesForTurn(chips);

    expect(sources.map((source) => source.sourceUrl)).toEqual([
      "https://source.example/cover.bin", "https://source.example/frame.bin", "https://source.example/second.png",
    ]);
    expect(sources[0]!.label).toContain("Attachment 1");
    expect(sources[1]!.label).toContain("n1");
    expect(sources[1]!.label).toContain("Frame one");
    expect(sources[2]!.label).toContain("n2");
  });

  it("does not inspect arbitrary URLs embedded in ordinary text attachments", () => {
    expect(pictureSourcesForTurn([
      { id: "text", type: "text", name: "brief", data_snapshot: { text: "https://source.example/not-an-explicit-picture.png" } },
      { id: "empty", type: "image", name: "missing", data_snapshot: {} },
    ])).toEqual([]);
  });
});
