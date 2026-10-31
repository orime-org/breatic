// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_LINES, toolFailureOf } from "@breatic/shared";
import type * as Shared from "@breatic/shared";
import { makeUnderstandMediaTool } from "@domain/agent/tools/understand-media.js";
import { toolOptions, usageSpy } from "@domain/agent/__tests__/helpers/usage-spy.js";

const httpRequestMock = vi.fn();
vi.mock("@breatic/core", () => ({
  getRawEnvVar: (name: string): string | undefined => name === "OPENROUTER_API_KEY" ? "unit-test-key" : undefined,
  getAgentConfig: () => ({
    understand_media_max_items: 10,
    understand_media_max_bytes: 20_000_000,
    understand_media_fetch_timeout_ms: 30_000,
    understand_media_min_bytes_per_sec: 65_536,
    understand_media_read_floor_ms: 5_000,
    understand_media_call_timeout_ms: 180_000,
    understand_media_max_output_tokens: 2048,
  }),
}));
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return { ...actual, httpRequest: (...args: unknown[]) => httpRequestMock(...args) };
});

const FIXTURES = {
  image: { url: "https://example.com/picture.bin", mediaType: "image/png" },
  audio: { url: "https://example.com/voice.wav", mediaType: "audio/wav" },
  video: { url: "https://example.com/clip.mp4", mediaType: "video/mp4" },
};
type Kind = keyof typeof FIXTURES;

/**
 * Run the real fetch, understanding and tool failure layers against wire responses.
 *
 * Only public fixture HEAD/GET responses and the final provider HTTP response
 * are doubled. No understanding function or typed refusal is substituted.
 * @param kinds - The sources in their supplied order.
 * @param response - The service's actual status and error-envelope facts.
 * @returns The model-facing error, reader key and actual provider request body.
 * @throws {Error} when the tool unexpectedly succeeds or loses its failure metadata.
 */
async function refusedBatch(kinds: Kind[], response: { status: number; message: string; code?: number }): Promise<{
  kind: string;
  forModel: string;
  readerKey: string | undefined;
  contentTypes: string[];
}> {
  httpRequestMock.mockImplementation(async (address: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(address);
    if (url.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ error: { message: response.message, ...(response.code === undefined ? {} : { code: response.code }) } }), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    }
    const fixture = Object.values(FIXTURES).find((item) => item.url === url);
    if (fixture === undefined) throw new Error(`unexpected fixture request: ${url}`);
    const headers = { "content-type": fixture.mediaType, "content-length": "3" };
    return new Response(init?.method === "HEAD" ? null : new Uint8Array([1, 2, 3]), { headers });
  });
  const usage = usageSpy();
  const tool = makeUnderstandMediaTool();
  if (tool.execute === undefined) throw new Error("understand_media has no execute");
  const error = await Promise.resolve(tool.execute({
    items: kinds.map((kind) => ({ url: FIXTURES[kind].url })),
    question: "Compare all supplied media.",
  }, toolOptions({}, usage.recorder) as never)).then(
    () => { throw new Error("the provider refusal unexpectedly succeeded"); },
    (caught: unknown) => caught,
  );
  const failure = toolFailureOf(error);
  if (failure === undefined) throw new Error("the refusal lost its ToolFailure metadata");
  const modelCalls = httpRequestMock.mock.calls.filter(([url]) => String(url).endsWith("/chat/completions"));
  expect(modelCalls).toHaveLength(1);
  expect(usage.serviceCalls).toEqual(response.status >= 200 && response.status < 300 ? [{
    source: "tool:understand_media", service: "google/gemini-3.8-flash", provider: "openrouter", requests: 1,
  }] : []);
  const sent = JSON.parse(String((modelCalls[0]![1] as RequestInit).body)) as {
    messages: Array<{ content: Array<{ type: string }> }>;
  };
  return {
    kind: failure.kind,
    forModel: failure.forModel,
    readerKey: "readerKey" in failure ? failure.readerKey : undefined,
    contentTypes: sent.messages[0]!.content.map((part) => part.type),
  };
}

beforeEach(() => { httpRequestMock.mockReset(); });

describe("provider media refusal facts survive through the tool without assigning responsibility", () => {
  it.each([
    ["audio before image", ["audio", "image"]],
    ["image before audio", ["image", "audio"]],
    ["image between video and audio", ["video", "image", "audio"]],
    ["one inline audio", ["audio"]],
    ["inline video and audio", ["video", "audio"]],
  ] satisfies Array<[string, Kind[]]>)("reports a neutral decoding refusal for %s", async (_label, kinds) => {
    const failure = await refusedBatch(kinds, { status: 400, code: 400, message: "Unable to decode audio" });

    expect(failure).toMatchObject({ kind: "tool_failed", readerKey: FAILURE_LINES.refused });
    expect(failure.forModel).toContain("Unable to decode audio");
    expect(failure.forModel).not.toMatch(/fault on our side|fault in the file|our fault|server fault|not in the file/i);
    expect(failure.forModel).not.toMatch(/put the file somewhere|give another address|rehost|could not reach that address/i);
    expect(failure.forModel).not.toMatch(/Item\s+\d/i);
    expect(failure.contentTypes).toEqual([
      "text",
      ...kinds.flatMap((kind) => ["text", kind === "image" ? "image_url" : kind === "audio" ? "input_audio" : "video_url"]),
    ]);
  });

  it("keeps a mixed-request URL-fetch refusal neutral through the final tool failure", async () => {
    const detail = "Cannot fetch content from URL";
    const failure = await refusedBatch(["image", "audio"], { status: 400, code: 400, message: detail });

    expect(failure).toMatchObject({ kind: "tool_failed", readerKey: FAILURE_LINES.refused });
    expect(failure.forModel).toContain(detail);
    expect(failure.forModel).not.toMatch(/fault on our side|fault in the file|our fault|server fault|not in the file/i);
    expect(failure.forModel).not.toMatch(/put the file somewhere|give another address|rehost|could not reach that address/i);
    expect(failure.forModel).not.toMatch(/Item\s+\d/i);
    expect(failure.contentTypes).toEqual(["text", "text", "image_url", "text", "input_audio"]);
  });

  it("keeps an all-address 400 as a source the provider could not fetch", async () => {
    const failure = await refusedBatch(["image"], { status: 400, code: 400, message: "Cannot fetch content from URL" });

    expect(failure).toMatchObject({ kind: "tool_failed", readerKey: FAILURE_LINES.linkUnreachable });
    expect(failure.forModel).toContain("Cannot fetch content from URL");
    expect(failure.forModel).toMatch(/could not reach that address/i);
  });

  it.each([
    [413, 413, "Request body exceeds the provider maximum size", FAILURE_LINES.fileTooLarge],
    [401, 401, "Invalid account credential", FAILURE_LINES.unavailable],
    [200, undefined, "Provider content policy declined this request", FAILURE_LINES.declined],
    [429, 429, "Provider is busy", FAILURE_LINES.busy],
    [503, 503, "Provider is temporarily unavailable", FAILURE_LINES.busy],
  ] as const)("preserves the known %i refusal branch for a mixed request", async (status, code, message, readerKey) => {
    const failure = await refusedBatch(["audio", "image"], { status, code, message });

    expect(failure).toMatchObject({ kind: "tool_failed", readerKey });
    if (status === 413) {
      expect(failure.forModel).toContain("Request body exceeds the provider maximum size");
      expect(failure.forModel).toContain("do not send the same file again");
    }
    if (status === 200) {
      expect(failure.forModel).toContain("Provider content policy declined this request");
      expect(failure.forModel).toMatch(/asking differently/i);
    }
  });
});
