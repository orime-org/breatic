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
        "/api/v1/assets/presign?filename=test.png&content_type=image/png&project_id=a0000000-0000-4000-8000-000000000001",
      );

      expect(res.status).toBe(401);
    });

    it("rejects missing params with 400", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/presign", { headers: AUTH });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /assets/history", () => {
    it("requires auth", async () => {
      const app = createApp();
      const res = await app.request("/api/v1/assets/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "upload",
          project_id: "a0000000-0000-4000-8000-000000000001",
          node_id: "node-1",
          content: "https://example.com/file.png",
          metadata: { filename: "file.png", size: 1024, mimeType: "image/png" },
        }),
      });

      expect(res.status).toBe(401);
    });
  });
});
