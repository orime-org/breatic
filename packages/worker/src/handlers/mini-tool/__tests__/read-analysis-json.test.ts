// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as domainModule from "@breatic/domain";
import type * as sharedModule from "@breatic/shared";
import type { StudioAssetEntity } from "@breatic/shared";

const h = vi.hoisted(() => ({ find: vi.fn(), request: vi.fn(), now: 1792920000000 }));
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, assetRepo: { ...actual.assetRepo, findById: h.find } };
});
vi.mock("@breatic/shared", async (original) => ({ ...await original<typeof sharedModule>(), httpRequest: h.request }));

import { BodyTooLarge, DeadlinePassed, EmptyBody } from "@breatic/shared";
import { readMiniToolAnalysisJson } from "../read-analysis-json.js";

const payload = { schemaVersion: 1, kind: "people", anchor: { frameIndex: 1, pts: 0.25 }, width: 400, height: 200, candidates: [] };
const body = JSON.stringify(payload);
const asset: StudioAssetEntity = {
  id: "10000000-0000-4000-8000-000000000001", studioId: "20000000-0000-4000-8000-000000000001",
  contentHash: "b".repeat(64), storageKey: "original-winner/people.txt", fileUrl: "https://assets.test.invalid/original-winner/people.txt",
  sizeBytes: new TextEncoder().encode(body).byteLength, mimeType: "text/plain", kind: "document", source: "upload",
  producedByUserId: "30000000-0000-4000-8000-000000000001", generationTaskId: null,
  width: null, height: null, durationSeconds: null, createdAt: new Date("2026-10-24T00:00:00Z"), deletedAt: null,
};
const deadlineAt = h.now + 30000;

beforeEach(() => {
  vi.resetAllMocks(); h.now = deadlineAt - 30000;
  vi.spyOn(Date, "now").mockImplementation(() => h.now);
  h.find.mockResolvedValue(asset);
  h.request.mockImplementation(async () => new Response(body, { headers: { "content-type": "text/plain" } }));
});
afterEach(() => vi.restoreAllMocks());

describe("registered analysis JSON delivery", () => {
  it("reads the canonical winner and preserves measured MIME, hash and deduplicated ownership", async () => {
    expect(await readMiniToolAnalysisJson(asset.id, deadlineAt)).toEqual({ asset, json: payload });
    expect(h.find).toHaveBeenCalledExactlyOnceWith(asset.id);
    expect(h.request).toHaveBeenCalledExactlyOnceWith(asset.fileUrl, { method: "GET" },
      expect.objectContaining({ replaySafe: true, timeoutMs: 30000, signal: expect.any(AbortSignal) }));
  });

  it.each([null, { ...asset, deletedAt: new Date("2026-10-25T00:00:00Z") }])("refuses an unavailable registration before HTTP", async (row) => {
    h.find.mockResolvedValue(row);
    await expect(readMiniToolAnalysisJson(asset.id, deadlineAt)).rejects.toThrow("Registered analysis artifact is unavailable");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("preserves the original repository failure", async () => {
    const error = new Error("asset repository unavailable"); h.find.mockRejectedValue(error);
    await expect(readMiniToolAnalysisJson(asset.id, deadlineAt)).rejects.toBe(error);
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each([400, 404, 429, 503])("preserves HTTP %s as a delivery failure", async (status) => {
    h.request.mockResolvedValue(new Response("unavailable", { status }));
    await expect(readMiniToolAnalysisJson(asset.id, deadlineAt)).rejects.toMatchObject({ name: "MiniToolStepFailed", code: `analysis_artifact_http_${status}` });
  });

  it("preserves the original transport failure", async () => {
    const error = new TypeError("connection dropped"); h.request.mockRejectedValue(error);
    await expect(readMiniToolAnalysisJson(asset.id, deadlineAt)).rejects.toBe(error);
  });

  it.each([null, ""])("rejects an empty body rather than publishing empty detections", async (empty) => {
    h.request.mockResolvedValue(new Response(empty));
    await expect(readMiniToolAnalysisJson(asset.id, deadlineAt)).rejects.toBeInstanceOf(EmptyBody);
  });

  it("enforces the registered measured byte ceiling while consuming a stream", async () => {
    h.find.mockResolvedValue({ ...asset, sizeBytes: 2 });
    const cancelled = vi.fn();
    h.request.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(body)); }, cancel: cancelled,
    })));
    await expect(readMiniToolAnalysisJson(asset.id, deadlineAt)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it.each(["{", " ", "<html>unavailable</html>"])("preserves invalid JSON as a content failure: %s", async (invalid) => {
    h.request.mockResolvedValue(new Response(invalid));
    await expect(readMiniToolAnalysisJson(asset.id, deadlineAt)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("preserves an interrupted response body", async () => {
    const error = new TypeError("terminated");
    h.request.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(error); } })));
    await expect(readMiniToolAnalysisJson(asset.id, deadlineAt)).rejects.toBe(error);
  });

  it("refuses a read at the original deadline before repository and HTTP work", async () => {
    h.now = deadlineAt;
    await expect(readMiniToolAnalysisJson(asset.id, deadlineAt)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.find).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
  });

  it("counts repository time against the original HTTP budget", async () => {
    h.find.mockImplementation(async () => { h.now += 1250; return asset; });
    expect(await readMiniToolAnalysisJson(asset.id, deadlineAt)).toEqual({ asset, json: payload });
    expect(h.request.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 28750 });
  });

  it("does not start HTTP when the repository returns after the original deadline", async () => {
    h.find.mockImplementation(async () => { h.now = deadlineAt; return asset; });
    await expect(readMiniToolAnalysisJson(asset.id, deadlineAt)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("does not renew the task budget when headers arrive at its deadline", async () => {
    h.request.mockImplementation(async () => { h.now = deadlineAt; return new Response(body); });
    await expect(readMiniToolAnalysisJson(asset.id, deadlineAt)).rejects.toBeInstanceOf(DeadlinePassed);
  });

  it("preserves JSON values without imposing the later operation's schema", async () => {
    await fc.assert(fc.asyncProperty(fc.json(), async (text) => {
      const json: unknown = JSON.parse(text);
      const row = { ...asset, sizeBytes: new TextEncoder().encode(text).byteLength };
      h.find.mockResolvedValue(row); h.request.mockResolvedValue(new Response(text));
      expect(await readMiniToolAnalysisJson(asset.id, deadlineAt)).toEqual({ asset: row, json });
    }));
  });

});
