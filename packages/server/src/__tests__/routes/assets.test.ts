// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Assets route tests — the two endpoints that answer a browser directly.
 *
 * The upload ticket and the ingest report are exercised against a real
 * database and a real Hono app in `__tests__/integration/`, because what they
 * are for is the row they leave behind and the ticket the Worker verifies —
 * neither of which a mocked service layer can show.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as LimitsModule from "@server/config/limits.js";
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

// The /deleted route imports recordProjectActivity DIRECT from the service
// module (not via the @server/modules barrel), so the barrel mock above does
// not intercept it — mock the module itself to assert the feed row.
vi.mock("@server/modules/activity/projectActivity.service.js", () => ({
  recordProjectActivity: vi.fn(),
}));

// The request-body limit the upload config reports. It differs from the
// shipped `request_body_max_bytes` so the test proves the endpoint reads the
// accessor, and it is large enough that the app-level body limit, which reads
// the same accessor, refuses nothing this file sends.
const REQUEST_BODY_MAX_BYTES = 3 * 1024 * 1024;
vi.mock("@server/config/limits.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LimitsModule>()),
  getRequestBodyMaxBytes: () => REQUEST_BODY_MAX_BYTES,
}));

import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const AUTH = { Cookie: "breatic_session=valid-token" };

describe("Assets routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectService.assertAccess.mockResolvedValue(undefined);
  });

  describe("GET /assets/upload-config (#1609 slice 2)", () => {
    it("requires auth", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/upload-config");

      expect(res.status).toBe(401);
    });

    it("returns the yaml upload knobs (camelCase wire shape)", async () => {
      mocks.getStorageAdapter.mockResolvedValue({
        publicUrl: (key: string) => `https://cdn.example/${key}`,
      });
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
          uploadIdleTimeoutMs: number;
          uploadStatusPollSeconds: number;
          assetUrlPrefix: string;
          maxRequestBodyBytes: number;
        };
      };
      expect(body.data).toEqual({
        maxUploadBytes: 1024,
        clientMaxAttempts: 2,
        clientRetryBaseDelayMs: 250,
        uploadIdleTimeoutMs: 45000,
        uploadStatusPollSeconds: 7,
        // What every stored object's public URL starts with: the document
        // body tells its own media from outside links by it (inner#1127 A18).
        assetUrlPrefix: "https://cdn.example/",
        // The largest body any API route reads directly; above it the browser
        // sends paste, snapshot and chat bodies as a transfer (inner#1006).
        maxRequestBodyBytes: REQUEST_BODY_MAX_BYTES,
      });
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
