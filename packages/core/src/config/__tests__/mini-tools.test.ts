// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { MINI_TOOL_JOB_MAX_EXTRA_INPUTS } from "@breatic/shared";

import { getMiniToolsConfig, miniToolsConfigSchema } from "@core/config/mini-tools.js";
import { workerConcurrencyFor } from "@core/config/worker.js";

describe("getMiniToolsConfig", () => {
  // inner#1306 execution design §11.5: the upstream every video mini-tool model call takes, the one its models and recipes
  // were measured on, is a deployment parameter frozen into each run's plan.
  it("names the upstream video mini-tool model calls take, and refuses a config without it", () => {
    expect(getMiniToolsConfig().model_upstream).toBe("wavespeed");
    const { model_upstream: _named, ...rest } = getMiniToolsConfig();
    expect(miniToolsConfigSchema.safeParse(rest).success).toBe(false);
  });

  it("loads and defaults the durable settlement discovery and query settings", () => {
    const expected = { lease_ms: 60000, retry_ms: 30000, lookup_timeout_ms: 15000, discovery_interval_ms: 30000, discovery_page_size: 100 };
    const configured = getMiniToolsConfig() as unknown as Record<string, unknown>;
    expect(configured.settlement).toEqual(expected);
    const bare = structuredClone(configured); delete bare.settlement;
    expect((miniToolsConfigSchema.parse(bare) as unknown as Record<string, unknown>).settlement).toEqual(expected);
    const custom = { lease_ms: 70000, retry_ms: 20000, lookup_timeout_ms: 12000, discovery_interval_ms: 24000, discovery_page_size: 64 };
    expect((miniToolsConfigSchema.parse({ ...bare, settlement: custom }) as unknown as Record<string, unknown>).settlement).toEqual(custom);
  });

  it("uses the existing worker concurrency registry for settlement jobs", () => {
    expect(workerConcurrencyFor("mini-tool-settlement")).toBe(2);
  });
  it("loads and defaults the complete planned-process byte limits", () => {
    const expected = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
    const configured = getMiniToolsConfig() as unknown as Record<string, unknown>;
    expect(configured.plan_limits).toEqual(expected);
    const bare = structuredClone(configured);
    delete bare.plan_limits;
    expect((miniToolsConfigSchema.parse(bare) as unknown as Record<string, unknown>).plan_limits).toEqual(expected);
    const custom = { probeStdoutBytes: 2048, analysisStdoutBytes: 1024, stderrTailBytes: 256 };
    expect((miniToolsConfigSchema.parse({ ...bare, plan_limits: custom }) as unknown as Record<string, unknown>).plan_limits).toEqual(custom);
  });

  it.each([
    { probeStdoutBytes: 0, analysisStdoutBytes: 1024, stderrTailBytes: 256 },
    { probeStdoutBytes: 2048, analysisStdoutBytes: -1, stderrTailBytes: 256 },
    { probeStdoutBytes: 2048, analysisStdoutBytes: 1024, stderrTailBytes: 0.5 },
    { probeStdoutBytes: Number.POSITIVE_INFINITY, analysisStdoutBytes: 1024, stderrTailBytes: 256 },
    { probeStdoutBytes: 2048, analysisStdoutBytes: Number.MAX_SAFE_INTEGER + 1, stderrTailBytes: 256 },
  ])("rejects invalid planned-process byte limits %j", (plan_limits) => {
    expect(miniToolsConfigSchema.safeParse({ ...getMiniToolsConfig(), plan_limits }).success).toBe(false);
  });
  it("requires complete analysis profiles before accepting work", () => {
    const config = structuredClone(getMiniToolsConfig()) as Record<string, unknown>;
    delete config.analyses;
    expect(miniToolsConfigSchema.safeParse(config).success).toBe(false);
  });

  it.each(["people", "scene_cuts", "tracked_mask"])("requires the %s analysis profile", (kind) => {
    const config = structuredClone(getMiniToolsConfig());
    const analyses = config.analyses as Record<string, unknown>;
    delete analyses[kind];
    expect(miniToolsConfigSchema.safeParse(config).success).toBe(false);
  });

  it("loads every container operation from config/mini-tools.yaml", () => {
    const config = getMiniToolsConfig();
    expect(Object.keys(config.ops).sort()).toEqual(
      [
        "adjust",
        "audio_denoise",
        "crop",
        "cut",
        "hdr",
        "speed",
        "stabilize",
        // inner#1305: the ten audio edits.
        "audio_cut",
        "audio_speed",
        "compress",
        "denoise",
        "eq",
        "normalize",
        "pan",
        "pitch",
        "reverb",
        "voice",
        // inner#1825: joining clips, a video's and an audio's.
        "join",
        "audio_join",
      ].sort(),
    );
  });

  // inner#1825 §6.3: joining reads every clip and writes their sum, so it runs on the 20 GB disk.
  it("runs both join operations on MiniToolContainerStd4", () => {
    const ops = getMiniToolsConfig().ops as Record<string, { container_class: string; precheck_seconds: number } | undefined>;
    for (const op of ["join", "audio_join"]) {
      expect(ops[op]?.container_class, op).toBe("MiniToolContainerStd4");
      expect(ops[op]?.precheck_seconds, op).toBeGreaterThan(0);
    }
  });

  // inner#1825 §6.3: the most clips one join takes, source included.
  it("reads join_max_clips, defaulting to 20 when the yaml leaves it out", () => {
    const config = getMiniToolsConfig() as unknown as Record<string, unknown>;
    expect(config.join_max_clips).toBe(20);
    const bare = structuredClone(config);
    delete bare.join_max_clips;
    expect((miniToolsConfigSchema.parse(bare) as unknown as Record<string, unknown>).join_max_clips).toBe(20);
  });

  // inner#1825 §6.4: the job contract carries the source plus at most
  // MINI_TOOL_JOB_MAX_EXTRA_INPUTS clips, and the ingest Worker cannot read the
  // yaml, so a ceiling past the contract must stop the service at start.
  it("refuses a join_max_clips the job contract cannot carry", () => {
    expect(typeof MINI_TOOL_JOB_MAX_EXTRA_INPUTS).toBe("number");
    const config = structuredClone(getMiniToolsConfig()) as Record<string, unknown>;
    expect(miniToolsConfigSchema.safeParse({ ...config, join_max_clips: MINI_TOOL_JOB_MAX_EXTRA_INPUTS + 1 }).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse({ ...config, join_max_clips: MINI_TOOL_JOB_MAX_EXTRA_INPUTS + 2 }).success).toBe(false);
  });

  // inner#1305 §4.4: the cut band's waveform ceilings, with defaults when the yaml leaves them out.
  it("reads the waveform ceilings, and defaults the ones the yaml leaves out", () => {
    const config = getMiniToolsConfig();
    expect(config.waveform_max_seconds).toBeGreaterThan(0);
    expect(config.waveform_max_bytes).toBeGreaterThan(0);
    const bare = structuredClone(config) as Record<string, unknown>;
    delete bare.waveform_max_seconds;
    delete bare.waveform_max_bytes;
    delete bare.waveform_peaks_retry_ms;
    delete bare.waveform_peaks_retry_max_ms;
    const parsed = miniToolsConfigSchema.parse(bare);
    // Decoding 600 s of 48 kHz stereo audio takes Chromium to about 650 MB (inner#1305 §4.4).
    expect(parsed.waveform_max_seconds).toBe(600);
    expect(parsed.waveform_max_bytes).toBe(200_000_000);
    // How often, and for how long, a band past those reads peaks not yet written.
    expect(parsed.waveform_peaks_retry_ms).toBe(5000);
    expect(parsed.waveform_peaks_retry_max_ms).toBe(600_000);
  });

  // How long a run may take is the node task budget; an operation carries no
  // ceiling of its own.
  it("refuses an operation that names its own deadline", () => {
    const config = structuredClone(getMiniToolsConfig()) as Record<string, unknown> & { ops: Record<string, Record<string, unknown>> };
    config.ops.cut = { ...config.ops.cut, job_deadline_ms: 600_000 };
    expect(miniToolsConfigSchema.safeParse(config).success).toBe(false);
  });
});

// inner#1306 §97 D26-2 (frames-split §5.4 待实测 row): the GL render pixel rate of a transition window chunk is configured
// under the MiniToolContainerGl class as `render_pixels_per_second`; the class schema keeps it and refuses a non-positive one.
describe("the GL class's render rate (§97 D26-2)", () => {
  /**
   * The configured snapshot with the GL class carrying a render rate.
   * @param rate - The rate.
   * @returns The config.
   */
  const withRate = (rate: number): Record<string, unknown> & { classes: Record<string, Record<string, unknown>> } => {
    const config = structuredClone(getMiniToolsConfig()) as unknown as Record<string, unknown> & { classes: Record<string, Record<string, unknown>> };
    config.classes.MiniToolContainerGl = { instance_type: "standard-4", vcpu: 4, memory_gib: 12, disk_gb: 20, render_pixels_per_second: rate };
    return config;
  };

  it("GR01 keeps a configured render_pixels_per_second on MiniToolContainerGl", () => {
    const parsed = miniToolsConfigSchema.parse(withRate(123456)) as unknown as { classes: Record<string, Record<string, unknown>> };
    expect(parsed.classes.MiniToolContainerGl).toMatchObject({ instance_type: "standard-4", render_pixels_per_second: 123456 });
  });

  it.each([0, -1])("GR02 refuses a render_pixels_per_second of %s after a valid control", (rate) => {
    expect(miniToolsConfigSchema.safeParse(withRate(123456)).success).toBe(true);
    expect(miniToolsConfigSchema.safeParse(withRate(rate)).success).toBe(false);
  });
});

// The lip-sync composite feathers each face's edge by a fraction of its shorter side (multi-person lip-sync DD §7.2 step 6);
// the fraction is configured under the lip-sync block and frozen into a run's plan at admission.
describe("the lip-sync face feather", () => {
  /**
   * The configured snapshot with the lip-sync block's face feather set, or removed.
   * @param feather - The fraction, or undefined to leave it out.
   * @returns The config.
   */
  const withFeather = (feather: unknown): Record<string, unknown> => {
    const config = structuredClone(getMiniToolsConfig()) as unknown as Record<string, unknown> & { executions: Record<string, Record<string, unknown>> };
    const lipSync = config.executions["video.lip-sync"]!;
    delete lipSync.face_feather;
    if (feather !== undefined) lipSync.face_feather = feather;
    return config;
  };
  /**
   * The parsed face feather.
   * @param config - The config.
   * @returns The lip-sync block's face feather.
   */
  const featherOf = (config: Record<string, unknown>): unknown =>
    (miniToolsConfigSchema.parse(config).executions["video.lip-sync"] as unknown as Record<string, unknown>).face_feather;

  it("LFF01 defaults to a tenth of the face's shorter side and keeps a configured fraction", () => {
    expect(featherOf(withFeather(undefined))).toBe(0.1);
    expect(featherOf(withFeather(0.25))).toBe(0.25);
  });

  it.each([-0.1, 1.5, "0.1"])("LFF02 refuses a face feather of %s", (feather) => {
    expect(miniToolsConfigSchema.safeParse(withFeather(feather)).success).toBe(false);
  });
});
