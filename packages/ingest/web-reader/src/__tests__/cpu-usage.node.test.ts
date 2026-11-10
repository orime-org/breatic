// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";

import { cpuUsecOf } from "../cpu-usage.js";

/** A cgroup v2 `cpu.stat` as a container reads it. */
const SAMPLE = [
  "usage_usec 8261487",
  "user_usec 5312069",
  "system_usec 2949418",
  "nr_periods 0",
  "nr_throttled 0",
  "throttled_usec 0",
  "nr_bursts 0",
  "burst_usec 0",
  "",
].join("\n");

describe("cpuUsecOf", () => {
  it("reads usage_usec out of a real cpu.stat", () => {
    expect(cpuUsecOf(SAMPLE)).toBe(8261487);
  });

  it("does not take user_usec or system_usec for usage_usec when that line is missing", () => {
    expect(cpuUsecOf("user_usec 5312069\nsystem_usec 2949418\n")).toBeNull();
  });

  it("answers null for an empty file", () => {
    expect(cpuUsecOf("")).toBeNull();
  });

  it("answers null when usage_usec holds no number", () => {
    expect(cpuUsecOf("usage_usec abc\nuser_usec 5312069\n")).toBeNull();
  });

  it("answers null for text that is not a cpu.stat at all", () => {
    expect(cpuUsecOf("<html>not found</html>")).toBeNull();
  });
});
