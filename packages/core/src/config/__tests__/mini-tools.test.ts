// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

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
    // 600 s of 48 kHz stereo peaks at about 650 MB in Chromium (inner#1305 §4.4).
    expect(parsed.waveform_max_seconds).toBe(600);
    expect(parsed.waveform_max_bytes).toBe(200_000_000);
    // How often, and for how long, an open cut band reads peaks not yet written.
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
