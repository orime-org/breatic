// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the backend tells a Document body block about its upload (breatic#1574).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as core from "@breatic/core";

const published = vi.hoisted(() => ({ events: [] as unknown[] }));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof core>()),
  getStreamRedis: vi.fn(() => ({})),
  publishDocumentUploadEvent: vi.fn(async (_redis: unknown, event: unknown) => {
    published.events.push(event);
  }),
}));

const { announceDocumentUploadAsset, announceDocumentUploadFailure, documentTargetOf } = await import("../document-upload-events.js");

const TARGET = { projectId: "p", spaceId: "s", uploadId: "u1" };

beforeEach(() => {
  published.events = [];
});

describe("a Document block's upload", () => {
  it("hands the block a picture, a video or a sound with its address and size", async () => {
    await announceDocumentUploadAsset(TARGET, { kind: "image", fileUrl: "https://cdn/a.png", width: 8, height: 6 });
    expect(published.events).toEqual([{
      type: "document-upload", docName: "project-p/document-s", uploadId: "u1", state: "completed",
      result: { url: "https://cdn/a.png", mediaWidth: 8, mediaHeight: 6 },
    }]);
  });

  it("fails the block when the upload resolved to something that is not a medium", async () => {
    await announceDocumentUploadAsset(TARGET, { kind: "document", fileUrl: "https://cdn/a.pdf", width: null, height: null });
    expect(published.events).toEqual([expect.objectContaining({ state: "failed", reason: "unsupported_type" })]);
  });

  it("tells the block the cause a raw failure normalises to, and no cause for one it does not know", async () => {
    await announceDocumentUploadFailure(TARGET, "unsupported_type");
    await announceDocumentUploadFailure(TARGET, "not a code of ours");
    expect(published.events).toEqual([
      expect.objectContaining({ state: "failed", reason: "unsupported_type" }),
      expect.not.objectContaining({ reason: expect.anything() }),
    ]);
  });

  it("names no block for a grant without one", () => {
    expect(documentTargetOf({ projectId: "p", spaceId: "s", documentUploadId: null })).toBeNull();
    expect(documentTargetOf({ projectId: "p", spaceId: "s", documentUploadId: "u1" })).toEqual(TARGET);
  });
});
