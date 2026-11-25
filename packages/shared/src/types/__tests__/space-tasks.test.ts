// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from "vitest";
import { SPACE_TASKS_TYPES } from "@shared/types/space-tasks.js";
import * as shared from "@shared/index.js";

describe("SPACE_TASKS_TYPES", () => {
  it("F-01 lists the 3D and Timeline Spaces, whose background work reaches the page through their documents", () => {
    expect([...SPACE_TASKS_TYPES].sort()).toEqual(["3d", "timeline"]);
  });

  it("F-09 leaves no channel builder or signal name for the old Project-channel signal", () => {
    expect(Object.keys(shared)).not.toContain("spaceTasksChangedChannel");
    expect(Object.keys(shared)).not.toContain("SPACE_TASKS_CHANGED_SIGNAL");
  });
});

describe("the old per-Project credits signal", () => {
  it("H-15 leaves no channel builder, the credit-table trigger having replaced it", () => {
    expect(Object.keys(shared)).not.toContain("creditsChangedChannel");
  });
});
