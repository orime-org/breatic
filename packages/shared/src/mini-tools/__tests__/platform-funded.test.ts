// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §64.4 SC08 (frames-split design §5.5 配置 row, §10.8 计费 row): who pays is written in code as one
 * shared platform-funded set: the extract-frames and focus-crop tools and the `people` analysis kind. Admission quotes 0,
 * holds nothing and freezes `chargeTo: "platform"` for them; every other tool and analysis kind is charged to the user.
 */

import { describe, expect, it } from "vitest";
import { MINI_TOOLS } from "../tools.js";
import { PLATFORM_FUNDED, miniToolChargeTo } from "../platform-funded.js";

describe("SC08: the platform-funded set decides chargeTo", () => {
  it("SC08: the set is exactly video.extract-frames, video.focus-crop and the people analysis", () => {
    expect([...PLATFORM_FUNDED].sort()).toEqual(["people", "video.extract-frames", "video.focus-crop"]);
  });

  it("SC08: the members are charged to the platform", () => {
    for (const subject of ["video.extract-frames", "video.focus-crop", "people"]) expect(miniToolChargeTo(subject)).toBe("platform");
  });

  it("SC08: every other tool and analysis kind is charged to the user", () => {
    const others = [...MINI_TOOLS.map((tool) => tool.id).filter((id) => id !== "video.extract-frames"), "scene_cuts", "tracked_mask"];
    expect(others).toContain("video.split");
    for (const subject of others) expect(miniToolChargeTo(subject)).toBe("user");
  });
});
