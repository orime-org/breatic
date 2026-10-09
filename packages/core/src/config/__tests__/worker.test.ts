// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import { getUnderstandConfig } from "@core/config/understand.js";
import { getWorkerConfig, workerConcurrencyFor } from "@core/config/worker.js";

// A task waiting on an upstream is back on the queue between questions, so
// the tasks queue holds a worker slot only while it asks (inner#1337).
describe("worker concurrency", () => {
  it("gives the tasks queue the slots config/worker.yaml names for it", () => {
    expect(workerConcurrencyFor("tasks")).toBe(50);
  });

  it("gives every other queue the default", () => {
    expect(workerConcurrencyFor("url-ingest")).toBe(5);
    expect(workerConcurrencyFor("mail")).toBe(5);
  });

  it("has no per-round wait left: an upstream is asked once per pickup", () => {
    expect(getWorkerConfig()).not.toHaveProperty("poll_max_wait");
  });

  it("holds at most five media readings in memory at once", () => {
    expect(getUnderstandConfig().max_concurrent).toBe(5);
  });
});
