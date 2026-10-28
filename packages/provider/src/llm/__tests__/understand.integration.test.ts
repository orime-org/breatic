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
