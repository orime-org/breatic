// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { MINI_TOOL_JOB_MAX_EXTRA_INPUTS } from "@breatic/shared";

import { getMiniToolsConfig, miniToolsConfigSchema } from "@core/config/mini-tools.js";

describe("getMiniToolsConfig", () => {
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
