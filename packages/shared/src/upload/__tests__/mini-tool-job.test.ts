// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The container job request as the ingest Worker reads it: a join job
 * (inner#1825) carries the clips after its input under `extra`, as many as
 * `MINI_TOOL_JOB_MAX_EXTRA_INPUTS`.
 */

import { describe, expect, it } from "vitest";

import { MINI_TOOL_JOB_MAX_EXTRA_INPUTS, miniToolJobRequestSchema } from "@shared/upload/mini-tool-job.js";

const JOB = {
  jobId: "job-1",
  containerClass: "MiniToolContainerStd4",
  deadlineAt: 1_900_000_000_000,
  op: "join",
  params: { crossfade: 0 },
  input: { storageKey: "assets/clip-0.mp4" },
  outputs: [{ storageKey: "assets/joined.mp4", contentType: "video/mp4" }],
};

/**
 * That many extra inputs, each its own key.
 * @param count - How many.
 * @returns The list.
 */
const extras = (count: number): Array<{ storageKey: string }> =>
  Array.from({ length: count }, (_, i) => ({ storageKey: `assets/clip-${String(i + 1)}.mp4` }));

describe("mini-tool job request, extra inputs (inner#1825)", () => {
  it("caps the extra inputs at a whole number of at least one", () => {
    expect(Number.isInteger(MINI_TOOL_JOB_MAX_EXTRA_INPUTS)).toBe(true);
    expect(MINI_TOOL_JOB_MAX_EXTRA_INPUTS).toBeGreaterThanOrEqual(1);
  });

  it("takes a join job with its clips after the input, in order, up to the cap", () => {
    const parsed = miniToolJobRequestSchema.safeParse({ ...JOB, extra: extras(MINI_TOOL_JOB_MAX_EXTRA_INPUTS) });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.extra).toEqual(extras(MINI_TOOL_JOB_MAX_EXTRA_INPUTS));
    // A job queued before the join shipped carries no extra inputs and still reads.
    expect(miniToolJobRequestSchema.safeParse({ ...JOB, op: "cut", params: {} }).success).toBe(true);
  });

  it("takes an audio join job", () => {
    const parsed = miniToolJobRequestSchema.safeParse({ ...JOB, op: "audio_join", extra: extras(2) });
    expect(parsed.success).toBe(true);
  });

  it("refuses one extra input past the cap", () => {
    expect(Number.isInteger(MINI_TOOL_JOB_MAX_EXTRA_INPUTS)).toBe(true);
    expect(miniToolJobRequestSchema.safeParse({ ...JOB, extra: extras(MINI_TOOL_JOB_MAX_EXTRA_INPUTS + 1) }).success).toBe(false);
  });
});
