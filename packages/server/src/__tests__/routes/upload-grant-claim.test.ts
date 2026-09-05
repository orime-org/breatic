// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The permission the ingest Worker takes before it finishes an upload
 * (#186, design §6.4).
 *
 * The Worker holds no state, so it cannot know whether some other delivery is
 * already assembling this key — only the grant row knows. It asks here, and
 * what it gets back decides whether R2 is touched at all.
 *
 * There is no session on this route: our own Worker is the caller and the
 * shared secret is all it can prove. So the body carries the key and the
 * multipart upload id, and nothing that decides consequences — everything
 * else is read off the grant.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(),
  generateText: vi.fn(),
  stepCountIs: vi.fn(),
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

const SECRET = "test-ingest-secret";
const PATH = "/api/v1/assets/upload-grant/claim";
const KEY = "video/2026-09-05/1788000000000_abc.mp4";
const UPLOAD = "multipart-upload-a";

/**
 * Ask for the permission the way the Worker does.
 * @param over - What to send instead of the defaults.
 * @param over.secret - The shared secret header, omitted when null.
 * @param over.body - The JSON body.
 * @returns The server's response.
 */
async function ask(
  over: { secret?: string | null; body?: unknown } = {},
): Promise<Response> {
  const secret = over.secret === undefined ? SECRET : over.secret;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret !== null) headers["x-ingest-secret"] = secret;

  return createApp().request(PATH, {
    method: "POST",
    headers,
    body: JSON.stringify(
      over.body ?? { storage_key: KEY, upload_id: UPLOAD },
    ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ingestReportService.claimFinalize.mockResolvedValue({ granted: true });
});

describe("POST /assets/upload-grant/claim", () => {
  it("refuses a caller who cannot prove it holds the shared secret", async () => {
    expect((await ask({ secret: null })).status).toBe(401);
    expect((await ask({ secret: "wrong" })).status).toBe(401);
    // The refusal comes before anything is decided, so the row is untouched.
    expect(mocks.ingestReportService.claimFinalize).not.toHaveBeenCalled();
  });

  it("grants the key to the upload that asked", async () => {
    const res = await ask();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { granted: true } });
    expect(mocks.ingestReportService.claimFinalize).toHaveBeenCalledWith({
      storageKey: KEY,
      uploadId: UPLOAD,
    });
  });

  it("passes the refusal reason through, so the Worker knows what to say", async () => {
    mocks.ingestReportService.claimFinalize.mockResolvedValue({
      granted: false,
      reason: "in_flight",
    });

    const res = await ask();

    // 200 with a verdict, not an error status: the Worker asked a question
    // and got an answer. Which answer decides what the browser is told.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { granted: false, reason: "in_flight" },
    });
  });

  it("says already_registered when the grant has been consumed", async () => {
    mocks.ingestReportService.claimFinalize.mockResolvedValue({
      granted: false,
      reason: "already_registered",
    });

    expect(await (await ask()).json()).toEqual({
      data: { granted: false, reason: "already_registered" },
    });
  });

  it("says no_grant for a key this ledger never issued", async () => {
    mocks.ingestReportService.claimFinalize.mockResolvedValue({
      granted: false,
      reason: "no_grant",
    });

    expect(await (await ask()).json()).toEqual({
      data: { granted: false, reason: "no_grant" },
    });
  });

  it("rejects a body missing the upload id before it reaches the ledger", async () => {
    const res = await ask({ body: { storage_key: KEY } });

    expect(res.status).toBe(422);
    expect(mocks.ingestReportService.claimFinalize).not.toHaveBeenCalled();
  });

  it("rejects a body missing the key", async () => {
    const res = await ask({ body: { upload_id: UPLOAD } });

    expect(res.status).toBe(422);
    expect(mocks.ingestReportService.claimFinalize).not.toHaveBeenCalled();
  });
});
