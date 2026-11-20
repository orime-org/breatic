// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { tellConnectionsApart } from "@shared/agent-connection-label.js";

const at = "2026-11-03T08:00:00.000Z";

describe("tellConnectionsApart (#1488 design 19.2)", () => {
  it("adds nothing to a name that is the owner's only one", () => {
    const told = tellConnectionsApart([
      { id: "a", displayName: "Claude Code", createdAt: at },
      { id: "b", displayName: "Cursor", createdAt: at, tokenPrefix: "brt_7f3a" },
    ]);
    expect(told.get("a")).toBeNull();
    expect(told.get("b")).toBeNull();
  });

  it("tells same-named connections apart by token prefix, or by when OAuth first connected", () => {
    const told = tellConnectionsApart([
      { id: "a", displayName: "Claude Code", createdAt: at },
      { id: "b", displayName: "Claude Code", createdAt: at, tokenPrefix: "brt_7f3a" },
    ]);
    expect(told.get("a")).toEqual({ kind: "since", at });
    expect(told.get("b")).toEqual({ kind: "token", prefix: "brt_7f3a" });
  });

  it("falls back to the date for a token whose prefix is unknown or empty", () => {
    const told = tellConnectionsApart([
      { id: "a", displayName: "Harness", createdAt: at },
      { id: "b", displayName: "Harness", createdAt: at, tokenPrefix: "" },
      { id: "c", displayName: "Harness", createdAt: at, tokenPrefix: "brt_1234" },
    ]);
    expect(told.get("a")).toEqual({ kind: "since", at });
    expect(told.get("b")).toEqual({ kind: "since", at });
  });
});
