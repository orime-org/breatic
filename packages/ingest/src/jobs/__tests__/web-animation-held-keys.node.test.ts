// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1953: the keys a web-animation job's model calls run on are held in the Durable Object's memory only while the
 * job runs: from a submit that leaves it running until the transition that destroys it, and never across a restart.
 */

import { describe, expect, it } from "vitest";

import { HeldKeys } from "@ingest/jobs/web-animation-held-keys.js";

const KEYS = { openrouter: "sk-or-held" };

describe("the keys a web-animation job holds", () => {
  it("holds the keys a submit carried while the job runs", () => {
    const held = new HeldKeys();
    held.afterSubmit("running", KEYS);
    expect(held.current()).toEqual(KEYS);
  });

  it.each(["done", "failed", "cancelled", "stopping", "cancelled_before_submit", undefined] as const)("holds nothing from a submit that leaves the job %s", (state) => {
    const held = new HeldKeys();
    held.afterSubmit(state, KEYS);
    expect(held.current()).toBeNull();
  });

  it("drops the keys on the transition that destroys the job, and keeps them through any other", () => {
    const held = new HeldKeys();
    held.afterSubmit("running", KEYS);
    held.afterEffects(["scheduleDrain"]);
    expect(held.current()).toEqual(KEYS);
    held.afterEffects(["destroy"]);
    expect(held.current()).toBeNull();
  });

  it("starts empty, as after the object restarts", () => {
    expect(new HeldKeys().current()).toBeNull();
  });
});
