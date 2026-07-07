// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Assets route tests — presign + local upload + history.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

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
