// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

describe("complete video tool execution plans", () => {
  it("exports every shared plan entry point", () => {
    expect(["planVideoFrames", "planVideoSplit"].filter((key) => !(key in miniTools))).toEqual([]);
  });
});
