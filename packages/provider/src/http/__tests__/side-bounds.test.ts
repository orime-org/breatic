// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { SIDE_REQUEST_MS, sideBounds } from "../request.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the bounds of a side request", () => {
  it("ends SIDE_REQUEST_MS from now, or at the call's deadline when that comes sooner, and keeps the call's signal", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const signal = new AbortController().signal;
    expect(sideBounds()).toEqual({ deadlineAt: 1_000 + SIDE_REQUEST_MS });
    expect(sideBounds({ deadlineAt: 1_000_000 })).toEqual({ deadlineAt: 1_000 + SIDE_REQUEST_MS });
    expect(sideBounds({ deadlineAt: 5_000, signal })).toEqual({ deadlineAt: 5_000, signal });
  });
});
