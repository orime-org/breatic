// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import {
  uprightTransition,
  type UprightEvent,
  type UprightState,
} from "@ingest/upright-transition.js";

const MEDIA = { width: 768, height: 1024, durationSeconds: null };

const running: UprightState = { phase: "running", runEnded: false, media: null };
const done: UprightState = { phase: "done", runEnded: false, media: null };
const doneMeasured: UprightState = { phase: "done", runEnded: true, media: MEDIA };
const abandoned: UprightState = { phase: "abandoned", runEnded: false, media: null };

const request: UprightEvent = { type: "request" };
const seal: UprightEvent = { type: "seal" };
const commitAsked: UprightEvent = { type: "commitAsked" };
const landed: UprightEvent = { type: "commitSettled", landed: true };
const notLanded: UprightEvent = { type: "commitSettled", landed: false };
const ranWell: UprightEvent = { type: "runEnded", media: MEDIA };
const ranBadly: UprightEvent = { type: "runEnded", media: null };
const giveUp: UprightEvent = { type: "giveUp" };

describe("uprightTransition — no record", () => {
  it("starts a run on the first request", () => {
    expect(uprightTransition(null, request)).toEqual({ state: running, effects: ["startRun"] });
  });

  it("seals the key so nothing turns it later", () => {
    expect(uprightTransition(null, seal)).toEqual({ state: abandoned, effects: ["logFailure"] });
  });

  it("aborts a commit nothing started", () => {
    expect(uprightTransition(null, commitAsked)).toEqual({ state: null, effects: ["abort"] });
  });

  it.each([landed, notLanded, ranWell, ranBadly, giveUp])("ignores %o", (event) => {
    expect(uprightTransition(null, event)).toEqual({ state: null, effects: [] });
  });
});

describe("uprightTransition — running", () => {
  it("lets a second request wait on the same run", () => {
    expect(uprightTransition(running, request)).toEqual({ state: running, effects: [] });
  });

  it("lets a seal wait on the same run", () => {
    expect(uprightTransition(running, seal)).toEqual({ state: running, effects: [] });
  });

  it("completes the write-back", () => {
    expect(uprightTransition(running, commitAsked)).toEqual({ state: running, effects: ["complete"] });
  });

  it("is done once the write-back landed", () => {
    expect(uprightTransition(running, landed)).toEqual({ state: done, effects: ["wake"] });
  });

  it("gives up when the write-back did not land", () => {
    expect(uprightTransition(running, notLanded)).toEqual({ state: abandoned, effects: ["logFailure", "wake"] });
  });

  it.each([ranWell, ranBadly])("gives up when the run ends without a commit: %o", (event) => {
    expect(uprightTransition(running, event)).toEqual({
      state: { ...abandoned, runEnded: true },
      effects: ["logFailure", "wake"],
    });
  });

  it("gives up when a waiter reaches its deadline", () => {
    expect(uprightTransition(running, giveUp)).toEqual({ state: abandoned, effects: ["logFailure", "wake"] });
  });
});

describe("uprightTransition — done", () => {
  it.each([request, seal, giveUp, landed, notLanded])("stays done on %o", (event) => {
    expect(uprightTransition(done, event)).toEqual({ state: done, effects: [] });
  });

  it("aborts any second commit", () => {
    expect(uprightTransition(done, commitAsked)).toEqual({ state: done, effects: ["abort"] });
  });

  it("keeps what the run measured", () => {
    expect(uprightTransition(done, ranWell)).toEqual({ state: doneMeasured, effects: ["wake"] });
  });

  it("stays done without numbers when the run failed after its commit", () => {
    expect(uprightTransition(done, ranBadly)).toEqual({
      state: { ...done, runEnded: true },
      effects: ["wake"],
    });
  });

  it("does not take a second measurement", () => {
    expect(uprightTransition(doneMeasured, ranWell)).toEqual({ state: doneMeasured, effects: [] });
  });
});

describe("uprightTransition — abandoned", () => {
  it.each([request, seal, giveUp, landed, notLanded, ranWell, ranBadly])("stays abandoned on %o", (event) => {
    expect(uprightTransition(abandoned, event)).toEqual({ state: abandoned, effects: [] });
  });

  it("aborts a commit that arrives late", () => {
    expect(uprightTransition(abandoned, commitAsked)).toEqual({ state: abandoned, effects: ["abort"] });
  });
});
