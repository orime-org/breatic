// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeHistoryEntity } from "@breatic/shared";
import { makeReadNodeHistoryTool } from "@domain/agent/tools/record-tools.js";
import type { ProjectRecords } from "@domain/agent/tools/project-records.js";

const NODE = "22222222-2222-4222-8222-222222222222";
type Source = { label: string; sourceUrl: string };
const preparePictures = vi.fn();

/** A stored history version; MIME decides whether content is a picture. */
function version(over: Partial<NodeHistoryEntity> = {}): NodeHistoryEntity {
  return {
    id: "history-1", projectId: "project-1", nodeId: NODE, userId: "user-1", operatorName: "Ada",
    entryType: "generation", status: "success", content: "https://storage.example.com/original.bin",
    thumbnailUrl: "https://storage.example.com/display-preview.webp", errorMessage: null, taskId: null,
    metadata: { model: "flux-pro", params: { prompt: "a warm cafe at dawn" } },
    mediaWidth: 1024, mediaHeight: 768, duration: null, mimeType: "image/png", size: 5000,
    createdAt: new Date("2026-10-18T08:00:00Z"), ...over,
  };
}

/** A turn-bound read interface, containing no external IO. */
function records(versions: NodeHistoryEntity[]): ProjectRecords {
  return {
    listConversations: vi.fn(), searchMessages: vi.fn(), readConversation: vi.fn(), activity: vi.fn(), spaceName: vi.fn(),
    nodeRecords: vi.fn().mockResolvedValue({
      tasks: { rows: [], total: 41 }, versions: { rows: versions, total: 63 },
    }),
  };
}

/** Execute one history read with the turn's capability and bound records. */
async function run(
  seesPictures: boolean,
  recs: ProjectRecords,
  signal?: AbortSignal,
): Promise<{ built: ReturnType<typeof makeReadNodeHistoryTool>; answer: unknown }> {
  const built = makeReadNodeHistoryTool({ seesPictures, preparePictures });
  if (!built.execute) throw new Error("read_node_history has no execute");
  const answer = await built.execute({ node_id: NODE, versions_offset: 5, tasks_offset: 10 }, {
    toolCallId: "read-history", messages: [], abortSignal: signal, context: { records: recs },
  });
  return { built, answer };
}

beforeEach(() => {
  preparePictures.mockReset().mockImplementation(async (sources: Source[]) => sources.map((source, index) => ({
    status: "ready", ...source, url: `https://storage.example.com/prepared-${index}.jpg`,
    sizeBytes: 1000 + index, mediaType: "image/jpeg",
  })));
});

describe("read_node_history picture preparation", () => {
  it("reads image content by MIME and existing video covers in version order", async () => {
    const recs = records([
      version(),
      version({ id: "history-2", mimeType: "video/mp4", content: "https://storage.example.com/movie.mp4", thumbnailUrl: "https://storage.example.com/video-cover.png" }),
      version({ id: "history-3", mimeType: "text/plain", content: "This text happens to end in photo.png", thumbnailUrl: null }),
      version({ id: "history-4", mimeType: "audio/mpeg", content: "https://storage.example.com/song.mp3", thumbnailUrl: null }),
      version({ id: "history-5", status: "failed", content: null, thumbnailUrl: null }),
    ]);
    const controller = new AbortController();
    const { built, answer } = await run(true, recs, controller.signal);
    const sources = preparePictures.mock.calls[0]?.[0] as Source[];

    expect(recs.nodeRecords).toHaveBeenCalledWith(NODE, { versionsOffset: 5, tasksOffset: 10 });
    expect(preparePictures).toHaveBeenCalledTimes(1);
    expect(sources.map((source) => source.sourceUrl)).toEqual([
      "https://storage.example.com/original.bin", "https://storage.example.com/video-cover.png",
    ]);
    expect(preparePictures.mock.calls[0]?.[1]).toBe(controller.signal);
    const output = await built.toModelOutput?.({ output: answer } as never);
    expect(output).toMatchObject({ type: "json", value: {
      kind: "agent-pictures-v1",
      pictures: sources.map((source, index) => ({ ...source,
        url: `https://storage.example.com/prepared-${index}.jpg`, sizeBytes: 1000 + index, mediaType: "image/jpeg",
      })),
    } });
    const text = (output as unknown as { value: { text: string } }).value.text;
    expect(text).toContain("a warm cafe at dawn");
    expect(text).toContain("flux-pro");
    expect(text).toContain("41");
    expect(text).toContain("63");
    expect(text).toContain("versions_offset=10");
    expect(text).toContain("tasks_offset=10");
    expect(text).toContain("https://storage.example.com/movie.mp4");
  });

  it("renders the saved result repeatedly without reading or preparing again", async () => {
    const recs = records([version()]);
    const { built, answer } = await run(true, recs);
    const persisted: unknown = JSON.parse(JSON.stringify(answer));
    const first = await built.toModelOutput?.({ output: persisted } as never);
    expect(await built.toModelOutput?.({ output: persisted } as never)).toEqual(first);
    expect(recs.nodeRecords).toHaveBeenCalledTimes(1);
    expect(preparePictures).toHaveBeenCalledTimes(1);
  });

  it("keeps unavailable picture sources and reasons in text while retaining other pictures", async () => {
    preparePictures.mockImplementationOnce(async (sources: Source[]) => [
      { status: "unavailable", ...sources[0], reason: "source-not-found" },
      { status: "ready", ...sources[1], url: "https://storage.example.com/second.jpg", sizeBytes: 2345, mediaType: "image/jpeg" },
    ]);
    const recs = records([version(), version({ id: "second", content: "https://storage.example.com/second.png" })]);
    const { built, answer } = await run(true, recs);
    const output = await built.toModelOutput?.({ output: answer } as never);
    const value = (output as unknown as { value: { text: string; pictures: unknown[] } }).value;
    expect(value.pictures).toHaveLength(1);
    expect(value.pictures[0]).toMatchObject({ sourceUrl: "https://storage.example.com/second.png", sizeBytes: 2345 });
    expect(value.text).toContain("https://storage.example.com/original.bin");
    expect(value.text).toContain("source-not-found");
  });

  it("does no picture preparation when the main model cannot see pictures", async () => {
    const recs = records([version()]);
    const { built, answer } = await run(false, recs);
    expect(typeof answer).toBe("string");
    expect(answer).toContain("https://storage.example.com/original.bin");
    expect(preparePictures).not.toHaveBeenCalled();
    if (built.toModelOutput) expect(await built.toModelOutput({ output: answer } as never)).toEqual({ type: "text", value: answer });
  });

  it("does not prepare picture-less history pages", async () => {
    const recs = records([version({ mimeType: "video/mp4", content: "https://storage.example.com/no-cover.mp4", thumbnailUrl: null })]);
    await run(true, recs);
    expect(preparePictures).not.toHaveBeenCalled();
  });

  it("throws preparation infrastructure failure instead of returning a normal result", async () => {
    preparePictures.mockRejectedValueOnce(new Error("ingest unavailable"));
    await expect(run(true, records([version()]))).rejects.toThrow();
    expect(preparePictures).toHaveBeenCalledTimes(1);
  });
});
