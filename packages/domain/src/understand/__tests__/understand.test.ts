// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What `understandMedia` hands provider, and what it makes of what comes back.
 *
 * How each upstream is sent the media is provider's, and its tests hold it.
 * What is held here is this layer's own job: every billed answer reported once
 * with the upstream that billed it, and a refusal judged into what it is about,
 * since that decides the sentence a user reads and whether a task is retried.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NoUpstreamAvailable, UnderstandInterrupted, UpstreamRequestRejected, type Cost } from "@breatic/provider";

const understand = vi.hoisted(() => vi.fn());

vi.mock("@domain/provider/instance.js", () => ({ provider: () => ({ llm: { understand } }) }));

import { understandMedia } from "@domain/understand/understand.js";
import { MediaUnavailable, UnderstandRefused, type Media } from "@domain/understand/types.js";

const KNOWN: Cost = { state: "known", usd: 0.004, source: "reported" };
const read = async (): Promise<Uint8Array> => new Uint8Array([1]);
const IMAGE: Media = { kind: "image", url: "https://media.example/a.png", contentType: "image/png", read };
const AUDIO: Media = { kind: "audio", bytes: new Uint8Array([2, 3]), contentType: "audio/mpeg" };

/** What the call says it was billed, per answer. */
const billed: Array<[Cost, string]> = [];

/** The inputs every test varies from. */
const base = {
  onBilled: (cost: Cost, upstream: string): void => void billed.push([cost, upstream]),
  question: "What is this?",
  model: "google/gemini-3.8-flash",
  maxOutputTokens: 2048,
  timeoutMs: 180_000,
};

/**
 * The refusal a call ends in.
 * @param run - The call.
 * @returns What it threw.
 */
async function thrown(run: Promise<unknown>): Promise<unknown> {
  return run.then(() => undefined, (err: unknown) => err);
}

beforeEach(() => {
  billed.length = 0;
  understand.mockReset();
  understand.mockResolvedValue({ text: "a puppy", finishReason: "stop", costs: [KNOWN], upstream: "openrouter" });
});

describe("understandMedia — what it hands provider", () => {
  it("sends the model, the question, each item and the call's budget as a deadline", async () => {
    const signal = new AbortController().signal;
    const before = Date.now();
    await understandMedia({ ...base, media: [IMAGE, AUDIO], signal });
    const [request] = understand.mock.calls[0] as [Record<string, unknown>];
    expect(request).toMatchObject({
      model: "google/gemini-3.8-flash",
      question: "What is this?",
      maxOutputTokens: 2048,
      signal,
      media: [
        { url: IMAGE.url, contentType: "image/png", read },
        { bytes: new Uint8Array([2, 3]), contentType: "audio/mpeg" },
      ],
    });
    expect(request.deadlineAt as number).toBeGreaterThanOrEqual(before + 180_000);
  });

  it("persists its send authority before the call goes out", async () => {
    const order: string[] = [];
    understand.mockImplementationOnce(async () => {
      order.push("understand");
      return { text: "", finishReason: "stop", costs: [], upstream: "google" };
    });
    await understandMedia({ ...base, media: [AUDIO], onRequestSending: async () => void order.push("sending") });
    expect(order).toEqual(["sending", "understand"]);
  });

  it("calls nothing for a request already stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(understandMedia({ ...base, media: [AUDIO], signal: stop.signal })).rejects.toThrow();
    expect(understand).not.toHaveBeenCalled();
  });
});

describe("understandMedia — what comes back", () => {
  it("returns the text with the reason the model stopped, and reports each billed answer with its upstream", async () => {
    const pending: Cost = { state: "pending", lookup: { upstream: "openrouter", generationId: "gen-1" } };
    understand.mockResolvedValueOnce({ text: "cut", finishReason: "length", costs: [KNOWN, pending], upstream: "openrouter" });
    expect(await understandMedia({ ...base, media: [AUDIO] })).toEqual({ text: "cut", finishReason: "length" });
    expect(billed).toEqual([[KNOWN, "openrouter"], [pending, "openrouter"]]);
  });

  it("reports what a refused call was billed, under the upstream that refused it", async () => {
    understand.mockRejectedValueOnce(new UpstreamRequestRejected("m", "openrouter", "refused", [KNOWN], { status: 403 }));
    await thrown(understandMedia({ ...base, media: [AUDIO] }));
    expect(billed).toEqual([[KNOWN, "openrouter"]]);
  });

  it("reports what an interrupted call was billed", async () => {
    understand.mockRejectedValueOnce(new UnderstandInterrupted("m", [KNOWN], new Error("deadline")));
    const err = await thrown(understandMedia({ ...base, media: [AUDIO] }));
    expect(err).toBeInstanceOf(UnderstandInterrupted);
    expect(billed).toEqual([[KNOWN, ""]]);
  });

  it("hands on the media failure an image's reader threw", async () => {
    const unavailable = new MediaUnavailable("slow", { detail: "too slow" });
    understand.mockRejectedValueOnce(new UnderstandInterrupted("m", [], unavailable));
    expect(await thrown(understandMedia({ ...base, media: [IMAGE] }))).toBe(unavailable);
  });

  it("rethrows the caller's stop rather than judging it", async () => {
    const stop = new AbortController();
    understand.mockImplementationOnce(async () => {
      stop.abort();
      throw new UnderstandInterrupted("m", [], new Error("aborted"));
    });
    const err = await thrown(understandMedia({ ...base, media: [AUDIO], signal: stop.signal }));
    expect(err).not.toBeInstanceOf(UnderstandRefused);
  });
});

describe("understandMedia — what a refusal is about", () => {
  it.each([
    [408, [AUDIO], "transient"],
    [429, [AUDIO], "transient"],
    [500, [AUDIO], "transient"],
    // An edge server's 5xx, whatever number it carries.
    [524, [AUDIO], "transient"],
    [413, [AUDIO], "media"],
    // Only an address-only batch says the address could not be fetched.
    [400, [IMAGE], "unfetchable"],
    [400, [IMAGE, AUDIO], "media"],
    [400, [AUDIO], "media"],
    // A refusal carried inside a 200 is the model declining the question.
    [200, [AUDIO], "content-filter"],
    // A 403 is the key or the budget: a content block says so on its own.
    [403, [AUDIO], "deployment"],
    [404, [AUDIO], "deployment"],
  ] as const)("calls a %s for %j %s", async (status, media, kind) => {
    understand.mockRejectedValueOnce(new UpstreamRequestRejected("m", "openrouter", "the words", [], { status }));
    const err = await thrown(understandMedia({ ...base, media: [...media] }));
    expect(err).toBeInstanceOf(UnderstandRefused);
    expect(err).toMatchObject({ status, kind, detail: "the words", blocked: false });
  });

  it("says when the upstream said it blocked the content", async () => {
    understand.mockRejectedValueOnce(new UpstreamRequestRejected("m", "openrouter", "blocked", [], { status: 403, reason: "content_blocked" }));
    expect(await thrown(understandMedia({ ...base, media: [AUDIO] }))).toMatchObject({ kind: "deployment", blocked: true });
  });

  it("calls a deployment with no upstream for the model a deployment matter", async () => {
    understand.mockRejectedValueOnce(new NoUpstreamAvailable("m", [{ upstream: "openrouter", kind: "missing_key", envVar: "OPENROUTER_API_KEY" }]));
    expect(await thrown(understandMedia({ ...base, media: [AUDIO] }))).toMatchObject({ kind: "deployment" });
  });

  it("calls a refusal with no upstream status a deployment matter", async () => {
    understand.mockRejectedValueOnce(new UpstreamRequestRejected("m", "", "no route serves m"));
    expect(await thrown(understandMedia({ ...base, media: [AUDIO] }))).toMatchObject({ kind: "deployment", status: 0 });
  });
});
