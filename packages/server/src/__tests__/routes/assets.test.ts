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
    // #1826 upload-grant defaults: presign misses dedup + issues a key; the
    // upload endpoints authorise (write-time) + consume (registration). Per-test
    // blocks override as needed.
    mocks.assetUploadService.checkUploadDedup.mockResolvedValue(null);
    mocks.assetUploadService.issueUploadGrant.mockResolvedValue({ key: "issued-key" });
    mocks.assetUploadService.authorizeUploadWrite.mockResolvedValue(true);
    // /uploaded reads the grant ONCE — it both authorises and yields the
    // authoritative owner studio (§2.2 v15 / R5 H8). Default: a live grant.
    mocks.assetUploadService.resolveGrantForReport.mockResolvedValue("s0000000-0000-4000-8000-000000000001");
    mocks.assetUploadService.consumeUploadGrant.mockResolvedValue(true);
  });

  describe("GET /assets/presign", () => {
    it("requires auth", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001&size=1&hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );

      expect(res.status).toBe(401);
    });

    it("rejects missing params with 422", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/presign", { headers: AUTH });

      expect(res.status).toBe(422);
    });

    it("requires the content hash (422 without it — no hash, no upload)", async () => {
      // User decision 2026-07-26: the hash is the ticket. Refusing at PRESIGN
      // means a hashless client never even gets an upload grant, so it cannot
      // burn bandwidth PUTting bytes that /uploaded would have to reject.
      const app = createApp();
      const res = await app.request(
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001&size=1",
        { headers: AUTH },
      );

      expect(res.status).toBe(422);
    });

    it("rejects a filename with a path separator or control char (422)", async () => {
      const app = createApp();
      const proj = "a0000000-0000-4000-8000-000000000001";
      for (const bad of ["a/b.png", "a\\b.png", "a\u0001b.png"]) {
        const res = await app.request(
          `/api/v1/assets/presign?filename=${encodeURIComponent(bad)}&content_type=image/png&project_id=${proj}&size=1&hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
          { headers: AUTH },
        );
        expect(res.status).toBe(422);
      }
    });

    it("accepts a Unicode (Chinese) filename — the whitelist must not reject it", async () => {
      const app = createApp();
      const proj = "a0000000-0000-4000-8000-000000000001";
      const res = await app.request(
        `/api/v1/assets/presign?filename=${encodeURIComponent("我的图片 (1).png")}&content_type=image/png&project_id=${proj}&size=1&hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
        { headers: AUTH },
      );
      // Passes the filename validator (any later failure is the mocked
      // storage adapter, never a 422 from the character check).
      expect(res.status).not.toBe(422);
    });

    it("requires the declared size (422 without it)", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001&hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        { headers: AUTH },
      );

      expect(res.status).toBe(422);
    });

    it("rejects a size over the upload cap with 413 (authoritative gate)", async () => {
      const app = createApp();
      // mocked getStorageConfig caps max_upload_bytes at 1024
      const res = await app.request(
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001&size=2048&hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        { headers: AUTH },
      );

      expect(res.status).toBe(413);
    });

    it("allows a size exactly at the cap (boundary)", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001&size=1024&hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        { headers: AUTH },
      );

      // Passes the cap gate (any later failure would be a non-413 status).
      expect(res.status).not.toBe(413);
    });

    it("rejects a malformed hash with 422", async () => {
      const app = createApp();
      const res = await app.request(
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001&size=1&hash=nothex",
        { headers: AUTH },
      );

      expect(res.status).toBe(422);
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
    it("rejects a dedup report without a hash (422 — the hash is mandatory for every report)", async () => {
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

      expect(res.status).toBe(422);
    });

    it("rejects a regular report without a key (422)", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        // Carries a hash so the 422 can only come from the MISSING KEY —
        // otherwise the (now mandatory) hash check would mask this assertion.
        body: JSON.stringify({
          project_id: "a0000000-0000-4000-8000-000000000001",
          hash: "a".repeat(64),
          kind: "image",
        }),
      });

      expect(res.status).toBe(422);
    });
  });

  // #1824: an uploaded video's server-derived cover thumbnail must reach BOTH
  // sinks — the node-history row (consumer ①, via recordUpload.thumbnailUrl) and
  // the activity feed row (consumer ②, via the payload's thumbnailUrl) — and a
  // DERIVED byproduct (cover / crop, `derived: true`, product model A) must be
  // registered in the ledger but NOT announced as its own feed row.
  describe("POST /assets/uploaded — cover thumbnail wire + derived gating (#1824 / #1826 §4.5)", () => {
    const PROJ = "a0000000-0000-4000-8000-000000000001";
    const VIDEO_KEY = "video/2026-07-25/clip.mp4";
    const COVER_KEY = "image/2026-07-25/clip-cover.jpg";
    const COVER_HASH = "b".repeat(64);
    const COVER_URL = "https://cdn/cover.jpg";

    beforeEach(() => {
      // The video's own object exists in storage (regular-path head()). The
      // content type must be REAL here: every sink now records the
      // authoritative kind (detectKind of what storage reports), so an empty
      // contentType would make these cover-wire assertions be about a
      // degraded 'file' kind instead of about the cover.
      mocks.getStorageAdapter.mockResolvedValue({
        head: vi
          .fn()
          .mockResolvedValue({ exists: true, contentType: "video/mp4", size: 100 }),
        publicUrl: (k: string) => `https://cdn/${k}`,
      });
      // #1826 §4.5: the cover is a FIRST-CLASS studio_assets row (registered by
      // its OWN derived report). The video report just reads that row's
      // canonical URL by cover_hash — no key-derivation, no adapter. The whole
      // resolveCoverUrl / kindFromStorageKey / isOwnedKey path is retired.
      mocks.assetUploadService.verifyDedupUpload.mockImplementation(
        async ({ contentHash }: { contentHash: string }) =>
          contentHash === COVER_HASH
            ? { fileUrl: COVER_URL, storageKey: COVER_KEY, kind: "image" }
            : null,
      );
      // Every accepted report now registers (the hash is mandatory), so the
      // ledger write must succeed for these cover-wire assertions to be about
      // the COVER rather than about a fail-closed register.
      mocks.assetService.register.mockImplementation(
        async ({ storageKey }: { storageKey: string }) => ({
          asset: { storageKey },
          deduped: false,
        }),
      );
    });

    afterEach(() => {
      // Shared mocks — reset implementations so this block never leaks into a
      // sibling describe (vi.clearAllMocks clears history, not implementations).
      mocks.getStorageAdapter.mockReset();
      mocks.assetUploadService.verifyDedupUpload.mockReset();
      mocks.assetService.register.mockReset();
    });

    it("reads the cover URL from cover_hash → recordUpload thumbnail (①) + activity payload thumbnail (②)", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: VIDEO_KEY,
          hash: "a".repeat(64),
          kind: "video",
          node_id: "node-1",
          space_id: "b0000000-0000-4000-8000-000000000002",
          cover_hash: COVER_HASH,
        }),
      });

      expect(res.status).toBe(200);
      // The response returns the resolved cover canonical so the CLIENT pins the
      // node's coverUrl to it (§0 rule 2), not a presign temp key.
      const respBody = (await res.json()) as {
        data: { fileUrl: string; coverUrl?: string };
      };
      expect(respBody.data.coverUrl).toBe(COVER_URL);
      // ① node-history row carries the cover as its thumbnail.
      expect(mocks.nodeHistoryService.recordUpload).toHaveBeenCalledOnce();
      expect(mocks.nodeHistoryService.recordUpload).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnailUrl: COVER_URL }),
      );
      // ② activity feed row carries the cover in its payload.
      expect(vi.mocked(recordProjectActivity)).toHaveBeenCalledOnce();
      const activity = vi.mocked(recordProjectActivity).mock.calls[0]![0];
      expect(activity.type).toBe("asset:uploaded");
      expect(activity.payload).toMatchObject({ kind: "video", thumbnailUrl: COVER_URL });
    });

    it("a coverless video (no cover_hash) leaves the thumbnail undefined in both sinks (Film icon)", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: PROJ, key: VIDEO_KEY, hash: "a".repeat(64), kind: "video", node_id: "node-1" }),
      });

      expect(res.status).toBe(200);
      expect(mocks.nodeHistoryService.recordUpload).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnailUrl: undefined }),
      );
      const activity = vi.mocked(recordProjectActivity).mock.calls[0]![0];
      expect("thumbnailUrl" in activity.payload).toBe(false);
    });

    // A report that CLAIMS a cover is an atomic video upload (#1816): the client
    // registers the cover FIRST and awaits it, so by the time the video report
    // arrives its row exists. Failing to read it back therefore means data
    // trouble, not "this video has no cover" — and letting it through would land
    // exactly the state #1816 forbids (a video without its cover). Both
    // unresolvable outcomes are fail-closed, like every other failure on this
    // endpoint (zero exceptions, user 2026-07-26). The client re-reports; the
    // cover row is already committed, so the retry resolves it.
    it("resolves the cover in the GRANT's studio, never one derived from the client's project_id (Gate-2 R9)", async () => {
      // H7 taught that the report's project_id is client input and a member of
      // two studios can point it at the other one. The video's own attribution
      // was fixed to read the grant's studio; the COVER lookup still derived
      // its studio from that same untrusted project_id, so one report resolved
      // its two halves against two different studios. Same authority for both.
      const GRANT_STUDIO = "s0000000-0000-4000-8000-00000000beef";
      mocks.assetUploadService.resolveGrantForReport.mockResolvedValue(GRANT_STUDIO);
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: VIDEO_KEY,
          hash: "a".repeat(64),
          kind: "video",
          node_id: "node-1",
          cover_hash: COVER_HASH,
        }),
      });

      expect(res.status).toBe(200);
      expect(mocks.assetUploadService.verifyDedupUpload).toHaveBeenCalledWith(
        expect.objectContaining({ studioId: GRANT_STUDIO, contentHash: COVER_HASH }),
      );
    });

    it("a claimed cover that does not resolve (verifyDedupUpload → null) FAILS the video report (422, zero exceptions)", async () => {
      mocks.assetUploadService.verifyDedupUpload.mockResolvedValue(null);
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: VIDEO_KEY,
          hash: "a".repeat(64),
          kind: "video",
          node_id: "node-1",
          cover_hash: COVER_HASH,
        }),
      });

      expect(res.status).toBe(422);
      // Nothing pinned, nothing announced — the client retries the whole report.
      expect(mocks.nodeHistoryService.recordUpload).not.toHaveBeenCalled();
      expect(vi.mocked(recordProjectActivity)).not.toHaveBeenCalled();
    });

    it("a cover-hash lookup that THROWS (DB blip) FAILS the video report (422) and logs the cause", async () => {
      // verifyDedupUpload is not total (a DB
      // connection blip on findByStudioAndHash can throw). #1824's "a cover
      // failure never fails the video" governs the WORKER path — an
      // already-billed AI video whose cover is genuinely auxiliary — and that
      // path never reaches this endpoint.
      mocks.assetUploadService.verifyDedupUpload.mockRejectedValue(new Error("db blip"));
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: VIDEO_KEY,
          hash: "a".repeat(64),
          kind: "video",
          node_id: "node-1",
          cover_hash: COVER_HASH,
        }),
      });
      expect(res.status).toBe(422);
      expect(mocks.nodeHistoryService.recordUpload).not.toHaveBeenCalled();
      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "cover_resolve_failed",
      );
    });

    it("a dedup-loser that could not be queued for reclaim still succeeds, but the swallowed sentinel is LOGGED", async () => {
      // The library layer cannot log (@domain/CLAUDE.md), so register() reports
      // a failed reclaim-queue insert as a `reclaimQueueFailed` sentinel. If the
      // application layer drops it, a redundant object silently never reaches
      // the offline job's work list — the exact silent failure the mandate bans.
      mocks.assetService.register.mockResolvedValue({
        asset: { storageKey: "video/2026-07-25/winner.mp4" },
        deduped: true,
        reclaimQueueFailed: true,
      });
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: VIDEO_KEY,
          hash: "a".repeat(64),
          kind: "video",
          node_id: "node-1",
        }),
      });

      // The registration itself succeeded — this must NOT fail the upload.
      expect(res.status).toBe(200);
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: VIDEO_KEY }),
        "asset_reclaim_queue_failed",
      );
    });

    it("the activity feed carries the AUTHORITATIVE kind, not the client's declared one (Gate-2 R9)", async () => {
      // The ledger row records detectKind(sniffed mime); the feed row used to
      // record `body.kind`, which is client input the server never verifies.
      // One asset would then carry two contradictory kinds — and the feed's is
      // the one a human reads. §4.2's rule is that type comes from what was
      // STORED, and it cannot hold for one sink and not the other.
      mocks.getStorageAdapter.mockResolvedValue({
        head: vi.fn().mockResolvedValue({
          exists: true,
          contentType: "video/mp4",
          size: 100,
        }),
        publicUrl: (k: string) => `https://cdn/${k}`,
      });
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: VIDEO_KEY,
          hash: "a".repeat(64),
          // The client LIES about the kind; the bytes sniff as video/mp4.
          kind: "image",
          node_id: "node-1",
        }),
      });

      expect(res.status).toBe(200);
      const activity = vi.mocked(recordProjectActivity).mock.calls[0]![0];
      expect(activity.payload).toMatchObject({ kind: "video" });
    });

    it("a DERIVED byproduct (derived:true) registers but emits NO activity feed row", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: PROJ, key: COVER_KEY, hash: "a".repeat(64), kind: "image", derived: true }),
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
        body: JSON.stringify({ project_id: PROJ, key: COVER_KEY, hash: "a".repeat(64), kind: "image" }),
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(recordProjectActivity)).toHaveBeenCalledOnce();
    });

    it("a fully-deduped video + cover resolve WITHOUT the storage adapter — the cover is DB-only (verifyDedupUpload), not adapter-coupled (Gate-2 R3)", async () => {
      mocks.getStorageAdapter.mockReset();
      mocks.getStorageAdapter.mockRejectedValue(new Error("adapter down"));
      const VIDEO_HASH = "a".repeat(64);
      mocks.assetUploadService.verifyDedupUpload.mockImplementation(
        async ({ contentHash }: { contentHash: string }) => {
          if (contentHash === VIDEO_HASH)
            return { fileUrl: "https://cdn/v.mp4", storageKey: "video/2026-07-25/v.mp4", kind: "video" };
          if (contentHash === COVER_HASH)
            return { fileUrl: COVER_URL, storageKey: COVER_KEY, kind: "image" };
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
        expect.objectContaining({ thumbnailUrl: COVER_URL }),
      );
      // Both video + cover resolved from the DB; the adapter was never built.
      expect(mocks.getStorageAdapter).not.toHaveBeenCalled();
    });
  });

  describe("POST /assets/uploaded — authoritative size re-check (#1826 §4.2)", () => {
    const PROJ = "a0000000-0000-4000-8000-000000000001";

    afterEach(() => mocks.getStorageAdapter.mockReset());

    it("re-checks the head() size against the cap → 413 (a small-declared, big-stored upload)", async () => {
      // The declared size passed presign's UX gate, but the STORED object is
      // over the mocked cap (1024) — the authoritative head() size catches it.
      mocks.getStorageAdapter.mockResolvedValue({
        head: vi.fn().mockResolvedValue({ exists: true, contentType: "image/png", size: 2048 }),
        publicUrl: (k: string) => `https://cdn/${k}`,
      });
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: "image/2026-07-25/big.png",
          hash: "a".repeat(64),
          kind: "image",
        }),
      });
      expect(res.status).toBe(413);
    });

    // Gate-2 R4 H5: the #1825 fix sniffs the authoritative MIME from the bytes
    // (file-type recognises avif/heic/bmp/tiff/…), but a NARROW allow-list in
    // detectKind then dropped every modern format back to kind='file' — the
    // exact symptom #1825 exists to kill. The same narrow-allow-list trap
    // already bit us in #1824 (Firefox .ogv fell outside VIDEO_TYPES), so the
    // fix is a PREFIX rule, not more entries.
    it.each([
      ["image/avif", "image"],
      ["image/heic", "image"],
      ["image/bmp", "image"],
      ["image/tiff", "image"],
      ["image/jxl", "image"],
      ["video/ogg", "video"],
      ["video/x-msvideo", "video"],
      ["audio/webm", "audio"],
      ["audio/x-m4a", "audio"],
    ])("registers a sniffed %s as kind=%s, never 'file' (#1825 real fix)", async (mime, kind) => {
      mocks.getStorageAdapter.mockResolvedValue({
        head: vi.fn().mockResolvedValue({ exists: true, contentType: mime, size: 100 }),
        publicUrl: (k: string) => `https://cdn/${k}`,
      });
      mocks.assetService.register.mockResolvedValue({
        asset: { storageKey: "image/2026-07-25/modern.bin" },
        deduped: false,
      });
      const app = createApp();
      await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: "image/2026-07-25/modern.bin",
          hash: "a".repeat(64),
          kind: "image",
        }),
      });
      expect(mocks.assetService.register).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: mime, kind }),
      );
    });
  });

  describe("POST /assets/uploaded — node-bound register fail-closed + canonical pin (#1826 §0 rule 3 / 铁律 2)", () => {
    const PROJ = "a0000000-0000-4000-8000-000000000001";
    const KEY = "image/2026-07-25/asset.png";
    const HASH = "a".repeat(64);

    beforeEach(() => {
      mocks.getStorageAdapter.mockResolvedValue({
        head: vi.fn().mockResolvedValue({ exists: true, contentType: "image/png", size: 100 }),
        publicUrl: (k: string) => `https://cdn/${k}`,
      });
    });
    afterEach(() => {
      mocks.getStorageAdapter.mockReset();
      mocks.assetService.register.mockReset();
    });

    it("a report WITHOUT a hash is refused (no hash → no ledger row → an orphan the node would pin)", async () => {
      // User decision 2026-07-26: the content hash is the ticket. The client
      // refuses to upload without one, and the server enforces the same rule
      // independently — a client can always be bypassed. Registering is
      // impossible anyway (`studio_assets.content_hash` is NOT NULL), so
      // accepting a hashless report could only pin the node to an object with
      // no live row, i.e. an offline-GC orphan → 404.
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: PROJ, key: KEY, kind: "image" }),
      });
      expect(res.status).toBe(422);
      expect(mocks.assetService.register).not.toHaveBeenCalled();
      expect(mocks.assetUploadService.consumeUploadGrant).not.toHaveBeenCalled();
    });

    it("an activity-feed write failure does NOT fail an already-complete upload (best-effort audit sink)", async () => {
      // Gate-2 R4 H6: /uploaded is now LOAD-BEARING — it gates the node pin, so
      // anything it throws surfaces as "upload failed" + Retry. By then the
      // grant is consumed, the studio_assets row is written and the bytes are
      // stored: the upload FULLY succeeded. Letting the activity feed (a
      // flat-file ledger by design, v14 "流水账") fail it would make the user
      // re-upload the whole file for nothing. The node-history sink right above
      // already swallows its own failure — this one must match.
      mocks.assetService.register.mockResolvedValue({
        asset: { storageKey: KEY },
        deduped: false,
      });
      vi.mocked(recordProjectActivity).mockRejectedValueOnce(new Error("feed db blip"));
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: PROJ, key: KEY, hash: HASH, kind: "image" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { ok: boolean; fileUrl: string } };
      expect(body.data.ok).toBe(true);
      expect(body.data.fileUrl).toBe(`https://cdn/${KEY}`);
    });

    it("node-bound register FAILURE → 422 and the grant is NOT consumed (fail-closed, §0 rule 3)", async () => {
      // A primary node output whose ledger register throws must NOT be pinned to
      // an unregistered key (offline GC → 404). The route re-throws as 422 and
      // leaves the grant live for the client to retry.
      mocks.assetService.register.mockRejectedValue(new Error("no owner studio"));
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: PROJ, key: KEY, hash: HASH, kind: "image", node_id: "node-1" }),
      });
      expect(res.status).toBe(422);
      expect(mocks.assetUploadService.consumeUploadGrant).not.toHaveBeenCalled();
      expect(mocks.nodeHistoryService.recordUpload).not.toHaveBeenCalled();
    });

    it("a NODELESS upload (no node_id) still fail-closes — its URL is persisted somewhere too (§0 rule 3)", async () => {
      // Gate-2 R4 H3: the old gate keyed on `node_id`, treating "no node" as
      // "nothing pinned to it". That proxy is wrong — the crop path uploads
      // WITHOUT a node_id and pins the result into the panel's focusImages.
      // Every upload's URL gets persisted somewhere (that is why it was
      // uploaded), so the SAFE default is fail-closed — with NO exceptions,
      // the cover included (#1816 makes video+cover atomic; see the sibling
      // test below). The "cover degrades to Film" path belongs to the WORKER,
      // which never reaches this endpoint.
      mocks.assetService.register.mockRejectedValue(new Error("no owner studio"));
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: PROJ, key: KEY, hash: HASH, kind: "image" }),
      });
      expect(res.status).toBe(422);
      expect(mocks.assetUploadService.consumeUploadGrant).not.toHaveBeenCalled();
    });

    it("a CROP report (derived, no source) fail-closes → 422, so the client clears the pending rail entry (§0 rule 3)", async () => {
      // A crop is pinned into the panel node's focusImages and has NO degrade
      // path (unlike the cover's Film icon). Letting its register failure pass
      // as 200 pins an unregistered key the offline GC reclaims → the reference
      // thumbnail 404s. Failing the report routes the client through
      // runFocusCrop's onFailure → removePendingFocusUpload + toast.
      mocks.assetService.register.mockRejectedValue(new Error("db blip"));
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: KEY,
          hash: HASH,
          kind: "image",
          derived: true,
        }),
      });
      expect(res.status).toBe(422);
      expect(mocks.assetUploadService.consumeUploadGrant).not.toHaveBeenCalled();
    });

    it("a grant that vanished between the two lookups → 422, NEVER a fallback to the client's project (H8)", async () => {
      // Gate-2 R5: /uploaded used to look the grant up twice (authorise, then
      // read its studio) with a head() round-trip in between. A concurrent
      // report consuming the grant in that window made the SECOND lookup return
      // null, and the null silently fell back to resolveOwnerStudioId(the
      // CLIENT's project_id) — exactly the input H7 exists to distrust. Worse,
      // register runs BEFORE the consume, so the mis-attributed row was already
      // committed (and runtime never deletes rows) when the consume then 422'd.
      // Attribution must fail closed instead.
      mocks.assetUploadService.authorizeUploadWrite.mockResolvedValue(true);
      mocks.assetUploadService.resolveGrantForReport.mockResolvedValue(null);
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: PROJ, key: KEY, hash: HASH, kind: "image" }),
      });
      expect(res.status).toBe(422);
      // Nothing was written, so nothing has to be cleaned up afterwards.
      expect(mocks.assetService.register).not.toHaveBeenCalled();
      expect(mocks.assetUploadService.consumeUploadGrant).not.toHaveBeenCalled();
    });

    it("a COVER report fail-closes too — an upload has NO exceptions (user 2026-07-26)", async () => {
      // Earlier this endpoint let a cover through on a register failure, on the
      // grounds that an unresolvable cover degrades to a Film icon (#1824). That
      // reasoning belongs to the WORKER path (an AI-generated video whose cover
      // is auxiliary and which is already billed). On THIS path the cover is one
      // half of a user's video upload: #1816 made the two atomic — "a video
      // never lands without its cover and a cover never lands without its
      // video" — so a cover that cannot be registered fails the upload just
      // like a cover that could not be PUT. No exceptions on the upload path.
      mocks.assetService.register.mockRejectedValue(new Error("no owner studio"));
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: PROJ,
          key: KEY,
          hash: HASH,
          kind: "image",
          node_id: "node-1",
          derived: true,
          source: "cover",
        }),
      });
      expect(res.status).toBe(422);
      expect(mocks.assetUploadService.consumeUploadGrant).not.toHaveBeenCalled();
    });

    it("pins the REGISTERED row's canonical, not body.key — a concurrent-dedup hit returns the winner's key (铁律 2)", async () => {
      // register() ON CONFLICT dedups to the winner's row (storageKey WINNER),
      // not this caller's body.key (LOSER). The node must pin the winner's
      // canonical, else body.key is an orphan (no live row) → offline GC → 404.
      const WINNER = "image/2026-07-25/winner.png";
      mocks.assetService.register.mockResolvedValue({
        asset: { storageKey: WINNER, fileUrl: `https://cdn/${WINNER}` },
        deduped: true,
      });
      const app = createApp();
      const res = await app.request("/api/v1/assets/uploaded", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: PROJ, key: KEY, hash: HASH, kind: "image", node_id: "node-1" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { fileUrl: string } };
      expect(body.data.fileUrl).toBe(`https://cdn/${WINNER}`);
      expect(body.data.fileUrl).not.toBe(`https://cdn/${KEY}`);
      // The node-history row pins the winner's canonical, not the loser's key.
      expect(mocks.nodeHistoryService.recordUpload).toHaveBeenCalledWith(
        expect.objectContaining({ content: `https://cdn/${WINNER}` }),
      );
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
