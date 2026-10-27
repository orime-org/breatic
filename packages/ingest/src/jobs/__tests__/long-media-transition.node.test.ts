// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { transitionLongMediaJob, type LongMediaJobState } from "@ingest/jobs/long-media-transition.js";

const DEADLINE = 10_000;

/** A job in the supplied state. */
function at(phase: LongMediaJobState["phase"], activeContainer = false): LongMediaJobState {
  return { phase, version: 0, deadlineAt: DEADLINE, terminalIntent: null, activeContainer };
}

describe("long media job transitions", () => {
  it("starts probing and advances to planning only before the absolute deadline", () => {
    const probing = transitionLongMediaJob(at("accepted"), { type: "start" }, DEADLINE - 1);
    expect(probing.state?.phase).toBe("probing");
    expect(probing.effects).toEqual(["startProbe"]);
    expect(transitionLongMediaJob(probing.state, { type: "probeOk" }, DEADLINE - 1).state?.phase).toBe("planning");
  });

  it("moves through plan acknowledgement, Node work, and a sealed complete manifest", () => {
    const planning = at("planning");
    expect(transitionLongMediaJob(planning, { type: "planAck", hasRunnableSegments: true }, 1)).toMatchObject({
      state: { phase: "running" },
      effects: ["startMediaAttempt"],
    });
    expect(transitionLongMediaJob(planning, { type: "planAck", hasRunnableSegments: false }, 1).effects).toEqual([]);
    expect(transitionLongMediaJob(at("probing"), { type: "containerStarted" }, 1).state?.activeContainer).toBe(true);
    expect(transitionLongMediaJob(at("running", true), { type: "needNode" }, 1)).toMatchObject({
      state: { phase: "planning", activeContainer: true },
      effects: ["stopContainer"],
    });
    expect(transitionLongMediaJob(planning, { type: "seal", complete: false }, 1).state?.phase).toBe("planning");
    expect(transitionLongMediaJob(planning, { type: "seal", complete: true }, 1).state?.phase).toBe("done");
  });

  it("keeps terminal intent until the active container has stopped", () => {
    const stopping = transitionLongMediaJob(at("running", true), { type: "cancel" }, 1);
    expect(stopping).toMatchObject({
      state: { phase: "stopping", terminalIntent: "cancelled", activeContainer: true },
      effects: ["revokePermits", "stopContainer"],
    });
    expect(transitionLongMediaJob(stopping.state, { type: "stopped" }, 2).state?.phase).toBe("cancelled");
  });

  it("expires at the immutable deadline and records the terminal reason", () => {
    const expiring = transitionLongMediaJob(at("planning"), { type: "deadline" }, DEADLINE);
    expect(expiring.state).toMatchObject({
      phase: "stopping",
      terminalIntent: "expired",
    });
    expect(transitionLongMediaJob(expiring.state, { type: "stopped" }, DEADLINE).state?.phase).toBe("expired");
    expect(transitionLongMediaJob(at("running", true), { type: "stopped" }, DEADLINE).state).toMatchObject({
      phase: "expired",
      activeContainer: false,
    });
    expect(transitionLongMediaJob(at("running", true), { type: "fatal" }, 1).state?.phase).toBe("stopping");
  });

  it("ignores stale events and refuses impossible transitions", () => {
    expect(transitionLongMediaJob(at("accepted"), { type: "probeOk" }, 1).state?.phase).toBe("accepted");
    expect(transitionLongMediaJob(at("done"), { type: "cancel" }, 1).state?.phase).toBe("done");
    const stopping = { ...at("stopping", true), terminalIntent: "cancelled" as const };
    expect(transitionLongMediaJob(stopping, { type: "cancel" }, 1)).toMatchObject({
      state: stopping,
      effects: ["stopContainer"],
    });
  });
});
