// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { getMiniToolsConfig, miniToolsConfigSchema } from "@core/config/mini-tools.js";

describe("getMiniToolsConfig", () => {
  it("loads every container operation from config/mini-tools.yaml", () => {
    const config = getMiniToolsConfig();
    expect(Object.keys(config.ops).sort()).toEqual(["adjust", "audio_denoise", "crop", "cut", "hdr", "speed", "stabilize"]);
  });

  // How long a run may take is the node task budget; an operation carries no
  // ceiling of its own.
  it("refuses an operation that names its own deadline", () => {
    const config = structuredClone(getMiniToolsConfig()) as Record<string, unknown> & { ops: Record<string, Record<string, unknown>> };
    config.ops.cut = { ...config.ops.cut, job_deadline_ms: 600_000 };
    expect(miniToolsConfigSchema.safeParse(config).success).toBe(false);
  });
});
