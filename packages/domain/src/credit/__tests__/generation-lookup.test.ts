// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return { ...actual, httpRequest: (...args: unknown[]) => httpRequestMock(...args) };
});

import {
  generationIdOf,
  lookupGenerationCost,
  trackOpenGeneration,
} from "@domain/credit/generation-lookup.js";

beforeEach(() => {
  httpRequestMock.mockReset();
});

describe("reading the generation id off a raw chunk", () => {
  it("takes the id OpenRouter puts on every streamed chunk", () => {
    expect(generationIdOf({ id: "gen-123", choices: [] })).toBe("gen-123");
  });

  it("ignores anything that is not an OpenRouter chunk", () => {
    expect(generationIdOf(undefined)).toBeUndefined();
    expect(generationIdOf("gen-1")).toBeUndefined();
    expect(generationIdOf({ id: 7 })).toBeUndefined();
    expect(generationIdOf({ id: "chatcmpl-1" })).toBeUndefined();
  });
});

describe("tracking the model call that has not ended", () => {
  it("holds the id of a call that started and did not end", () => {
    const open = trackOpenGeneration();
    open.seen({ id: "gen-1" });
    open.seen({ id: "gen-1" });
    expect(open.pending()).toBe("gen-1");
  });

  it("lets go of a call once it ended", () => {
    const open = trackOpenGeneration();
    open.seen({ id: "gen-1" });
    open.ended("gen-1");
    expect(open.pending()).toBeUndefined();
  });

  // A slow reader of the stream receives the call's last raw chunk after the
  // call ended; that chunk must not open the call again.
  it("does not reopen a call whose last chunk arrives after it ended", () => {
    const open = trackOpenGeneration();
    open.seen({ id: "gen-1" });
    open.ended("gen-1");
    open.seen({ id: "gen-1" });
    expect(open.pending()).toBeUndefined();
  });

  it("holds the later call when an earlier one ended first", () => {
    const open = trackOpenGeneration();
    open.seen({ id: "gen-1" });
    open.ended("gen-1");
    open.seen({ id: "gen-2" });
    expect(open.pending()).toBe("gen-2");
  });
});

describe("asking OpenRouter what a generation cost", () => {
  it("reads total_cost off the answer", async () => {
    httpRequestMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "gen-1", total_cost: 0.0042 } }), { status: 200 }),
    );
    await expect(lookupGenerationCost("gen-1", "key")).resolves.toBe(0.0042);
    const [url, init] = httpRequestMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/generation?id=gen-1");
    expect(init.headers).toMatchObject({ Authorization: "Bearer key" });
  });

  it("answers undefined while the generation is not there yet", async () => {
    httpRequestMock.mockResolvedValue(new Response("{}", { status: 404 }));
    await expect(lookupGenerationCost("gen-1", "key")).resolves.toBeUndefined();
  });

  it("throws on any other refusal", async () => {
    httpRequestMock.mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(lookupGenerationCost("gen-1", "key")).rejects.toThrow("401");
  });
});
