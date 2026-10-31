// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";
import { fetchMedia } from "@domain/understand/fetch-media.js";

const httpRequestMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));
vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return { ...actual, httpRequest: (...args: unknown[]) => httpRequestMock(...args) };
});

const base = { maxBytes: 10, fetchTimeoutMs: 30_000, minBytesPerSec: 65_536, readFloorMs: 5_000 };

beforeEach(() => { httpRequestMock.mockReset(); });

describe("fetchMedia download remainder", () => {
  it("does not apply a zero AV remainder to an image settled by HEAD", async () => {
    httpRequestMock.mockResolvedValueOnce(new Response(null, { headers: { "content-type": "image/png", "content-length": "9" } }));
    expect(await fetchMedia({ ...base, url: "https://example.com/source.bin", remainingDownloadBytes: 0 })).toEqual({ kind: "image", url: "https://example.com/source.bin" });
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("retains the image's own single-item limit", async () => {
    httpRequestMock.mockResolvedValueOnce(new Response(null, { headers: { "content-type": "image/png", "content-length": "11" } }));
    await expect(fetchMedia({ ...base, url: "https://example.com/source.bin", remainingDownloadBytes: 0 })).rejects.toMatchObject({ kind: "too-large", bytes: 11, limit: 10 });
  });

  it("does not apply a zero AV remainder to an image settled by GET", async () => {
    httpRequestMock.mockResolvedValueOnce(new Response(null, { status: 405 })).mockResolvedValueOnce(new Response(new Uint8Array(9), { headers: { "content-type": "image/png", "content-length": "9" } }));
    expect(await fetchMedia({ ...base, url: "https://example.com/source.bin", remainingDownloadBytes: 0 })).toEqual({ kind: "image", url: "https://example.com/source.bin" });
    expect(httpRequestMock).toHaveBeenCalledTimes(2);
  });

  it.each(["audio/wav", "video/mp4"])("rejects %s from HEAD before fetching a body larger than the remainder", async (mediaType) => {
    httpRequestMock.mockResolvedValueOnce(new Response(null, { headers: { "content-type": mediaType, "content-length": "5" } }));
    await expect(fetchMedia({ ...base, url: "https://example.com/source.bin", remainingDownloadBytes: 4 })).rejects.toMatchObject({ kind: "too-large", bytes: 5, limit: 4 });
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it.each(["audio/wav", "video/mp4"])("refuses a zero remainder before GET when HEAD identifies %s without a length", async (mediaType) => {
    httpRequestMock
      .mockResolvedValueOnce(new Response(null, { headers: { "content-type": mediaType } }))
      .mockRejectedValueOnce(new Error("A zero download allowance must not start GET"));

    await expect(fetchMedia({ ...base, url: "https://example.com/source.bin", remainingDownloadBytes: 0 }))
      .rejects.toMatchObject({ name: "MediaUnavailable", kind: "too-large", limit: 0 });

    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it.each(["audio/wav", "video/mp4"])("cancels %s before pulling its unknown-length GET body when no AV allowance remains", async (mediaType) => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array([1]));
    });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { "content-type": mediaType },
    });
    httpRequestMock
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(response);

    await expect(fetchMedia({ ...base, url: "https://example.com/source.bin", remainingDownloadBytes: 0 }))
      .rejects.toMatchObject({ name: "MediaUnavailable", kind: "too-large", limit: 0 });

    expect(httpRequestMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
  });

  it("enforces the remainder when only GET states the AV type and size", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-type": "audio/wav", "content-length": "5" } });
    httpRequestMock.mockResolvedValueOnce(new Response(null, { status: 405 })).mockResolvedValueOnce(response);
    await expect(fetchMedia({ ...base, url: "https://example.com/source.bin", remainingDownloadBytes: 4 })).rejects.toMatchObject({ kind: "too-large", bytes: 5, limit: 4 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cuts off an unstated AV body at the remaining allowance", async () => {
    httpRequestMock.mockResolvedValueOnce(new Response(null, { headers: { "content-type": "audio/wav" } })).mockResolvedValueOnce(new Response(new Uint8Array(5), { headers: { "content-type": "audio/wav" } }));
    await expect(fetchMedia({ ...base, url: "https://example.com/source.bin", remainingDownloadBytes: 4 })).rejects.toMatchObject({ kind: "too-large", limit: 4 });
  });

  it("accepts an AV body exactly equal to the remaining allowance", async () => {
    httpRequestMock.mockResolvedValueOnce(new Response(null, { headers: { "content-type": "audio/wav", "content-length": "4" } })).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4])));
    expect(await fetchMedia({ ...base, url: "https://example.com/source.bin", remainingDownloadBytes: 4 })).toEqual({ kind: "audio", bytes: new Uint8Array([1, 2, 3, 4]), format: "wav" });
  });

  it("uses the single-item ceiling when it is smaller than the remaining allowance", async () => {
    httpRequestMock.mockResolvedValueOnce(new Response(null, { headers: { "content-type": "video/mp4", "content-length": "11" } }));
    await expect(fetchMedia({ ...base, url: "https://example.com/source.bin", remainingDownloadBytes: 20 })).rejects.toMatchObject({ kind: "too-large", bytes: 11, limit: 10 });
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });
});
