// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentPicturePreparer } from "@domain/agent/prepare-agent-pictures.js";

const spec = { version: 1 as const, longEdge: 1024, quality: 85 };
const source = { label: "Photo", sourceUrl: "https://example.com/photo.bin" };
const canonical = { storageKey: "studio/winner.png", contentType: "image/png" };
const picture = { url: "https://storage.example.com/studio/winner.png.agent-v1-1024-q85.jpg", sizeBytes: 3456, mediaType: "image/jpeg" as const };
const resolveSource = vi.fn();
const readPicture = vi.fn();

beforeEach(() => {
  resolveSource.mockReset().mockResolvedValue(canonical);
  readPicture.mockReset().mockResolvedValue(picture);
});

describe("per-turn agent picture preparation", () => {
  it("uses the registered canonical source and retains each label and original URL", async () => {
    const prepare = createAgentPicturePreparer({ spec, concurrency: 4, resolveSource, readPicture });
    expect(await prepare([source])).toEqual([{ status: "ready", ...source, ...picture }]);
    expect(resolveSource.mock.calls[0]?.[0]).toEqual(source);
    expect(readPicture.mock.calls[0]?.slice(0, 2)).toEqual([canonical, spec]);
  });

  it("shares preparation by source and spec while retaining repeated occurrence labels", async () => {
    const prepare = createAgentPicturePreparer({ spec, concurrency: 4, resolveSource, readPicture });
    const second = { ...source, label: "Second occurrence" };
    expect(await prepare([source, second])).toEqual([
      { status: "ready", ...source, ...picture },
      { status: "ready", ...second, ...picture },
    ]);
    expect(await prepare([source])).toEqual([{ status: "ready", ...source, ...picture }]);
    expect(resolveSource).toHaveBeenCalledTimes(1);
    expect(readPicture).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight preparation across concurrent batches", async () => {
    let release: ((value: typeof picture) => void) | undefined;
    readPicture.mockImplementationOnce(() => new Promise<typeof picture>((resolve) => { release = resolve; }));
    const prepare = createAgentPicturePreparer({ spec, concurrency: 4, resolveSource, readPicture });
    const first = prepare([source]);
    const second = prepare([{ ...source, label: "Again" }]);
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(resolveSource).toHaveBeenCalledTimes(1);
    expect(readPicture).toHaveBeenCalledTimes(1);
    if (!release) throw new Error("JPEG request did not start");
    release(picture);
    expect(await first).toEqual([{ status: "ready", ...source, ...picture }]);
    expect(await second).toEqual([{ status: "ready", ...source, label: "Again", ...picture }]);
  });

  it("retains typed source unavailability and performs no JPEG IO", async () => {
    resolveSource.mockResolvedValueOnce({ status: "unavailable", reason: "source-not-found" });
    const prepare = createAgentPicturePreparer({ spec, concurrency: 4, resolveSource, readPicture });
    expect(await prepare([source])).toEqual([{ status: "unavailable", ...source, reason: "source-not-found" }]);
    expect(readPicture).not.toHaveBeenCalled();
  });

  it("retains typed JPEG unavailability with the original source", async () => {
    readPicture.mockResolvedValueOnce({ status: "unavailable", reason: "unsupported-image" });
    const prepare = createAgentPicturePreparer({ spec, concurrency: 4, resolveSource, readPicture });
    expect(await prepare([source])).toEqual([{ status: "unavailable", ...source, reason: "unsupported-image" }]);
  });

  it("retries an unavailable source only when a new turn creates a preparer", async () => {
    resolveSource.mockResolvedValueOnce({ status: "unavailable", reason: "source-not-found" });
    const prepare = createAgentPicturePreparer({ spec, concurrency: 4, resolveSource, readPicture });
    expect(await prepare([source])).toEqual([{ status: "unavailable", ...source, reason: "source-not-found" }]);
    expect(await prepare([source])).toEqual([{ status: "unavailable", ...source, reason: "source-not-found" }]);
    const next = createAgentPicturePreparer({ spec, concurrency: 4, resolveSource, readPicture });
    expect(await next([source])).toEqual([{ status: "ready", ...source, ...picture }]);
    expect(resolveSource).toHaveBeenCalledTimes(2);
  });

  it("throws source infrastructure errors instead of downgrading them to missing pictures", async () => {
    const failure = new Error("asset repository unavailable");
    resolveSource.mockRejectedValueOnce(failure);
    const prepare = createAgentPicturePreparer({ spec, concurrency: 4, resolveSource, readPicture });
    await expect(prepare([source])).rejects.toBe(failure);
    expect(readPicture).not.toHaveBeenCalled();
  });

  it("throws JPEG infrastructure errors instead of downgrading them to missing pictures", async () => {
    const failure = new Error("ingest unavailable");
    readPicture.mockRejectedValueOnce(failure);
    const prepare = createAgentPicturePreparer({ spec, concurrency: 4, resolveSource, readPicture });
    await expect(prepare([source])).rejects.toBe(failure);
  });

  it("bounds concurrent preparations and returns input order despite out-of-order completion", async () => {
    const pending = new Map<string, (value: typeof picture) => void>();
    let active = 0;
    let peak = 0;
    resolveSource.mockImplementation(async (item: typeof source) => ({ storageKey: item.label, contentType: "image/png" }));
    readPicture.mockImplementation(async (item: typeof canonical) => {
      active += 1;
      peak = Math.max(peak, active);
      const result = await new Promise<typeof picture>((resolve) => { pending.set(item.storageKey, resolve); });
      active -= 1;
      return result;
    });
    const sources = Array.from({ length: 5 }, (_unused, index) => ({ label: String(index), sourceUrl: `https://example.com/${index}.png` }));
    const prepare = createAgentPicturePreparer({ spec, concurrency: 2, resolveSource, readPicture });
    const result = prepare(sources);
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect([...pending.keys()]).toEqual(["0", "1"]);
    pending.get("1")?.({ ...picture, sizeBytes: 1 });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect([...pending.keys()]).toEqual(["0", "1", "2"]);
    pending.get("2")?.({ ...picture, sizeBytes: 2 });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    pending.get("3")?.({ ...picture, sizeBytes: 3 });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    pending.get("4")?.({ ...picture, sizeBytes: 4 });
    pending.get("0")?.({ ...picture, sizeBytes: 5 });
    expect(await result).toEqual(sources.map((item, index) => ({ status: "ready", ...item, ...picture, sizeBytes: index === 0 ? 5 : index })));
    expect(peak).toBe(2);
  });

  it("does no source work after an already-stopped turn", async () => {
    const prepare = createAgentPicturePreparer({ spec, concurrency: 4, resolveSource, readPicture });
    await expect(prepare([source], AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(resolveSource).not.toHaveBeenCalled();
    expect(readPicture).not.toHaveBeenCalled();
  });

  it("stops waiting and never accepts a late JPEG result", async () => {
    let release: ((value: typeof picture) => void) | undefined;
    readPicture.mockImplementationOnce(() => new Promise<typeof picture>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const prepare = createAgentPicturePreparer({ spec, concurrency: 1, resolveSource, readPicture });
    const result = prepare([source, { ...source, sourceUrl: "https://example.com/other.png" }], controller.signal);
    const stopped = expect(result).rejects.toMatchObject({ name: "AbortError" });
    for (let index = 0; index < 5; index++) await Promise.resolve();
    controller.abort();
    await stopped;
    if (!release) throw new Error("JPEG request did not start");
    release(picture);
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(resolveSource).toHaveBeenCalledTimes(1);
    expect(readPicture).toHaveBeenCalledTimes(1);
    expect(resolveSource.mock.calls[0]?.[1]).toBe(controller.signal);
    expect(readPicture.mock.calls[0]?.[2]).toBe(controller.signal);
  });
});
