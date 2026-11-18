// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { agentPresenceKey, agentPresenceRecordSchema, parseAgentPresenceKey } from "@shared/agent-presence.js";

describe("agent presence keys", () => {
  it("reads back the user and connection a key was made from", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (userId, connectionId) => {
        expect(parseAgentPresenceKey(agentPresenceKey(userId, connectionId))).toEqual({ userId, connectionId });
      }),
    );
  });

  it("reads a member's own record key as no agent", () => {
    fc.assert(
      fc.property(fc.uuid(), (userId) => {
        expect(parseAgentPresenceKey(userId)).toBeNull();
      }),
    );
  });

  it.each(["", ".agent.", "u.agent.", ".agent.c", "u.agent.c.d", "u.other.c"])("reads %j as no agent", (key) => {
    expect(parseAgentPresenceKey(key)).toBeNull();
  });
});

describe("agent presence records", () => {
  it("accepts a record with a focus and a record that has none yet", () => {
    const base = { id: "u", online: true, lastSeenAt: 1 };
    expect(agentPresenceRecordSchema.safeParse({ ...base, agent: { connectionId: "c", spaceId: "s", focus: ["n1"], focusAt: 1 } }).success).toBe(true);
    expect(agentPresenceRecordSchema.safeParse({ ...base, idle: true, agent: { connectionId: "c", spaceId: null, focus: [], focusAt: null } }).success).toBe(true);
  });

  it("refuses a member's record, which carries no agent", () => {
    expect(agentPresenceRecordSchema.safeParse({ id: "u", online: true, lastSeenAt: 1 }).success).toBe(false);
  });
});
