// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Assets route tests — presign + local upload + history.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return coreMock(importOriginal);
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

// The /uploaded + /deleted routes import recordProjectActivity DIRECT from the
// service module (not via the @server/modules barrel), so the barrel mock above
// does not intercept it — mock the module itself to assert the feed row (#1824).
vi.mock("@server/modules/activity/projectActivity.service.js", () => ({
  recordProjectActivity: vi.fn(),
}));

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";

const AUTH = { Cookie: "breatic_session=valid-token" };

describe("Assets routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectService.assertAccess.mockResolvedValue(undefined);
  });

  describe("GET /assets/presign", () => {
    it("requires auth", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001&size=1",
      );

      expect(res.status).toBe(401);
    });

    it("rejects missing params with 400", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/presign", { headers: AUTH });

      expect(res.status).toBe(400);
    });

    it("rejects a filename with a path separator or control char (400)", async () => {
      const app = createApp();
      const proj = "a0000000-0000-4000-8000-000000000001";
      for (const bad of ["a/b.png", "a\\b.png", "a\u0001b.png"]) {
        const res = await app.request(
          `/api/v1/assets/presign?filename=${encodeURIComponent(bad)}&content_type=image/png&project_id=${proj}&size=1`,
          { headers: AUTH },
        );
        expect(res.status).toBe(400);
      }
    });

    it("accepts a Unicode (Chinese) filename — the whitelist must not reject it", async () => {
      const app = createApp();
      const proj = "a0000000-0000-4000-8000-000000000001";
      const res = await app.request(
        `/api/v1/assets/presign?filename=${encodeURIComponent("我的图片 (1).png")}&content_type=image/png&project_id=${proj}&size=1`,
        { headers: AUTH },
      );
      // Passes the filename validator (any later failure is the mocked
      // storage adapter, never a 400 from the character check).
      expect(res.status).not.toBe(400);
    });

    it("requires the declared size (400 without it)", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001",
        { headers: AUTH },
      );

      expect(res.status).toBe(400);
    });

    it("rejects a size over the upload cap with 413 (authoritative gate)", async () => {
      const app = createApp();
      // mocked getStorageConfig caps max_upload_bytes at 1024
      const res = await app.request(
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001&size=2048",
        { headers: AUTH },
      );

      expect(res.status).toBe(413);
    });

    it("allows a size exactly at the cap (boundary)", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001&size=1024",
        { headers: AUTH },
      );

      // Passes the cap gate (any later failure would be a non-413 status).
      expect(res.status).not.toBe(413);
    });

    it("rejects a malformed hash with 400", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001&size=1&hash=nothex",
        { headers: AUTH },
      );

      expect(res.status).toBe(400);
    });
  });

  describe("GET /assets/upload-config (#1609 slice 2)", () => {
    it("requires auth", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/upload-config");

      expect(res.status).toBe(401);
    });

    it("returns the yaml upload knobs (camelCase wire shape)", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/upload-config", {
        headers: AUTH,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          maxUploadBytes: number;
          clientMaxAttempts: number;
          clientRetryBaseDelayMs: number;
          clientRequestTimeoutMs: number;
          clientPutMinBytesPerSec: number;
        };
      };
      expect(body.data).toEqual({
        maxUploadBytes: 1024,
        clientMaxAttempts: 2,
        clientRetryBaseDelayMs: 250,
        clientRequestTimeoutMs: 5000,
        clientPutMinBytesPerSec: 1024,
      });
    });
  });

  describe("POST /assets/uploaded (handshake, replaced /assets/history)", () => {
    it("requires auth", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "a0000000-0000-4000-8000-000000000001",
          key: "u/p/img/abc.png",
          kind: "image",
        }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("POST /assets/uploaded — dedup report schema (#1609)", () => {
    it("rejects a dedup report without a hash (400)", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "a0000000-0000-4000-8000-000000000001",
          dedup: true,
          kind: "image",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects a regular report without a key (400)", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "a0000000-0000-4000-8000-000000000001",
          kind: "image",
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  // #1824: an uploaded video's server-derived cover thumbnail must reach BOTH
  // sinks — the node-history row (consumer ①, via recordUpload.thumbnailUrl) and
  // the activity feed row (consumer ②, via the payload's thumbnailUrl) — and a
  // DERIVED byproduct (cover / crop, `derived: true`, product model A) must be
  // registered in the ledger but NOT announced as its own feed row.
  describe("POST /assets/uploaded — cover thumbnail wire + derived gating (#1824)", () => {
    const PROJ = "a0000000-0000-4000-8000-000000000001";
    const VIDEO_KEY = `user-1/${PROJ}/video/clip.mp4`;
    const COVER_KEY = `user-1/${PROJ}/image/clip-cover.jpg`;

    beforeEach(() => {
      // Both the video head (regular path) and the cover head (resolveCoverUrl)
      // read this same adapter; every key exists and gets a derived public URL.
      mocks.getStorageAdapter.mockResolvedValue({
        head: vi.fn().mockResolvedValue({ exists: true, contentType: "", size: 100 }),
        publicUrl: (k: string) => `https://cdn/${k}`,
      });
    });

    afterEach(() => {
      // getStorageAdapter + verifyDedupUpload are SHARED mocks; reset their
      // implementations so this block's stubs never leak into a sibling describe
      // — vi.clearAllMocks (outer beforeEach) clears call history but NOT
      // implementations (Gate-2 test-isolation, #1824).
      mocks.getStorageAdapter.mockReset();
      mocks.assetUploadService.verifyDedupUpload.mockReset();
    });

    it("derives the cover URL from cover_key → recordUpload thumbnail (①) + activity payload thumbnail (②)", async () => {
      const app = createApp();
      // hash omitted → the ledger-register path is skipped, isolating the cover
      // wire (recordUpload + activity) from asset registration (#1609's concern).
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: VIDEO_KEY,
          kind: "video",
          node_id: "node-1",
          space_id: "b0000000-0000-4000-8000-000000000002",
          cover_key: COVER_KEY,
        }),
      });

      expect(res.status).toBe(200);
      // ① node-history row carries the cover as its thumbnail.
      expect(mocks.nodeHistoryService.recordUpload).toHaveBeenCalledOnce();
      expect(mocks.nodeHistoryService.recordUpload).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnailUrl: `https://cdn/${COVER_KEY}` }),
      );
      // ② activity feed row carries the cover in its payload.
      expect(vi.mocked(recordProjectActivity)).toHaveBeenCalledOnce();
      const activity = vi.mocked(recordProjectActivity).mock.calls[0]![0];
      expect(activity.type).toBe("asset:uploaded");
      expect(activity.payload).toMatchObject({
        kind: "video",
        thumbnailUrl: `https://cdn/${COVER_KEY}`,
      });
    });

    it("a coverless video leaves the thumbnail undefined in both sinks (degrades to a Film icon)", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: VIDEO_KEY,
          kind: "video",
          node_id: "node-1",
        }),
      });

      expect(res.status).toBe(200);
      expect(mocks.nodeHistoryService.recordUpload).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnailUrl: undefined }),
      );
      const activity = vi.mocked(recordProjectActivity).mock.calls[0]![0];
      expect("thumbnailUrl" in activity.payload).toBe(false);
    });

    it("a DERIVED byproduct (derived:true) registers but emits NO activity feed row", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: COVER_KEY,
          kind: "image",
          derived: true,
        }),
      });

      expect(res.status).toBe(200);
      // The byproduct is NOT announced as its own feed row (product model A).
      expect(vi.mocked(recordProjectActivity)).not.toHaveBeenCalled();
    });

    it("a real (non-derived) upload emits its activity feed row", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: COVER_KEY,
          kind: "image",
        }),
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(recordProjectActivity)).toHaveBeenCalledOnce();
    });

    it("a storage-adapter failure while resolving the cover degrades to no thumbnail — never fails the video's records (best-effort, decision #4)", async () => {
      // 1st getStorageAdapter (video head) succeeds; the 2nd (cover) throws.
      // The cover must degrade to undefined, and recordUpload + the feed row
      // must STILL fire — a cover problem never fails the video's audit sinks.
      mocks.getStorageAdapter
        .mockResolvedValueOnce({
          head: vi.fn().mockResolvedValue({ exists: true, contentType: "", size: 100 }),
          publicUrl: (k: string) => `https://cdn/${k}`,
        })
        .mockRejectedValueOnce(new Error("adapter construction failed"));
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: VIDEO_KEY,
          kind: "video",
          node_id: "node-1",
          cover_key: COVER_KEY,
        }),
      });

      expect(res.status).toBe(200);
      expect(mocks.nodeHistoryService.recordUpload).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnailUrl: undefined }),
      );
      expect(vi.mocked(recordProjectActivity)).toHaveBeenCalledOnce();
    });

    it("resolves the cover even when kind='file' — a browser-decodable video outside detectKind's narrow VIDEO_TYPES (Firefox .ogv) must not lose its cover (Gate-2 re-attack)", async () => {
      // The frontend extracts a cover for ANY video/* (broad), but the reported
      // kind is detectKind(content_type), whose VIDEO_TYPES whitelist is narrow
      // — a video/ogg upload reports kind='file'. Gating the cover on
      // kind==='video' would 400 the whole report and lose both sinks; the
      // cover must still resolve (its own key segment is the authority).
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: `user-1/${PROJ}/file/clip.ogv`,
          kind: "file",
          node_id: "node-1",
          cover_key: COVER_KEY,
        }),
      });

      expect(res.status).toBe(200);
      expect(mocks.nodeHistoryService.recordUpload).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnailUrl: `https://cdn/${COVER_KEY}` }),
      );
    });

    it("a dedup cover (cover_hash) resolves from the DB even when the storage adapter is unhealthy — the DB-only path is not coupled to adapter health (Gate-2 R3)", async () => {
      // A fully-deduped video + cover: NEITHER needs the storage adapter (both
      // resolve from verifyDedupUpload). Make the adapter throw to prove the
      // cover is not coupled to adapter health — and assert it is never built.
      mocks.getStorageAdapter.mockReset();
      mocks.getStorageAdapter.mockRejectedValue(new Error("adapter down"));
      const VIDEO_HASH = "a".repeat(64);
      const COVER_HASH = "b".repeat(64);
      mocks.assetUploadService.verifyDedupUpload.mockImplementation(
        async ({ contentHash }: { contentHash: string }) => {
          if (contentHash === VIDEO_HASH)
            return {
              fileUrl: "https://cdn/v.mp4",
              storageKey: `user-1/${PROJ}/video/v.mp4`,
              kind: "video",
            };
          if (contentHash === COVER_HASH)
            return {
              fileUrl: "https://cdn/c.jpg",
              storageKey: `user-1/${PROJ}/image/c.jpg`,
              kind: "file", // ledger kind is unreliable — the key segment wins
            };
          return null;
        },
      );
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          dedup: true,
          hash: VIDEO_HASH,
          kind: "video",
          node_id: "node-1",
          cover_hash: COVER_HASH,
        }),
      });

      expect(res.status).toBe(200);
      // The cover resolved from the DB despite the dead adapter.
      expect(mocks.nodeHistoryService.recordUpload).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnailUrl: "https://cdn/c.jpg" }),
      );
      // The adapter was never even built (dedup video + dedup cover need no storage).
      expect(mocks.getStorageAdapter).not.toHaveBeenCalled();
    });
  });

  describe("POST /assets/deleted (report)", () => {
    it("requires auth", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/deleted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "a0000000-0000-4000-8000-000000000001",
          entries: [{ file_url: "https://example.com/f.png", kind: "image" }],
        }),
      });

      expect(res.status).toBe(401);
    });
  });
});
