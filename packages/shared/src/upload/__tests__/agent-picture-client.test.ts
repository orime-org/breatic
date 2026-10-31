// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { httpRequest } from "@shared/http/request.js";
import { readStoredMediaAtIngest } from "@shared/upload/ingest-client.js";

vi.mock("@shared/http/request.js", () => ({ httpRequest: vi.fn() }));
const request = vi.mocked(httpRequest);
const SPEC = { version: 1 as const, longEdge: 1024, quality: 85 };

/** A normal request with the existing two-hour media task budget. */
function about(): {
  storageKey: string;
  contentType: string;
  deadlineAt: number;
  agentPicture: typeof SPEC;
} {
  return {
    storageKey: "image/2026-10-22/123_registered.png",
    contentType: "image/png",
    deadlineAt: Date.now() + 7_200_000,
    agentPicture: SPEC,
  };
}

beforeEach(() => { request.mockReset(); });

describe("requesting an agent picture from ingest", () => {
  it.each(["generated", "existing"] as const)("retains measured JPEG facts for %s", async (outcome) => {
    const agentPicture = { outcome, sizeBytes: 182_432, mediaType: "image/jpeg" };
    request.mockResolvedValueOnce(Response.json({ width: 3000, height: 2000, agentPicture }));
    const sent = about();

    const result = await readStoredMediaAtIngest("https://ingest.example.com", "test-secret", sent);

    expect(result).toEqual({ width: 3000, height: 2000, durationSeconds: null, agentPicture });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual(sent);
    expect(request.mock.calls[0]?.[0]).toBe("https://ingest.example.com/media");
    expect(request.mock.calls[0]?.[2]?.replaySafe).toBe(true);
  });

  it.each(["none", "failed"] as const)("retains the %s outcome without inventing facts", async (outcome) => {
    request.mockResolvedValueOnce(Response.json({ agentPicture: { outcome } }));
    const result = await readStoredMediaAtIngest("https://ingest.example.com", "test-secret", about());
    expect(result).toEqual({ width: null, height: null, durationSeconds: null, agentPicture: { outcome } });
  });

  it("accepts old Worker replies without the optional agent picture field", async () => {
    request.mockResolvedValueOnce(Response.json({ width: 800, height: 450, preview: "existing" }));
    const result = await readStoredMediaAtIngest("https://ingest.example.com", "test-secret", about());
    expect(result).toEqual({ width: 800, height: 450, durationSeconds: null, preview: "existing" });
  });

  it.each([
    { outcome: "generated", mediaType: "image/jpeg" },
    { outcome: "existing", sizeBytes: 0, mediaType: "image/jpeg" },
    { outcome: "existing", sizeBytes: -1, mediaType: "image/jpeg" },
    { outcome: "generated", sizeBytes: 1.5, mediaType: "image/jpeg" },
    { outcome: "generated", sizeBytes: 123, mediaType: "image/png" },
  ])("does not treat incomplete facts as a prepared picture: %o", async (agentPicture) => {
    request.mockResolvedValueOnce(Response.json({ agentPicture }));
    const result = await readStoredMediaAtIngest("https://ingest.example.com", "test-secret", about());
    expect(result.agentPicture).toEqual({ outcome: "failed" });
  });

  it("stops waiting on reader cancellation while preserving the original task deadline", async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    request.mockImplementationOnce((_url, _init, options) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => { reject(options.signal?.reason); }, { once: true });
      started?.();
    }));
    const sent = about();
    const stopped = new Error("reader stopped");
    const reading = readStoredMediaAtIngest("https://ingest.example.com", "test-secret", sent, controller.signal);
    const rejection = expect(reading).rejects.toBe(stopped);
    await waiting;

    controller.abort(stopped);

    await rejection;
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual(sent);
    expect(request.mock.calls[0]?.[2]?.timeoutMs).toBeGreaterThan(7_190_000);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
