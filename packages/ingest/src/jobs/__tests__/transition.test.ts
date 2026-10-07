// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";

import { transition, type JobState } from "@ingest/jobs/transition.js";

const OUTPUTS = ["out/a.mp4"];

/**
 * A job in the given phase.
 * @param phase - Which phase.
 * @param written - Main outputs already written.
 * @returns The state.
 */
function at(phase: JobState["phase"], written: string[] = []): JobState {
  return { phase, attemptId: "att-1", outputs: OUTPUTS, written, startedAt: 1_000, endedAt: null, reason: null };
}

describe("job transition", () => {
  it("records a main output written while the job is still starting", () => {
    const next = transition(at("starting"), { type: "written", key: "out/a.mp4" }, 2_000);
    expect(next.state?.written).toEqual(["out/a.mp4"]);
    expect(next.state?.phase).toBe("starting");
  });

  it("finishes as done when every main output is written, ending the clock at destroy", () => {
    const next = transition(at("running", ["out/a.mp4"]), { type: "reported", ok: true }, 9_000);
    expect(next.state?.phase).toBe("done");
    expect(next.state?.endedAt).toBe(9_000);
    expect(next.effects).toEqual(["destroy", "cancelSchedule"]);
  });

  it("fails a completion report that arrives before every main output is written", () => {
    const next = transition(at("running"), { type: "reported", ok: true }, 9_000);
    expect(next.state?.phase).toBe("failed");
    expect(next.state?.reason).toBe("tool_failed");
  });

  it("keeps the cause a failed report names, and calls an unnamed failure tool_failed", () => {
    const named = transition(at("running"), { type: "reported", ok: false, reason: "no_audio_track" }, 9_000);
    expect(named.state?.phase).toBe("failed");
    expect(named.state?.reason).toBe("no_audio_track");
    expect(transition(at("running"), { type: "reported", ok: false }, 9_000).state?.reason).toBe("tool_failed");
  });

  it("finishes a report that lands while still starting the same way as while running", () => {
    const next = transition(at("starting", ["out/a.mp4"]), { type: "reported", ok: true }, 9_000);
    expect(next.state?.phase).toBe("done");
  });

  it("ignores a stop event in starting and in no state at all", () => {
    expect(transition(at("starting"), { type: "stopped" }, 5_000).state?.phase).toBe("starting");
    expect(transition(null, { type: "stopped" }, 5_000).state).toBeNull();
  });

  it("fails a running job whose container stopped", () => {
    const next = transition(at("running"), { type: "stopped" }, 5_000);
    expect(next.state?.phase).toBe("failed");
    expect(next.state?.endedAt).toBe(5_000);
  });

  it("fails a running job when a poll finds no container running", () => {
    const next = transition(at("running"), { type: "containerGone" }, 6_000);
    expect(next.state?.phase).toBe("failed");
  });

  it("expires only the attempt the schedule was set for", () => {
    expect(transition(at("running"), { type: "expired", attemptId: "att-0" }, 7_000).state?.phase).toBe("running");
    expect(transition(at("running"), { type: "expired", attemptId: "att-1" }, 7_000).state?.phase).toBe("failed");
  });

  it("clears the job when the start fails, so a resubmission starts afresh", () => {
    const next = transition(at("starting"), { type: "startFailed" }, 3_000);
    expect(next.state).toBeNull();
    expect(next.effects).toEqual(["destroy", "clearOverrides", "cancelSchedule"]);
  });

  it("ignores everything after a terminal state", () => {
    const done = { ...at("done", OUTPUTS), endedAt: 9_000 };
    expect(transition(done, { type: "stopped" }, 10_000).state).toEqual(done);
    expect(transition(done, { type: "reported", ok: false }, 10_000).state).toEqual(done);
    expect(transition(done, { type: "startFailed" }, 10_000).state).toEqual(done);
  });
});
