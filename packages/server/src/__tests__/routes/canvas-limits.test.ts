// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Canvas limits route tests — the knobs the frontend reads before it can
 * gate anything (#1782, #2175): config yaml → GET /canvas/limits.
 *
 * inner#1306 (canvas design §4 去背景、对口型 rows; execution design §9.3): the
 * video panel also reads, from `config/mini-tools.yaml` `executions`, the
 * remove-background model and the lip-sync choices (selectable models with
 * their duration ranges, the tracking range, the people and dialogue caps).
 * The field names `removeBackgroundModel` and `lipSync` (camelCase, `null`
 * when the deployment configures no lip-sync) are shapes this test chose in
 * the route's existing style.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));

// The optional lip-sync execution the mocked mini-tools config carries; a test
// sets it to `undefined` for a deployment that configures no lip-sync.
const lipSyncHolder: { execution: unknown } = vi.hoisted(() => ({ execution: undefined }));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  return {
    ...(await coreMock(importOriginal)),
    getUnderstandConfig: vi.fn(() => ({
      max_media_bytes: 20_971_520,
      long_media: { max_source_bytes: 2_147_483_648 },
    })),
    getMiniToolsConfig: vi.fn(() => ({
      waveform_max_seconds: 600,
      waveform_max_bytes: 200_000_000,
      waveform_peaks_retry_ms: 5000,
      waveform_peaks_retry_max_ms: 600_000,
      executions: {
        "video.remove-bg": { model: "remove-bg-from-config", preparation: { container_class: "MiniToolContainerStd4", precheck_seconds: 300 } },
        "video.split": { container_class: "MiniToolContainerStd4", precheck_seconds: 300, max_outputs: 9, max_outputs_per_job: 8 },
        ...(lipSyncHolder.execution === undefined ? {} : { "video.lip-sync": lipSyncHolder.execution }),
      },
      // Not the shipped 20, so the case proves the route reads the accessor.
      join_max_clips: 17,
    })),
  };
});

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return domainMock();
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  return serverModulesMock(importOriginal);
});

// The route layer only translates HTTP → the config accessor, so the
// accessor is mocked here (the loader itself — real yaml read + schema —
// is covered by src/config/__tests__/limits.test.ts; these values differ from
// the shipped yaml so the test proves the route reads the accessor).
vi.mock("../../config/limits.js", () => ({
  getCanvasReferencePoolCap: vi.fn(() => 42),
  getNodeHistoryPageSize: vi.fn(() => 15),
  getUnderstandConfig: vi.fn(() => ({ max_media_bytes: 20_971_520 })),
}));

import { createApp } from "../../app.js";

const AUTH = { Cookie: "breatic_session=valid-token" };

/**
 * A configured lip-sync execution whose values differ from any shipped model, carrying the
 * fields the panel must not receive (fingerprints, crop size, the tracking model's name).
 * @returns The execution as `getMiniToolsConfig()` returns it.
 */
function lipSyncExecution(): Record<string, unknown> {
  return {
    container_class: "MiniToolContainerStd4", precheck_seconds: 300, max_outputs: 1, max_outputs_per_job: 1,
    models: [
      { name: "lipsync-first", schema_fingerprint: "1".repeat(64), min_duration_seconds: 1.5, max_duration_seconds: 300, crop_size: 512, accepts_sync_mode: true },
      { name: "lipsync-second", schema_fingerprint: "2".repeat(64), min_duration_seconds: 2, max_duration_seconds: 15, crop_size: 256, accepts_sync_mode: false },
    ],
    tracking: { model: "tracker-from-config", min_duration_seconds: 0.5, max_duration_seconds: 600 },
    max_people: 3,
    max_dialogues: 7,
  };
}

describe("GET /canvas/limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lipSyncHolder.execution = lipSyncExecution();
  });

  it("requires auth", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/canvas/limits");
    expect(res.status).toBe(401);
  });

  it("serves exactly what the limits accessor returns", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/canvas/limits", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        referencePoolCap: number;
        nodeHistoryPageSize: number;
        understandMaxBytes: number;
        understandLongMediaMaxBytes: number;
        waveformMaxSeconds: number;
        waveformMaxBytes: number;
        waveformPeaksRetryMs: number;
        waveformPeaksRetryMaxMs: number;
        joinMaxClips: number;
      };
    };
    expect(body.data.referencePoolCap).toBe(42);
    expect(body.data.nodeHistoryPageSize).toBe(15);
    // The browser refuses a file over this before it builds anything, and its
    // toast says the number — so the number has to reach it, and it comes
    // from the same file the run itself reads.
    expect(body.data.understandMaxBytes).toBe(20_971_520);
    expect(body.data.understandLongMediaMaxBytes).toBe(2_147_483_648);
    // inner#1305 §4.4: the cut band draws a waveform only under both.
    expect(body.data.waveformMaxSeconds).toBe(600);
    expect(body.data.waveformMaxBytes).toBe(200_000_000);
    // An open band reads peaks not yet written this often, for this long.
    expect(body.data.waveformPeaksRetryMs).toBe(5000);
    expect(body.data.waveformPeaksRetryMaxMs).toBe(600_000);
    // inner#1825 §6.3: the join panel's add tile and slot pick stop at this many clips.
    expect(body.data.joinMaxClips).toBe(17);
  });

  it("serves the remove-background model the config names", async () => {
    const res = await createApp().request("/api/v1/canvas/limits", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.removeBackgroundModel).toBe("remove-bg-from-config");
  });

  it("serves the configured lip-sync models in order, the tracking range and the caps, and nothing else of the execution", async () => {
    const res = await createApp().request("/api/v1/canvas/limits", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.lipSync).toEqual({
      models: [
        { name: "lipsync-first", minDurationSeconds: 1.5, maxDurationSeconds: 300 },
        { name: "lipsync-second", minDurationSeconds: 2, maxDurationSeconds: 15 },
      ],
      tracking: { minDurationSeconds: 0.5, maxDurationSeconds: 600 },
      maxPeople: 3,
      maxDialogues: 7,
    });
  });

  // Frames-split design §10.7: the panel refuses more outputs than one run creates before it makes any node.
  it("serves each configured tool's max_outputs", async () => {
    const res = await createApp().request("/api/v1/canvas/limits", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { maxOutputs?: Record<string, number> } };
    expect(body.data.maxOutputs?.["video.split"]).toBe(9);
  });

  it("says lip-sync is not offered when the deployment configures none", async () => {
    lipSyncHolder.execution = undefined;
    const res = await createApp().request("/api/v1/canvas/limits", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty("lipSync", null);
  });
});
