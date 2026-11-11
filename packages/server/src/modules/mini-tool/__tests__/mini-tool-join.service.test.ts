// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Preparing a join run (inner#1825 §6.4): every clip goes through the same two
 * checks as the source, the run carries the stored keys in joining order, the
 * clip count is held to `join_max_clips`, and clips whose bytes (read, then
 * written again as the output) would not fit the container's disk are refused
 * before any row opens.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";

/** What the ledger holds under each stored key: its kind and its size. */
const h = vi.hoisted(() => ({
  assets: new Map<string, { kind: string; sizeBytes: number }>(),
}));

/** The class sizes and the join ceiling the run is prepared against. */
const CONFIG = {
  poll_interval_ms: 5000,
  prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 },
  classes: {
    MiniToolContainerStd1: { instance_type: "standard-1", vcpu: 0.5, memory_gib: 4, disk_gb: 8 },
    MiniToolContainerStd4: { instance_type: "standard-4", vcpu: 4, memory_gib: 12, disk_gb: 20 },
  },
  ops: {
    cut: { container_class: "MiniToolContainerStd1", precheck_seconds: 300 },
    join: { container_class: "MiniToolContainerStd4", precheck_seconds: 600 },
    audio_join: { container_class: "MiniToolContainerStd4", precheck_seconds: 600 },
  },
  join_max_clips: 20,
  waveform_max_seconds: 600,
  waveform_max_bytes: 200_000_000,
  waveform_peaks_retry_ms: 5000,
  waveform_peaks_retry_max_ms: 600_000,
};

const BUCKET = "https://assets.example.com/";

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof coreModule>()),
  env: { CREDIT_MULTIPLIER: 1 },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getMiniToolsConfig: () => CONFIG,
  getStorageAdapter: async () => ({
    keyFromUrl: (url: string): string | null => (url.startsWith(BUCKET) ? url.slice(BUCKET.length) : null),
  }),
}));

vi.mock("@breatic/domain", async () => ({
  // Arithmetic, so the real ones: a double would be a second copy of the rate.
  containerCostUsd: (await import("../../../../../domain/src/credit/container-cost.js")).containerCostUsd,
  creditsForUsd: (await import("../../../../../domain/src/credit/usage-cost.js")).creditsForUsd,
  MIN_TASK_CREDIT_COST: 5,
  estimateTaskCredits: vi.fn().mockResolvedValue(5),
  modelCatalog: { getModelCatalog: vi.fn().mockReturnValue({ image: [], video: [], audio: [], tts: [], three_d: [] }) },
  assetRepo: {
    findLiveByStorageKey: vi.fn(async (key: string) => {
      const asset = h.assets.get(key);
      return asset === undefined ? null : { storageKey: key, durationSeconds: 5, ...asset };
    }),
  },
}));

import { AppError } from "@breatic/core";
import { t } from "@breatic/shared";
import { miniToolById, type MiniToolRequest, type MiniToolSpec } from "@breatic/shared/mini-tools";

import { prepareRun } from "@server/modules/mini-tool/mini-tool.service.js";

/** The user-facing sentence a join whose clips are too large together is refused with. */
const CLIPS_TOO_LARGE = "server.mini_tool.clipsTooLarge";

const GB = 1_000_000_000;

/**
 * A join tool as the registry declares it (§6.3): the source is the first
 * clip, `clips` the rest in order.
 * @param medium - What it joins.
 * @returns The tool.
 */
function joinTool(medium: "video" | "audio"): MiniToolSpec {
  const cut = miniToolById(medium === "video" ? "video.cut" : "audio.cut") as MiniToolSpec;
  return {
    ...cut,
    id: `${medium}.join`,
    source: medium,
    run: { kind: "container", op: medium === "video" ? "join" : "audio_join" },
    params: [{ kind: "number", key: "crossfade", default: 0, min: 0, max: medium === "video" ? 2 : 3, step: 0.1 }],
    slots: [{ key: "clips", param: "clips", accepts: medium, many: true, bannerKey: "x", required: true }],
    outputs: [{ modality: medium, namePrefix: medium === "video" ? "JOIN-VIDEO" : "JOIN-AUDIO" }],
  } as unknown as MiniToolSpec;
}

const VIDEO_JOIN = joinTool("video");
const AUDIO_JOIN = joinTool("audio");

/**
 * File one stored object in the ledger and give its address.
 * @param key - Its storage key.
 * @param kind - The kind read off its bytes.
 * @param sizeBytes - Its size.
 * @returns Its address in our bucket.
 */
function stored(key: string, kind: string, sizeBytes = 10_000_000): string {
  h.assets.set(key, { kind, sizeBytes });
  return `${BUCKET}${key}`;
}

/**
 * A join request.
 * @param tool - The tool.
 * @param source - The first clip's address.
 * @param clips - The other clips' addresses, in order.
 * @returns The validated body.
 */
function joinRequest(tool: MiniToolSpec, source: string, clips: string[]): MiniToolRequest {
  return {
    tool: tool.id,
    project_id: "11111111-1111-4111-8111-111111111111",
    space_id: "22222222-2222-4222-9222-222222222222",
    node_ids: ["33333333-3333-4333-8333-333333333333"],
    source: { url: source },
    params: { crossfade: 0 },
    slots: { clips: clips.map((url) => ({ url })) },
  };
}

/**
 * The error a preparation was refused with.
 * @param run - The preparation.
 * @returns The refusal.
 * @throws {Error} When it was not refused.
 */
async function refusal(run: Promise<unknown>): Promise<AppError> {
  const err = await run.then(
    () => {
      throw new Error("the run was prepared, not refused");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

beforeEach(() => {
  h.assets.clear();
});

describe("prepareRun — a join", () => {
  it("carries every clip's stored key in joining order, the source first", async () => {
    const a = stored("v/a.mp4", "video");
    const b = stored("v/b.mp4", "video");
    const c = stored("v/c.mp4", "video");

    const run = (await prepareRun(VIDEO_JOIN, joinRequest(VIDEO_JOIN, a, [b, c]))) as unknown as Record<string, unknown>;

    expect(run.sourceKey).toBe("v/a.mp4");
    expect(run.inputKeys).toEqual(["v/a.mp4", "v/b.mp4", "v/c.mp4"]);
  });

  it("carries an audio join's keys the same way", async () => {
    const a = stored("a/a.m4a", "audio");
    const b = stored("a/b.mp3", "audio");

    const run = (await prepareRun(AUDIO_JOIN, joinRequest(AUDIO_JOIN, a, [b]))) as unknown as Record<string, unknown>;

    expect(run.inputKeys).toEqual(["a/a.m4a", "a/b.mp3"]);
  });

  it("refuses a clip that is not one of our addresses, with the source's sentence", async () => {
    const a = stored("v/a.mp4", "video");
    const b = stored("v/b.mp4", "video");

    const err = await refusal(prepareRun(VIDEO_JOIN, joinRequest(VIDEO_JOIN, a, [b, "https://elsewhere.example.org/c.mp4"])));

    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(t("server.mini_tool.foreignSource"));
  });

  it("refuses a clip our bucket files as another medium, or not at all, with the source's sentence", async () => {
    const a = stored("v/a.mp4", "video");
    for (const clip of [stored("a/b.m4a", "audio"), stored("i/b.png", "image"), `${BUCKET}v/unfiled.mp4`]) {
      const err = await refusal(prepareRun(VIDEO_JOIN, joinRequest(VIDEO_JOIN, a, [clip])));

      expect(err.statusCode, clip).toBe(400);
      expect(err.message, clip).toBe(t("server.mini_tool.foreignSource"));
    }
  });

  it("refuses a video clip in an audio join", async () => {
    const a = stored("a/a.m4a", "audio");
    const v = stored("v/b.mp4", "video");

    const err = await refusal(prepareRun(AUDIO_JOIN, joinRequest(AUDIO_JOIN, a, [v])));

    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(t("server.mini_tool.foreignSource"));
  });

  // §6.4: clips runs from 1 to join_max_clips − 1, the source being the first of join_max_clips.
  it("refuses a join with no clip besides the source", async () => {
    const a = stored("v/a.mp4", "video");

    const err = await refusal(prepareRun(VIDEO_JOIN, joinRequest(VIDEO_JOIN, a, [])));

    expect(err.statusCode).toBe(400);
  });

  it("reads each input's ledger row once, its kind and its size together (round 3)", async () => {
    const a = stored("v/a.mp4", "video");
    const b = stored("v/b.mp4", "video");
    const c = stored("v/c.mp4", "video");
    const { assetRepo } = await import("@breatic/domain");
    vi.mocked(assetRepo.findLiveByStorageKey).mockClear();

    await prepareRun(VIDEO_JOIN, joinRequest(VIDEO_JOIN, a, [b, c]));

    expect(vi.mocked(assetRepo.findLiveByStorageKey).mock.calls.map(([key]) => key)).toEqual(["v/a.mp4", "v/b.mp4", "v/c.mp4"]);
    expect((assetRepo as { findKindByStorageKey?: unknown }).findKindByStorageKey).toBeUndefined();
  });

  it("takes join_max_clips − 1 clips and refuses one more", async () => {
    const a = stored("v/a.mp4", "video");
    const clips = Array.from({ length: CONFIG.join_max_clips }, (_, i) => stored(`v/${i}.mp4`, "video"));

    const fits = (await prepareRun(VIDEO_JOIN, joinRequest(VIDEO_JOIN, a, clips.slice(0, -1)))) as unknown as Record<string, unknown>;
    expect(fits.inputKeys).toHaveLength(CONFIG.join_max_clips);

    const err = await refusal(prepareRun(VIDEO_JOIN, joinRequest(VIDEO_JOIN, a, clips)));
    expect(err.statusCode).toBe(400);
    // Said as the count, not as a file that cannot be processed.
    expect(err.message).toBe(t("server.mini_tool.joinClipCount", { max: CONFIG.join_max_clips }));
    expect(err.message).not.toBe(t("server.mini_tool.foreignSource"));
  });

  // §6.4: the container holds every input and the output, which is about their sum.
  it("refuses clips whose bytes, twice over, pass the class's disk, with the clips-too-large sentence", async () => {
    const a = stored("v/a.mp4", "video", 4 * GB);
    const b = stored("v/b.mp4", "video", 4 * GB);
    const c = stored("v/c.mp4", "video", 4 * GB);

    const err = await refusal(prepareRun(VIDEO_JOIN, joinRequest(VIDEO_JOIN, a, [b, c])));

    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(t(CLIPS_TOO_LARGE));
  });

  it("counts the source's bytes toward the sum", async () => {
    const a = stored("a/a.m4a", "audio", 8 * GB);
    const b = stored("a/b.m4a", "audio", 3 * GB);

    const err = await refusal(prepareRun(AUDIO_JOIN, joinRequest(AUDIO_JOIN, a, [b])));

    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(t(CLIPS_TOO_LARGE));
  });

  it("takes clips whose bytes, twice over, fit the class's disk", async () => {
    const a = stored("v/a.mp4", "video", 3 * GB);
    const b = stored("v/b.mp4", "video", 3 * GB);
    const c = stored("v/c.mp4", "video", 3 * GB);

    const run = (await prepareRun(VIDEO_JOIN, joinRequest(VIDEO_JOIN, a, [b, c]))) as unknown as Record<string, unknown>;

    expect(run.inputKeys).toEqual(["v/a.mp4", "v/b.mp4", "v/c.mp4"]);
  });
});

describe("prepareRun — a container tool with one input", () => {
  it("keeps its run as it was, the source its only input", async () => {
    const a = stored("v/a.mp4", "video");
    const cut = miniToolById("video.cut") as MiniToolSpec;

    const run = await prepareRun(cut, {
      ...joinRequest(cut, a, []),
      tool: "video.cut",
      params: { range: { start: 0, end: 2 } },
      slots: {},
    });

    expect(run.sourceKey).toBe("v/a.mp4");
    expect((run as unknown as Record<string, unknown>).inputKeys ?? ["v/a.mp4"]).toEqual(["v/a.mp4"]);
  });
});
