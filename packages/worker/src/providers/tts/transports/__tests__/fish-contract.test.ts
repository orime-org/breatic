// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1960 A7 — Fish Audio TTS upstream request contract.
 *
 * Every field below is placed where the vendor's own OpenAPI reference puts
 * it (https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech,
 * read 2026-09-01): `model` is a REQUEST HEADER whose enum is
 * s1 / s2-pro / s2.1-pro / s2.1-pro-free, and the speaking controls live
 * inside a nested `prosody` object — not at the top level of the body.
 *
 * A double can only prove what we send, never what the vendor accepts, so
 * these cases pin placement only. Whether `s2-pro` is accepted is settled by
 * a real request during A3.
 */
const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

// The transport logs on success, and core's logger refuses to resolve until an
// application entry has called initCore(). The worker package has no vitest
// setup file, so every test here stands the logger up itself.
vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

const { generate } = await import("@worker/providers/tts/transports/fish.js");

const RESOLVED: ResolvedModel = {
  modelName: "fish-s2-pro",
  modelId: "s2-pro",
  providerName: "fish",
  baseUrl: "https://api.fish.test",
  apiKey: "fish-key",
  timeout: 60,
  maxConcurrency: 5,
  costPerCall: 0,
  extraParams: {},
  litellmModel: undefined,
  tokenPrice: undefined,
  creditPrice: undefined,
};

/**
 * Read back the single request the transport made.
 * @returns The request URL, its headers and its parsed JSON body.
 * @throws {Error} When the transport made no request at all.
 */
function sentRequest(): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const call = httpRequestMock.mock.calls[0];
  if (!call) throw new Error("the transport made no request");
  const [url, init] = call as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  };
}

describe("fish tts transport upstream contract (#1960 A7)", () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    httpRequestMock.mockResolvedValue(
      new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200 }),
    );
  });

  it("carries the model in a header, and leaves it out of the body", async () => {
    await generate("", RESOLVED, { text: "hello" });

    const { headers, body } = sentRequest();
    expect(headers.model).toBe("s2-pro");
    expect(body).not.toHaveProperty("model");
  });

  it("nests speed under prosody instead of the top level", async () => {
    await generate("", RESOLVED, { text: "hello", speed: 1.4 });

    const { body } = sentRequest();
    expect(body.prosody).toEqual({ speed: 1.4 });
    expect(body).not.toHaveProperty("speed");
  });

  it("nests volume under prosody, alongside speed", async () => {
    await generate("", RESOLVED, { text: "hello", speed: 0.8, volume: -6 });

    const { body } = sentRequest();
    expect(body.prosody).toEqual({ speed: 0.8, volume: -6 });
    expect(body).not.toHaveProperty("volume");
  });

  it("omits prosody entirely when neither control was given", async () => {
    await generate("", RESOLVED, { text: "hello" });

    expect(sentRequest().body).not.toHaveProperty("prosody");
  });

  it("pins the container format to mp3 whatever the params carry", async () => {
    await generate("", RESOLVED, { text: "hello", format: "wav" });

    // The whole output chain is already fixed on mp3: dispatch.ts stamps the
    // `.mp3` extension and this transport reports `audio/mpeg`. A params-driven
    // format would make the bytes, the storage key and the registered MIME
    // disagree with each other.
    expect(sentRequest().body.format).toBe("mp3");
  });

  it("still sends reference_id and text where the vendor expects them", async () => {
    await generate("", RESOLVED, { text: "hello", reference_id: "abc-123" });

    const { url, body, headers } = sentRequest();
    expect(url).toBe("https://api.fish.test/v1/tts");
    expect(body.text).toBe("hello");
    expect(body.reference_id).toBe("abc-123");
    expect(headers.Authorization).toBe("Bearer fish-key");
  });
});
