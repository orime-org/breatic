// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as sharedModule from "@breatic/shared";

const httpRequestMock = vi.fn();
vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return { ...actual, httpRequest: (...args: unknown[]) => httpRequestMock(...args) };
});

const policy = { override: "auto" as const, timeoutMs: 1000, ttlMs: 300_000, retryMs: 30_000 };

/** A catalog with one vision model and one text-only model. */
function catalog(vision = true): Response {
  return new Response(JSON.stringify({ data: [
    { id: "vendor/vision", architecture: { input_modalities: vision ? ["text", "image"] : ["text"] } },
    { id: "vendor/text", architecture: { input_modalities: ["text"] } },
  ] }), { headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  httpRequestMock.mockReset().mockImplementation(async () => catalog());
});
afterEach(() => { vi.useRealTimers(); });

describe("model picture capability", () => {
  it.each([["yes", true], ["no", false]] as const)("respects %s without querying the model catalog", async (override, expected) => {
    const { resolveModelPictureCapability } = await import("@domain/agent/model-picture-capability.js");
    expect(await resolveModelPictureCapability("vendor/missing", { ...policy, override })).toBe(expected);
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("uses input modalities and shares one successful catalog across model IDs", async () => {
    const { resolveModelPictureCapability } = await import("@domain/agent/model-picture-capability.js");
    expect(await resolveModelPictureCapability("vendor/vision", policy)).toBe(true);
    expect(await resolveModelPictureCapability("vendor/text", policy)).toBe(false);
    expect(await resolveModelPictureCapability("vendor/unknown", policy)).toBe(false);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the last successful catalog when refresh fails and retries after the cooldown", async () => {
    const { resolveModelPictureCapability } = await import("@domain/agent/model-picture-capability.js");
    expect(await resolveModelPictureCapability("vendor/vision", policy)).toBe(true);
    vi.advanceTimersByTime(policy.ttlMs + 1);
    httpRequestMock.mockRejectedValueOnce(new Error("catalog temporarily unavailable"));
    expect(await resolveModelPictureCapability("vendor/vision", policy)).toBe(true);
    expect(await resolveModelPictureCapability("vendor/vision", policy)).toBe(true);
    expect(httpRequestMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(policy.retryMs + 1);
    httpRequestMock.mockResolvedValueOnce(catalog(false));
    expect(await resolveModelPictureCapability("vendor/vision", policy)).toBe(false);
    expect(httpRequestMock).toHaveBeenCalledTimes(3);
  });

  it("uses false on the first failure and suppresses repeated failed lookups until retry", async () => {
    const { resolveModelPictureCapability } = await import("@domain/agent/model-picture-capability.js");
    httpRequestMock.mockRejectedValueOnce(new Error("catalog down"));
    expect(await resolveModelPictureCapability("vendor/vision", policy)).toBe(false);
    expect(await resolveModelPictureCapability("vendor/vision", policy)).toBe(false);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(policy.retryMs + 1);
    expect(await resolveModelPictureCapability("vendor/vision", policy)).toBe(true);
    expect(httpRequestMock).toHaveBeenCalledTimes(2);
  });

  it("shares one pending refresh between concurrent waiters", async () => {
    const { resolveModelPictureCapability } = await import("@domain/agent/model-picture-capability.js");
    let release: ((response: Response) => void) | undefined;
    httpRequestMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const first = resolveModelPictureCapability("vendor/vision", policy);
    const second = resolveModelPictureCapability("vendor/text", policy);
    await Promise.resolve();
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    if (!release) throw new Error("catalog request did not start");
    release(catalog());
    expect(await Promise.all([first, second])).toEqual([true, false]);
  });

  it("cancels only one waiter and allows the shared query to populate the cache", async () => {
    const { resolveModelPictureCapability } = await import("@domain/agent/model-picture-capability.js");
    let release: ((response: Response) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    httpRequestMock.mockImplementationOnce((_url: unknown, init: RequestInit, options?: { signal?: AbortSignal }) => {
      requestSignal = options?.signal ?? init.signal ?? undefined;
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    const controller = new AbortController();
    const first = resolveModelPictureCapability("vendor/vision", policy, controller.signal);
    const stopped = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = resolveModelPictureCapability("vendor/vision", policy);
    controller.abort();
    await stopped;
    expect(requestSignal?.aborted ?? false).toBe(false);
    if (!release) throw new Error("catalog request did not start");
    release(catalog());
    expect(await second).toBe(true);
    expect(await resolveModelPictureCapability("vendor/vision", policy)).toBe(true);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("times out a hung catalog request and enters the failure cooldown", async () => {
    const { resolveModelPictureCapability } = await import("@domain/agent/model-picture-capability.js");
    httpRequestMock.mockImplementationOnce((_url: unknown, _init: RequestInit, options: { timeoutMs: number }) => new Promise<Response>((_resolve, reject) => {
      setTimeout(() => reject(new DOMException("Catalog deadline", "TimeoutError")), options.timeoutMs);
    }));
    const pending = resolveModelPictureCapability("vendor/vision", policy);
    await vi.advanceTimersByTimeAsync(policy.timeoutMs + 1);
    expect(await pending).toBe(false);
    expect(await resolveModelPictureCapability("vendor/vision", policy)).toBe(false);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: policy.timeoutMs });
  });

  it("does not interpret malformed input modalities as image support", async () => {
    const { resolveModelPictureCapability } = await import("@domain/agent/model-picture-capability.js");
    httpRequestMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "vendor/vision", architecture: { input_modalities: "image" } }] })));
    expect(await resolveModelPictureCapability("vendor/vision", policy)).toBe(false);
  });
});
