// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_LINES, toolFailureOf } from "@breatic/shared";
import type * as Shared from "@breatic/shared";
import type * as Core from "@breatic/core";
import { UpstreamRequestRejected, type Cost } from "@breatic/provider";
import { makeUnderstandMediaTool } from "@domain/agent/tools/understand-media.js";
import { toolOptions, usageSpy } from "@domain/agent/__tests__/helpers/usage-spy.js";

const httpRequestMock = vi.fn();
const understand = vi.hoisted(() => vi.fn());
vi.mock("@domain/provider/instance.js", () => ({ provider: () => ({ llm: { understand } }) }));
vi.mock("@breatic/core", async (importOriginal) => ({
  ...await importOriginal<typeof Core>(),
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
 * Run the real fetch, understanding and tool failure layers against a refusal.
 *
 * Only public fixture HEAD/GET responses and provider's refusal are doubled;
 * how each upstream's answer becomes that refusal is provider's, and its tests
 * hold it.
 * @param kinds - The sources in their supplied order.
 * @param response - The upstream's status and words, as provider hands them over.
 * @returns The model-facing error, user key and the types of the items handed to provider.
 * @throws {Error} when the tool unexpectedly succeeds or loses its failure metadata.
 */
async function refusedBatch(kinds: Kind[], response: { status: number; message: string; code?: number }): Promise<{
  kind: string;
  forModel: string;
  userKey: string | undefined;
  contentTypes: string[];
}> {
  // A refusal inside a 2xx answer was billed.
  const costs: Cost[] = response.status >= 200 && response.status < 300 ? [{ state: "missing", reason: "no cost" }] : [];
  understand.mockRejectedValue(new UpstreamRequestRejected("google/gemini-3.8-flash", "openrouter", response.message, costs, { status: response.code ?? response.status }));
  httpRequestMock.mockImplementation(async (address: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(address);
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
  expect(understand).toHaveBeenCalledTimes(1);
  expect(vi.mocked(usage.recorder.recordModelCall).mock.calls.map(([call]) => call)).toEqual(costs.map((cost) => ({
    source: "tool:understand_media", model: "google/gemini-3.8-flash", upstream: "openrouter", cost, requests: 1,
  })));
  const [sent] = understand.mock.calls[0] as [{ media: Array<{ contentType: string }> }];
  return {
    kind: failure.kind,
    forModel: failure.forModel,
    userKey: "userKey" in failure ? failure.userKey : undefined,
    contentTypes: sent.media.map((item) => item.contentType),
  };
}

beforeEach(() => {
  httpRequestMock.mockReset();
  understand.mockReset();
});

describe("provider media refusal facts survive through the tool without assigning responsibility", () => {
  it.each([
    ["audio before image", ["audio", "image"]],
    ["image before audio", ["image", "audio"]],
    ["image between video and audio", ["video", "image", "audio"]],
    ["one inline audio", ["audio"]],
    ["inline video and audio", ["video", "audio"]],
  ] satisfies Array<[string, Kind[]]>)("reports a neutral decoding refusal for %s", async (_label, kinds) => {
    const failure = await refusedBatch(kinds, { status: 400, code: 400, message: "Unable to decode audio" });

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.refused });
    expect(failure.forModel).toContain("Unable to decode audio");
    expect(failure.forModel).not.toMatch(/fault on our side|fault in the file|our fault|server fault|not in the file/i);
    expect(failure.forModel).not.toMatch(/put the file somewhere|give another address|rehost|could not reach that address/i);
    expect(failure.forModel).not.toMatch(/Item\s+\d/i);
    expect(failure.contentTypes).toEqual(kinds.map((kind) => FIXTURES[kind].mediaType));
  });

  it("keeps a mixed-request URL-fetch refusal neutral through the final tool failure", async () => {
    const detail = "Cannot fetch content from URL";
    const failure = await refusedBatch(["image", "audio"], { status: 400, code: 400, message: detail });

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.refused });
    expect(failure.forModel).toContain(detail);
    expect(failure.forModel).not.toMatch(/fault on our side|fault in the file|our fault|server fault|not in the file/i);
    expect(failure.forModel).not.toMatch(/put the file somewhere|give another address|rehost|could not reach that address/i);
    expect(failure.forModel).not.toMatch(/Item\s+\d/i);
    expect(failure.contentTypes).toEqual(["image/png", "audio/wav"]);
  });

  it("keeps an all-address 400 as a source the provider could not fetch", async () => {
    const failure = await refusedBatch(["image"], { status: 400, code: 400, message: "Cannot fetch content from URL" });

    expect(failure).toMatchObject({ kind: "tool_failed", userKey: FAILURE_LINES.linkUnreachable });
    expect(failure.forModel).toContain("Cannot fetch content from URL");
    expect(failure.forModel).toMatch(/could not reach that address/i);
  });

  it.each([
    [413, 413, "Request body exceeds the provider maximum size", FAILURE_LINES.fileTooLarge],
    [401, 401, "Invalid account credential", FAILURE_LINES.unavailable],
    [200, undefined, "Provider content policy declined this request", FAILURE_LINES.declined],
    [429, 429, "Provider is busy", FAILURE_LINES.busy],
    [503, 503, "Provider is temporarily unavailable", FAILURE_LINES.busy],
  ] as const)("preserves the known %i refusal branch for a mixed request", async (status, code, message, userKey) => {
    const failure = await refusedBatch(["audio", "image"], { status, code, message });

    expect(failure).toMatchObject({ kind: "tool_failed", userKey });
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
