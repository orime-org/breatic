// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";

import { getMiniToolsConfig, miniToolsConfigSchema } from "@core/config/mini-tools.js";
import { workerConcurrencyFor } from "@core/config/worker.js";

describe("getMiniToolsConfig", () => {
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
      ].sort(),
    );
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
