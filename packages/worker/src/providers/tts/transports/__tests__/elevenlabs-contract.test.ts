// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";

import type { ResolvedModel } from "@worker/providers/shared.js";

/**
 * #1960 A7 — ElevenLabs TTS upstream request contract.
 *
 * Every field below is placed where the vendor's own reference puts it
 * (https://elevenlabs.io/docs/api-reference/text-to-speech/convert, read
 * 2026-09-02): the voice is a PATH SEGMENT of `/v1/text-to-speech/{voice_id}`,
 * `text` and `model_id` are top-level body fields, and the two speaking
 * controls live inside a nested `voice_settings` object — where similarity is
 * spelled `similarity_boost`, not the `similarity` our catalog declares.
 *
 * A double can only prove what we send, never what the vendor accepts, so
 * these cases pin placement only. Whether a given voice id exists is settled
 * by a real request during A3.
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

const { generate } = await import(
  "@worker/providers/tts/transports/elevenlabs.js"
);

const RESOLVED: ResolvedModel = {
  modelName: "elevenlabs-v3",
  modelId: "eleven_v3",
  providerName: "elevenlabs",
  baseUrl: "https://api.elevenlabs.test/v1",
  apiKey: "eleven-key",
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

describe("elevenlabs tts transport upstream contract (#1960 A7)", () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    httpRequestMock.mockResolvedValue(
      new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200 }),
    );
  });

  it("puts the voice in the URL path, and leaves it out of the body", async () => {
    await generate("", RESOLVED, { text: "hello", voice_id: "21m00Tcm4Tlv" });

    const { url, body } = sentRequest();
    expect(url).toBe(
      "https://api.elevenlabs.test/v1/text-to-speech/21m00Tcm4Tlv",
    );
    expect(body).not.toHaveProperty("voice_id");
  });

  it("renames similarity to similarity_boost, nested under voice_settings", async () => {
    await generate("", RESOLVED, {
      text: "hello",
      voice_id: "v1",
      similarity: 0.8,
    });

    const { body } = sentRequest();
    expect(body.voice_settings).toEqual({ similarity_boost: 0.8 });
    expect(body).not.toHaveProperty("similarity");
    expect(body).not.toHaveProperty("similarity_boost");
  });

  it("nests stability under voice_settings, alongside similarity", async () => {
    await generate("", RESOLVED, {
      text: "hello",
      voice_id: "v1",
      stability: 0,
      similarity: 0.75,
    });

    const { body } = sentRequest();
    expect(body.voice_settings).toEqual({
      stability: 0,
      similarity_boost: 0.75,
    });
    expect(body).not.toHaveProperty("stability");
  });

  it("omits voice_settings entirely when neither control was given", async () => {
    await generate("", RESOLVED, { text: "hello", voice_id: "v1" });

    expect(sentRequest().body).not.toHaveProperty("voice_settings");
  });

  it("sends the text and the resolved model id where the vendor expects them", async () => {
    await generate("", RESOLVED, { text: "hello", voice_id: "v1" });

    const { body, headers } = sentRequest();
    expect(body.text).toBe("hello");
    expect(body.model_id).toBe("eleven_v3");
    expect(headers["xi-api-key"]).toBe("eleven-key");
  });
});
