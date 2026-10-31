// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { transitionLongMediaAttempt, type LongMediaAttemptState } from "@ingest/jobs/long-media-attempt.js";

const queued: LongMediaAttemptState = { attemptId: "attempt-1", epoch: 1, phase: "queued" };

describe("transitionLongMediaAttempt", () => {
  it("persists start intent before the attempt can be accepted", () => {
    expect(transitionLongMediaAttempt(queued, { type: "start" })).toEqual({
      state: { ...queued, phase: "starting" },
      effects: ["start"],
    });
  });

  it("rejects reports from another epoch", () => {
    expect(transitionLongMediaAttempt(queued, { type: "accepted", epoch: 0, attemptId: "attempt-1" })).toEqual({
      state: queued,
      effects: [],
    });
  });

  it("marks the attempt running only after its start receipt", () => {
    const starting = transitionLongMediaAttempt(queued, { type: "start" }).state;
    expect(transitionLongMediaAttempt(starting, { type: "accepted", epoch: 1, attemptId: "attempt-1" }).state.phase)
      .toBe("running");
  });

  it("stops a queued attempt without creating a container", () => {
    expect(transitionLongMediaAttempt(queued, { type: "stop" })).toEqual({
      state: { ...queued, phase: "stopped" },
      effects: [],
    });
  });

  it("persists stopping before asking Cloudflare to destroy the active instance", () => {
    const running: LongMediaAttemptState = { ...queued, phase: "running" };
    expect(transitionLongMediaAttempt(running, { type: "stop" })).toEqual({
      state: { ...running, phase: "stopping" },
      effects: ["destroy"],
    });
  });

  it("records the observed platform state during recovery", () => {
    const starting: LongMediaAttemptState = { ...queued, phase: "starting" };
    expect(transitionLongMediaAttempt(starting, { type: "recover", running: true })).toEqual({
      state: { ...starting, phase: "running" },
      effects: [],
    });
    expect(transitionLongMediaAttempt(starting, { type: "recover", running: false }).state.phase).toBe("lost");
  });

  it("keeps checkpoints from stale attempts from changing attempt state", () => {
    const running: LongMediaAttemptState = { ...queued, phase: "running" };
    expect(transitionLongMediaAttempt(running, { type: "checkpoint", epoch: 0, attemptId: "attempt-1" }).state)
      .toEqual(running);
    expect(transitionLongMediaAttempt(running, { type: "checkpoint", epoch: 1, attemptId: "attempt-1" }).state)
      .toEqual(running);
  });

  it("destroys a matching failed active attempt and records its gone receipt", () => {
    const running: LongMediaAttemptState = { ...queued, phase: "running" };
    const stopping = transitionLongMediaAttempt(running, { type: "failure", epoch: 1, attemptId: "attempt-1" });
    expect(stopping).toEqual({ state: { ...running, phase: "stopping" }, effects: ["destroy"] });
    expect(transitionLongMediaAttempt(stopping.state, { type: "gone", epoch: 1, attemptId: "attempt-1" }).state.phase)
      .toBe("stopped");
  });

  it("starts a fresh epoch only after a previous attempt is stopped or lost", () => {
    const lost: LongMediaAttemptState = { ...queued, phase: "lost" };
    expect(transitionLongMediaAttempt(lost, {
      type: "restart", epoch: 2, attemptId: "attempt-2", jobLive: true,
    }).state).toEqual({ phase: "queued", epoch: 2, attemptId: "attempt-2" });
    expect(transitionLongMediaAttempt(lost, {
      type: "restart", epoch: 2, attemptId: "attempt-2", jobLive: false,
    }).state).toEqual(lost);
  });
});
