// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type * as coreModule from "@breatic/core";
import { braveJson } from "@domain/agent/tools/brave.js";
import { imageSearch, makeImageSearchTool, renderImagesForModel } from "@domain/agent/tools/image-search.js";
import type { ImageSearchAnswer } from "@domain/agent/tools/image-search.js";
import { toolOptions } from "@domain/agent/__tests__/helpers/usage-spy.js";

vi.mock("@domain/agent/tools/brave.js", () => ({ braveJson: vi.fn() }));
vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return { ...actual, env: { BRAVE_SEARCH_API_KEY: "unit-test-key" } };
});

const search = vi.mocked(braveJson);
type Source = { label: string; sourceUrl: string };
type Ready = Source & { status: "ready"; url: string; sizeBytes: number; mediaType: "image/jpeg" };
const preparePictures = vi.fn<(sources: readonly Source[], signal?: AbortSignal) => Promise<Ready[]>>();

/** A real search-result shape with deliberately distinct image addresses. */
function result(index: number): Record<string, unknown> {
  return {
    title: `Picture ${index}`,
    thumbnail: { src: `https://search.example.com/thumb-${index}.bin`, width: 500, height: 400 },
    properties: { url: `https://original.example.com/photo-${index}.png`, width: 2000, height: 1600 },
    url: `https://publisher.example.com/page-${index}`,
    source: "Publisher",
  };
}

/** Invoke the factory-built tool through its runtime input schema. */
async function run(seesPictures: boolean, count = 2, signal?: AbortSignal): Promise<{
  built: ReturnType<typeof makeImageSearchTool>;
  answer: ImageSearchAnswer;
}> {
  const built = makeImageSearchTool({ seesPictures, preparePictures });
  if (!built.execute) throw new Error("search_images has no execute");
  const input = (built.inputSchema as unknown as z.ZodType<{ query: string; count: number }>).parse({ query: "colours", count });
  const answer = await built.execute(input, toolOptions({ abortSignal: signal }) as never) as ImageSearchAnswer;
  return { built, answer };
}

beforeEach(() => {
  search.mockReset().mockResolvedValue({ results: [result(1), result(2)] });
  preparePictures.mockReset().mockImplementation(async (sources) => sources.map((source, index) => ({
    status: "ready",
    ...source,
    url: `https://storage.example.com/picture-${index}.jpg`,
    sizeBytes: 1000 + index,
    mediaType: "image/jpeg",
  })));
});

describe("search_images prepares pictures once during execute", () => {
  it("prepares the actual returned thumbnails in search order and preserves the panel result", async () => {
    const controller = new AbortController();
    const { built, answer } = await run(true, 2, controller.signal);
    const sources = preparePictures.mock.calls[0]?.[0];

    expect(preparePictures).toHaveBeenCalledTimes(1);
    expect(sources?.map((source) => source.sourceUrl)).toEqual([
      "https://search.example.com/thumb-1.bin", "https://search.example.com/thumb-2.bin",
    ]);
    expect(sources?.map((source) => source.label).every((label) => label.length > 0)).toBe(true);
    expect(preparePictures.mock.calls[0]?.[1]).toBe(controller.signal);
    expect(answer).toMatchObject({ query: "colours", sent: 2, images: [
      { title: "Picture 1", thumbnailUrl: "https://search.example.com/thumb-1.bin", imageUrl: "https://original.example.com/photo-1.png" },
      { title: "Picture 2", thumbnailUrl: "https://search.example.com/thumb-2.bin", imageUrl: "https://original.example.com/photo-2.png" },
    ] });
    const output = await built.toModelOutput?.({ output: answer } as never);
    expect(output).toMatchObject({ type: "json", value: {
      kind: "agent-pictures-v1",
      pictures: sources?.map((source, index) => ({ ...source,
        url: `https://storage.example.com/picture-${index}.jpg`, sizeBytes: 1000 + index, mediaType: "image/jpeg",
      })),
    } });
    expect(answer).toHaveProperty("forModel", (output as { value: unknown }).value);
    expect(JSON.stringify(output)).not.toContain("You have not seen these pictures");
  });

  it("does no preparation or search IO when rendering a persisted result repeatedly", async () => {
    const { built, answer } = await run(true);
    const persisted = JSON.parse(JSON.stringify(answer)) as typeof answer;
    const first = await built.toModelOutput?.({ output: persisted } as never);
    const second = await built.toModelOutput?.({ output: persisted } as never);
    expect(second).toEqual(first);
    expect(preparePictures).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("prepares every result at the schema ceiling of twenty", async () => {
    search.mockResolvedValueOnce({ results: Array.from({ length: 20 }, (_unused, index) => result(index)) });
    const { built, answer } = await run(true, 20);
    expect(preparePictures.mock.calls[0]?.[0].map((source) => source.sourceUrl)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => `https://search.example.com/thumb-${index}.bin`),
    );
    const output = await built.toModelOutput?.({ output: answer } as never);
    expect((output as unknown as { value: { pictures: unknown[] } }).value.pictures).toHaveLength(20);
  });

  it("keeps the old text-only behavior when this turn has no picture capability", async () => {
    const { built, answer } = await run(false);
    expect(preparePictures).not.toHaveBeenCalled();
    expect(await built.toModelOutput?.({ output: answer } as never)).toEqual({ type: "text", value: renderImagesForModel(answer) });
    expect(built.description).toMatch(/will not see|cannot see|not see/i);
    expect(imageSearch.toModelOutput).toBeTypeOf("function");
  });

  it("does not prepare an empty search result", async () => {
    search.mockResolvedValueOnce({ results: [] });
    const { answer } = await run(true);
    expect(answer).toMatchObject({ query: "colours", images: [], sent: 0 });
    expect(preparePictures).not.toHaveBeenCalled();
  });

  it("propagates preparation infrastructure errors as tool failures", async () => {
    preparePictures.mockRejectedValueOnce(new Error("ingest unavailable"));
    await expect(run(true)).rejects.toThrow();
    expect(preparePictures).toHaveBeenCalledTimes(1);
  });
});
