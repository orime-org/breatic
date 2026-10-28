// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderConfigError } from "../../config/schema.js";
import { UnderstandInterrupted, UpstreamRequestRejected } from "../../errors.js";
import type { Reply } from "../../media/__tests__/fake-upstream.js";
import { createProvider } from "../../provider.js";
import type { Provider } from "../../provider.js";
import { GENERATE_CONTENT_REPLY, llmConfig, llmProvider, posted, postedAt, startFakes, stopFakes, type LlmFakes } from "./llm-harness.js";

let fakes: LlmFakes;

beforeEach(async () => {
  fakes = await startFakes();
});

afterEach(async () => {
  await stopFakes(fakes);
});

const picture = { bytes: new Uint8Array(32), contentType: "image/png" };
const keys = { GOOGLE_API_KEY: "g", OPENROUTER_API_KEY: "or" };

/**
 * An understand request of the shipped understand model.
 * @param deadlineMs - How long from now the call may run.
 * @returns The request.
 */
const question = (deadlineMs = 60_000): Parameters<Provider["llm"]["understand"]>[0] => ({
  model: "google/gemini-3.8-flash",
  question: "What is in it?",
  media: [picture],
  maxOutputTokens: 200,
  deadlineAt: Date.now() + deadlineMs,
});

/**
 * The generateContent requests Google received.
 * @returns How many.
 */
const generated = (): number => fakes.google.seen.filter((s) => s.method === "POST" && s.path.endsWith(":generateContent")).length;

/**
 * Requests Google received of one method on paths containing a fragment.
 * @param method - The method.
 * @param fragment - Part of the path.
 * @returns How many.
 */
const seenOn = (method: string, fragment: string): number => fakes.google.seen.filter((s) => s.method === method && s.path.includes(fragment)).length;

/**
 * A provider whose Google requests always go through the Files API.
 * @param route - How Google answers.
 * @param llmMaxRetries - Retries on the same upstream.
 * @returns The provider.
 */
function throughFiles(route: (request: { method: string; path: string }) => Reply, llmMaxRetries = 0): Provider {
  const config = llmConfig(fakes);
  config.upstreams.google = { ...config.upstreams.google!, base_url: `${fakes.google.url}/v1beta` };
  config.llm!.gemini_inline_max_bytes = 8;
  config.llm!.gemini_file_poll_ms = 20;
  fakes.google.answer(route);
  return createProvider({ config, keyOf: (name) => (keys as Record<string, string>)[name], llmMaxRetries, cleanText: (t) => t });
}

const uploadSession = (): Reply => ({ status: 200, body: {}, headers: { "x-goog-upload-url": `${fakes.google.url}/upload-session/1` } });
const activeFile: Reply = { status: 200, body: { file: { name: "files/abc", uri: "https://files.example/abc", state: "ACTIVE" } } };

/**
 * Wait a while.
 * @param ms - How long.
 */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("understand retries (design 6.5, DD 27)", () => {
  it("leaves Google at once when it asks for more than a minute", async () => {
    fakes.google.answer(() => ({ status: 429, body: { error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }, headers: { "retry-after": "3600" } }));
    const answer = await llmProvider(fakes, keys, { llmMaxRetries: 2 }).llm.understand(question());
    expect(answer.upstream).toBe("openrouter");
    expect(generated()).toBe(1);
  });

  it("waits as long as Google asks before trying it again", async () => {
    let calls = 0;
    fakes.google.answer(() => (calls++ === 0
      ? { status: 503, body: { error: { code: 503, message: "busy", status: "UNAVAILABLE" } }, headers: { "retry-after": "2" } }
      : { status: 200, body: GENERATE_CONTENT_REPLY }));
    const answer = await llmProvider(fakes, keys, { llmMaxRetries: 2 }).llm.understand(question(), { mode: "upstream", upstream: "google" });
    expect(answer.upstream).toBe("google");
    const [first, second] = postedAt(fakes.google);
    expect(second! - first!).toBeGreaterThanOrEqual(1_900);
  });

  it("sends each attempt once, leaving retries to llmMaxRetries", async () => {
    fakes.google.answer(() => ({ status: 429, body: { error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } } }));
    const answer = await llmProvider(fakes, keys, { llmMaxRetries: 1 }).llm.understand(question());
    expect(answer.upstream).toBe("openrouter");
    expect(generated()).toBe(2);
  });
});

describe("understand answers that cannot be read (design 3.5, DD 27)", () => {
  it.each([
    ["the file ends FAILED", (r: { method: string; path: string }): Reply | undefined =>
      r.method === "GET" ? { status: 200, body: { name: "files/abc", state: "FAILED" } } : r.path === "/upload-session/1" ? { status: 200, body: { file: { name: "files/abc", state: "PROCESSING" } } } : undefined],
    ["the upload start names no session", (r: { method: string; path: string }): Reply | undefined =>
      r.path === "/upload/v1beta/files" ? { status: 200, body: {} } : undefined],
    ["the upload answers no file", (r: { method: string; path: string }): Reply | undefined =>
      r.path === "/upload-session/1" ? { status: 200, body: {} } : undefined],
    ["the file has no uri", (r: { method: string; path: string }): Reply | undefined =>
      r.path === "/upload-session/1" ? { status: 200, body: { file: { name: "files/abc", state: "ACTIVE" } } } : undefined],
    ["the upload start names a session that is not an address (DD 33)", (r: { method: string; path: string }): Reply | undefined =>
      r.path === "/upload/v1beta/files" ? { status: 200, body: {}, headers: { "x-goog-upload-url": "abc" } } : undefined],
    ["the upload start names an empty session (DD 33)", (r: { method: string; path: string }): Reply | undefined =>
      r.path === "/upload/v1beta/files" ? { status: 200, body: {}, headers: { "x-goog-upload-url": "" } } : undefined],
    ["the upload answers a file with an empty name (DD 33)", (r: { method: string; path: string }): Reply | undefined =>
      r.path === "/upload-session/1" ? { status: 200, body: { file: { name: "", state: "ACTIVE", uri: "https://files.example/abc" } } } : undefined],
    ["the upload answers a file name outside files/ (DD 33)", (r: { method: string; path: string }): Reply | undefined =>
      r.path === "/upload-session/1" ? { status: 200, body: { file: { name: "../models", state: "ACTIVE", uri: "https://files.example/abc" } } } : undefined],
  ])("rejects without a status or a cost when %s, sending no question", async (_name, special) => {
    const provider = throughFiles((r) => special(r) ?? (r.path === "/upload/v1beta/files" ? uploadSession() : r.method === "DELETE" ? { status: 200, body: {} } : activeFile));
    const error = await provider.llm.understand(question()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).upstream).toBe("google");
    expect((error as UpstreamRequestRejected).status).toBeUndefined();
    expect((error as UpstreamRequestRejected).costs).toEqual([]);
    expect(generated()).toBe(0);
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  it.each([
    ["OpenRouter's answer is not JSON", "openrouter", { status: 200, raw: "<html>gateway</html>", contentType: "text/html" }, { state: "missing" }],
    ["OpenRouter's answer has no choice", "openrouter", { status: 200, body: { id: "gen-1", choices: [], usage: { cost: 0.01 } } }, { state: "known", usd: 0.01 }],
    ["OpenRouter's choice is null", "openrouter", { status: 200, body: { id: "gen-3", choices: [null], usage: { cost: 0.02 } } }, { state: "known", usd: 0.02 }],
    ["OpenRouter's answer has no choice and no cost", "openrouter", { status: 200, body: { id: "gen-2", choices: [] } }, { state: "pending", lookup: { upstream: "openrouter", generationId: "gen-2" } }],
    ["Google's answer is not JSON", "google", { status: 200, raw: "<html>gateway</html>", contentType: "text/html" }, { state: "missing" }],
  ] as const)("rejects, costing the billed answer, when %s", async (_name, upstream, reply, cost) => {
    fakes[upstream].answer(() => reply);
    const error = await llmProvider(fakes, keys, { understandOpenRouterFirst: upstream === "openrouter" }).llm.understand(question()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).upstream).toBe(upstream);
    expect((error as UpstreamRequestRejected).status).toBeUndefined();
    expect((error as UpstreamRequestRejected).costs).toEqual([expect.objectContaining(cost)]);
  });

  it.each([
    ["parts are not a list", { content: { parts: {} }, finishReason: "STOP" }],
    ["parts hold a null", { content: { parts: [null] }, finishReason: "STOP" }],
    ["candidate is null", null],
    ["content is not an object", { content: "oops", finishReason: "STOP" }],
    ["content is a list", { content: [], finishReason: "STOP" }],
  ])("rejects a Google answer whose %s, costing it", async (_name, candidate) => {
    fakes.google.answer(() => ({ status: 200, body: { candidates: [candidate], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } }));
    const error = await llmProvider(fakes, keys).llm.understand(question()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).upstream).toBe("google");
    expect((error as UpstreamRequestRejected).costs).toEqual([expect.objectContaining({ state: "missing" })]);
  });

  it.each([
    ["an object", {}],
    ["a number", 5],
    ["a boolean", true],
  ])("rejects a Google answer whose candidates are %s, costing it", async (_name, candidates) => {
    fakes.google.answer(() => ({ status: 200, body: { candidates, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } }));
    const error = await llmProvider(fakes, keys).llm.understand(question()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).upstream).toBe("google");
    expect((error as UpstreamRequestRejected).costs).toEqual([expect.objectContaining({ state: "missing" })]);
  });

  it("costs a 2xx answer whose body never finishes as missing", async () => {
    fakes.openrouter.answer(() => ({ status: 200, raw: "{\"id\":\"gen-9\",\"choices\":[", contentType: "application/json", hold: true }));
    const error = await llmProvider(fakes, keys, { understandOpenRouterFirst: true }).llm.understand(question(1_000)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnderstandInterrupted);
    expect((error as UnderstandInterrupted).costs).toEqual([expect.objectContaining({ state: "missing" })]);
  });
});

describe("understand through Gemini's Files API (design 6.5, DD 27)", () => {
  it("uploads once per call and reuses the file on retries, deleting it once", async () => {
    let asked = 0;
    const provider = throughFiles(({ method, path }) => {
      if (path === "/upload/v1beta/files") return uploadSession();
      if (path === "/upload-session/1") return activeFile;
      if (method === "DELETE") return { status: 200, body: {} };
      return asked++ < 2 ? { status: 503, body: { error: { code: 503, message: "busy", status: "UNAVAILABLE" } } } : { status: 200, body: GENERATE_CONTENT_REPLY };
    }, 2);
    const answer = await provider.llm.understand(question(), { mode: "upstream", upstream: "google" });
    expect(answer.upstream).toBe("google");
    await pause(100);
    expect(generated()).toBe(3);
    expect(seenOn("POST", "/upload/")).toBe(1);
    expect(seenOn("DELETE", "/files/abc")).toBe(1);
  });

  it("deletes the uploaded files of a call its deadline ended", async () => {
    const provider = throughFiles(({ method, path }) => {
      if (path === "/upload/v1beta/files") return uploadSession();
      if (path === "/upload-session/1") return { status: 200, body: { file: { name: "files/abc", state: "PROCESSING" } } };
      if (method === "GET") return { status: 200, body: { name: "files/abc", state: "PROCESSING" } };
      if (method === "DELETE") return { status: 200, body: {} };
      return { status: 200, body: GENERATE_CONTENT_REPLY };
    });
    const error = await provider.llm.understand(question(400)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    await pause(300);
    expect(seenOn("DELETE", "/files/abc")).toBe(1);
  });

  it("answers without waiting for the deletes, sending each delete once", async () => {
    let answeredAt = 0;
    const provider = throughFiles(({ method, path }) => {
      if (path === "/upload/v1beta/files") return uploadSession();
      if (path === "/upload-session/1") return activeFile;
      if (method === "DELETE") return { status: 429, body: {}, headers: { "retry-after": "2" } };
      answeredAt = Date.now();
      return { status: 200, body: GENERATE_CONTENT_REPLY };
    });
    const answer = await provider.llm.understand(question());
    expect(answer.text).toBe("ok");
    expect(Date.now() - answeredAt).toBeLessThan(1_000);
    await pause(300);
    expect(seenOn("DELETE", "/files/abc")).toBe(1);
  });
});

describe("understand through Gemini's Files API steps (design 6.5, DD 28)", () => {
  /**
   * Google's Files API answering as it should, unless a case answers first.
   * @param special - The case's own answer, or undefined to answer as usual.
   * @returns The route.
   */
  const filesRoute = (special: (r: { method: string; path: string }) => Reply | undefined) => (r: { method: string; path: string }): Reply =>
    special(r)
    ?? (r.path === "/upload/v1beta/files" ? uploadSession() : r.path === "/upload-session/1" ? activeFile : r.method === "DELETE" ? { status: 200, body: {} } : { status: 200, body: GENERATE_CONTENT_REPLY });

  it("resumes an upload that failed part way from the item that failed", async () => {
    let starts = 0;
    const provider = throughFiles(filesRoute((r) => (r.path === "/upload/v1beta/files" && ++starts === 2 ? { status: 503, body: {} } : undefined)), 1);
    const answer = await provider.llm.understand({ ...question(), media: [picture, picture] }, { mode: "upstream", upstream: "google" });
    expect(answer.upstream).toBe("google");
    expect(seenOn("POST", "/upload/v1beta/files")).toBe(3);
  });

  it("sends each upload step once, leaving retries to llmMaxRetries", async () => {
    const provider = throughFiles(filesRoute((r) => (r.path === "/upload/v1beta/files" ? { status: 429, body: {} } : undefined)), 1);
    const answer = await provider.llm.understand(question());
    expect(answer.upstream).toBe("openrouter");
    expect(seenOn("POST", "/upload/v1beta/files")).toBe(2);
  });

  it("leaves Google at once when an upload step asks for more than a minute", async () => {
    const provider = throughFiles(filesRoute((r) => (r.path === "/upload-session/1" ? { status: 429, body: {}, headers: { "retry-after": "3600" } } : undefined)), 2);
    const answer = await provider.llm.understand(question());
    expect(answer.upstream).toBe("openrouter");
    expect(seenOn("POST", "/upload-session/1")).toBe(1);
  });

  it("polls an uploaded file again on a retry, uploading it once", async () => {
    let polls = 0;
    const provider = throughFiles(filesRoute((r) =>
      r.path === "/upload-session/1" ? { status: 200, body: { file: { name: "files/abc", state: "PROCESSING" } } }
      : r.method === "GET" ? (++polls === 1 ? { status: 503, body: {} } : { status: 200, body: { name: "files/abc", uri: "https://files.example/abc", state: "ACTIVE" } })
      : undefined), 1);
    const answer = await provider.llm.understand(question(), { mode: "upstream", upstream: "google" });
    expect(answer.upstream).toBe("google");
    expect(seenOn("POST", "/upload/v1beta/files")).toBe(1);
  });

  it("names Google's own reason when an upload step is refused", async () => {
    const provider = throughFiles(filesRoute((r) => (r.path === "/upload/v1beta/files" ? { status: 400, body: { error: { code: 400, message: "Unsupported MIME type", status: "INVALID_ARGUMENT" } } } : undefined)));
    const error = await provider.llm.understand(question()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).message).toBe("Unsupported MIME type");
    expect((error as UpstreamRequestRejected).status).toBe(400);
  });

  it("names Google's own reason from a refusal longer than a log snippet", async () => {
    // Google's answer to an upload start with a key it does not take, as measured (2026-10-28).
    const refusal = JSON.stringify({
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com", metadata: { service: "generativelanguage.googleapis.com" } },
          { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en-US", message: "API key not valid. Please pass a valid API key." },
        ],
      },
    }, null, 2);
    expect(refusal.length).toBeGreaterThan(500);
    const provider = throughFiles(filesRoute((r) => (r.path === "/upload/v1beta/files" ? { status: 400, raw: refusal, contentType: "application/json" } : undefined)));
    const error = await provider.llm.understand(question()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).message).toBe("API key not valid. Please pass a valid API key.");
  });

  it("ends as interrupted, with no cost, when an upload answer's body never finishes", async () => {
    const provider = throughFiles(filesRoute((r) => (r.path === "/upload-session/1" ? { status: 200, raw: "{\"file\":", contentType: "application/json", hold: true } : undefined)));
    const error = await provider.llm.understand(question(1_000)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnderstandInterrupted);
    expect((error as UnderstandInterrupted).costs).toEqual([]);
    expect(generated()).toBe(0);
  });

  it.each([
    ["the upload answers a body that is not JSON", (r: { method: string; path: string }): Reply | undefined =>
      r.path === "/upload-session/1" ? { status: 200, raw: "<html>proxy</html>", contentType: "text/html" } : undefined],
    ["the file's state answers null", (r: { method: string; path: string }): Reply | undefined =>
      r.path === "/upload-session/1" ? { status: 200, body: { file: { name: "files/abc", state: "PROCESSING" } } } : r.method === "GET" ? { status: 200, raw: "null", contentType: "application/json" } : undefined],
  ])("rejects without a status or a cost when %s", async (_name, special) => {
    const error = await throughFiles(filesRoute(special)).llm.understand(question()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).status).toBeUndefined();
    expect((error as UpstreamRequestRejected).costs).toEqual([]);
  });
});

describe("understand video types (design 6.5, DD 29)", () => {
  const mov = { bytes: new Uint8Array([0, 0, 0, 20]), contentType: "video/quicktime" };

  it("sends a QuickTime video to Google as video/mov", async () => {
    await llmProvider(fakes, keys).llm.understand({ ...question(), media: [mov] });
    const parts = (posted(fakes.google)[0] as { contents: { parts: Record<string, unknown>[] }[] }).contents[0]!.parts;
    expect(parts).toContainEqual({ inlineData: { mimeType: "video/mov", data: Buffer.from(mov.bytes).toString("base64") } });
  });

  it("sends a QuickTime video to OpenRouter as video/mov", async () => {
    await llmProvider(fakes, keys, { understandOpenRouterFirst: true }).llm.understand({ ...question(), media: [mov] });
    const parts = (posted(fakes.openrouter)[0] as { messages: { content: Record<string, unknown>[] }[] }).messages[0]!.content;
    expect(parts).toContainEqual({ type: "video_url", video_url: { url: `data:video/mov;base64,${Buffer.from(mov.bytes).toString("base64")}` } });
  });
});

describe("understand routes (design 6.5, DD 27)", () => {
  it("rejects a model no understand route matches, sending nothing", async () => {
    const provider = llmProvider(fakes, { ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "or" });
    const error = await provider.llm.understand({ ...question(), model: "anthropic/claude-opus-5.5" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect(() => provider.llm.availability("anthropic/claude-opus-5.5", "understand")).toThrow(UpstreamRequestRejected);
    expect(posted(fakes.anthropic)).toHaveLength(0);
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });

  it("refuses at load an understand route through an upstream no understand adapter speaks to", () => {
    const config = llmConfig(fakes);
    config.llm!.understand_routes = [{ prefix: "anthropic/", upstreams: [{ upstream: "anthropic", weight: 0 }, { upstream: "openrouter", weight: 1 }] }];
    expect(() => createProvider({ config, keyOf: () => undefined, llmMaxRetries: 0, cleanText: (t) => t })).toThrow(ProviderConfigError);
  });
});

describe("a Files API step answered not found (DD 33)", () => {
  it("is a refusal of that step, never a missing model, so the call does not move on", async () => {
    const provider = throughFiles((r) => {
      if (r.path === "/upload/v1beta/files") return uploadSession();
      if (r.path === "/upload-session/1") return { status: 200, body: { file: { name: "files/abc", state: "PROCESSING" } } };
      if (r.method === "GET") return { status: 404, body: { error: { code: 404, message: "File abc not found.", status: "NOT_FOUND" } } };
      return { status: 200, body: {} };
    });
    const error = await provider.llm.understand(question()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).upstream).toBe("google");
    expect(posted(fakes.openrouter)).toHaveLength(0);
  });
});

/**
 * Ask the understand model of a Google-only route, Google answering this.
 * @param body - Google's 200 body.
 * @returns The answer, or what it threw.
 */
async function googleAnswering(body: unknown): Promise<unknown> {
  fakes.google.answer(() => ({ status: 200, body }));
  return llmProvider(fakes, { GOOGLE_API_KEY: "g" }).llm.understand(question()).catch((e: unknown) => e);
}

describe("reading Gemini's answer against one typed structure (DD 33)", () => {
  it("refuses a text part that is not a string, billed as an unreadable answer", async () => {
    const error = await googleAnswering({ ...GENERATE_CONTENT_REPLY, candidates: [{ content: { parts: [{ text: 5 }] }, finishReason: "STOP" }] });
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).status).toBeUndefined();
  });

  it("reads a block reason of null as no block", async () => {
    const answer = await googleAnswering({ promptFeedback: { blockReason: null }, usageMetadata: { promptTokenCount: 10 } }) as { finishReason: string };
    expect(answer.finishReason).toBe("other");
  });

  it("costs an answer without usage as missing, never a known $0", async () => {
    const { usageMetadata: _usage, ...rest } = GENERATE_CONTENT_REPLY;
    const answer = await googleAnswering(rest) as { costs: unknown[] };
    expect(answer.costs).toEqual([expect.objectContaining({ state: "missing" })]);
  });

  it("costs an answer whose token counts are not numbers as missing", async () => {
    const answer = await googleAnswering({ ...GENERATE_CONTENT_REPLY, usageMetadata: { promptTokenCount: "11", candidatesTokenCount: 3 } }) as { costs: unknown[] };
    expect(answer.costs).toEqual([expect.objectContaining({ state: "missing" })]);
  });

  it("counts the thoughts in the output tokens and prices them", async () => {
    const answer = await googleAnswering({ ...GENERATE_CONTENT_REPLY, usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 } }) as { costs: { tokens?: unknown; usd?: number }[] };
    expect(answer.costs[0]?.tokens).toEqual({ input: 20, cachedInput: 0, output: 15, reasoning: 5 });
    expect(answer.costs[0]?.usd).toBeCloseTo((20 * 0.5 + 15 * 3) / 1_000_000, 12);
  });
});

/**
 * Ask the understand model with OpenRouter first, OpenRouter answering this.
 * @param reply - OpenRouter's answer.
 * @param media - The items.
 * @returns The answer, or what it threw.
 */
async function openRouterAnswering(reply: Reply, media = [picture]): Promise<unknown> {
  fakes.openrouter.answer(() => reply);
  return llmProvider(fakes, { OPENROUTER_API_KEY: "or" }, { llmMaxRetries: 0, understandOpenRouterFirst: true }).llm.understand({ ...question(), media }).catch((e: unknown) => e);
}

describe("reading OpenRouter's understand answer against one typed structure (DD 33)", () => {
  const completion = { id: "gen-u", choices: [{ index: 0, message: { role: "assistant", content: "a fox" }, finish_reason: "stop" }], usage: { cost: 0.001 } };

  it.each(["constructor", "__proto__", "toString"])("reads the finish reason %s as other", async (reason) => {
    const answer = await openRouterAnswering({ status: 200, body: { ...completion, choices: [{ ...completion.choices[0], finish_reason: reason }] } }) as { finishReason: unknown };
    expect(answer.finishReason).toBe("other");
  });

  it.each([
    ["at the top of the body, with a code that is not a number", { ...completion, error: { code: "upstream_error", message: "it broke" } }],
    ["at the top of the body, with no code", { ...completion, error: { message: "it broke" } }],
    ["in the choice, with no code and nothing written", { ...completion, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "error", error: { message: "it broke" } }] }],
  ])("refuses with the answer's own status an error %s, as today's understand does", async (_name, body) => {
    const error = await openRouterAnswering({ status: 200, body });
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).status).toBe(200);
    expect((error as UpstreamRequestRejected).costs).toEqual([expect.objectContaining({ state: "known", usd: 0.001 })]);
  });

  it("refuses an answer whose choices are not a list", async () => {
    const error = await openRouterAnswering({ status: 200, body: { ...completion, choices: { 0: completion.choices[0] } } });
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).status).toBeUndefined();
  });

  it.each([
    ["audio/x-m4a", "m4a"],
    ["audio/m4a", "m4a"],
    ["audio/x-mpeg", "mp3"],
    ["audio/mp3", "mp3"],
    ["audio/x-wav", "wav"],
  ])("names %s by OpenRouter's format %s, as shared's canonical types do", async (contentType, format) => {
    await openRouterAnswering({ status: 200, body: completion }, [{ bytes: new Uint8Array([1, 2]), contentType }]);
    const sent = posted(fakes.openrouter)[0] as { messages: { content: { type: string; input_audio?: { format: string } }[] }[] };
    expect(sent.messages[0]!.content.find((p) => p.type === "input_audio")?.input_audio?.format).toBe(format);
  });
});
