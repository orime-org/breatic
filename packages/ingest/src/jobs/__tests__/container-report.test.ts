// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { readContainerReport } from "@ingest/jobs/container-report.js";

describe("readContainerReport", () => {
  it("reads a finished run", () => {
    expect(readContainerReport({ ok: true, cpuUsec: 12, media: {} })).toEqual({
      ok: true,
      cpuUsec: 12,
      media: {},
    });
  });

  // §8.3: denoise on a silent video says why it failed.
  it("keeps the cause a failed run names", () => {
    expect(readContainerReport({ ok: false, cpuUsec: null, media: {}, reason: "no_audio_track" })?.reason).toBe(
      "no_audio_track",
    );
  });

  // A source the container could not read through is our failure, not the file's.
  it("keeps internal as the cause of a source that did not arrive", () => {
    expect(readContainerReport({ ok: false, cpuUsec: null, media: {}, reason: "internal" })?.reason).toBe("internal");
  });

  it("drops a cause it does not know, leaving the failure unnamed", () => {
    const read = readContainerReport({ ok: false, cpuUsec: null, media: {}, reason: "disk_full" });
    expect(read).not.toBeNull();
    expect(read).not.toHaveProperty("reason");
  });

  it("refuses a body without ok", () => {
    expect(readContainerReport({ cpuUsec: 1 })).toBeNull();
    expect(readContainerReport(null)).toBeNull();
  });
});
