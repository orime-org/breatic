// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The plan skills name the modes the panel offers (#269).
 *
 * Two answers about "which video modes can be generated" reach a reader: the
 * picker draws one, and `generate_video_plan` quotes the other. A hardcoded
 * list here is a second place to remember when a mode is added, and it had
 * already drifted by three modes.
 */

import { IMAGE_GENERATION_MODES, VIDEO_GENERATION_MODES } from "@breatic/shared";
import { describe, it, expect } from "vitest";

import { IMAGE_PLAN_MODES, VIDEO_PLAN_MODES } from "../skills-loader.js";

describe("the modes a plan skill offers", () => {
  it("are the modes the video panel offers", () => {
    expect([...VIDEO_PLAN_MODES].sort()).toEqual([...VIDEO_GENERATION_MODES].sort());
  });

  it("are the modes the image panel offers", () => {
    expect([...IMAGE_PLAN_MODES].sort()).toEqual([...IMAGE_GENERATION_MODES].sort());
  });
});
