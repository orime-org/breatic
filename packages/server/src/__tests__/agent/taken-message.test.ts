// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { takenMessageOf } from "@server/agent/taken-message.js";

describe("a queued message as the turn reads it", () => {
  it("keeps every Space field it was sent with, the count of Spaces left off the list included", () => {
    const spaces = [{ id: "s1", name: "One", kind: "canvas" as const }];
    const taken = takenMessageOf({
      id: "m1",
      sentAt: "2026-11-13T00:00:00.000Z",
      userId: "u1",
      acceptLanguage: "en",
      message: "which Spaces are there",
      attached_chips: [],
      spaces,
      spaces_total: 300,
    });
    expect(taken.space).toEqual({ spaces, spaces_total: 300 });
  });
});
