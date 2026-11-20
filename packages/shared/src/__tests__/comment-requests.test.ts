// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The comment requests a browser sends on a Space document's connection
 * (breatic#1488 §11.9), the per-user signal collab sends when notifications
 * change, and the DB4 set of threads newly handed to a connection (§15.11).
 */

import { describe, expect, it } from "vitest";

import {
  CommentRequestSchema,
  CommentResponseSchema,
  mcpNewAssignmentsKey,
  NOTIFICATIONS_CHANGED_SIGNAL,
  notificationsChangedChannel,
  NotificationsChangedSignalSchema,
} from "@shared/index.js";

const SPACE = "4d1a0d66-ee82-4596-986a-21054cd65490";
const CONNECTION = "6758483e-75bb-4285-84f1-a375438cfb1a";

describe("CommentRequestSchema", () => {
  it("accepts the three requests", () => {
    for (const request of [
      { id: "r1", type: "comment:hand-over", payload: { spaceId: SPACE, threadId: "t1", connectionId: CONNECTION } },
      { id: "r2", type: "comment:cancel-hand-over", payload: { spaceId: SPACE, threadId: "t1" } },
      { id: "r3", type: "comment:mentioned", payload: { spaceId: SPACE, entryId: "e1" } },
    ]) {
      expect(CommentRequestSchema.parse(request)).toEqual(request);
    }
  });

  it("refuses a request of another kind, a connection that is not a uuid and an empty thread", () => {
    expect(CommentRequestSchema.safeParse({ id: "r", type: "space:delete", payload: { spaceId: SPACE } }).success).toBe(false);
    expect(CommentRequestSchema.safeParse({ id: "r", type: "comment:hand-over", payload: { spaceId: SPACE, threadId: "t", connectionId: "x" } }).success).toBe(false);
    expect(CommentRequestSchema.safeParse({ id: "r", type: "comment:cancel-hand-over", payload: { spaceId: SPACE, threadId: "" } }).success).toBe(false);
  });

  it("is not mistaken for a sync confirmation, which shares the connection", () => {
    expect(CommentRequestSchema.safeParse({ id: "r" }).success).toBe(false);
  });
});

describe("CommentResponseSchema", () => {
  it("reads success and each refusal code", () => {
    expect(CommentResponseSchema.parse({ id: "r", ok: true })).toEqual({ id: "r", ok: true });
    for (const code of ["FORBIDDEN", "NOT_FOUND", "CONFLICT", "BUSY", "INTERNAL"]) {
      expect(CommentResponseSchema.parse({ id: "r", ok: false, error: { code, message: "m" } })).toMatchObject({ ok: false, error: { code } });
    }
  });
});

describe("notificationsChangedChannel", () => {
  it("is one deployment-wide channel under the prefix", () => {
    expect(notificationsChangedChannel("dev")).toBe("dev:notifications:changed");
    expect(notificationsChangedChannel("dev-agent")).not.toBe(notificationsChangedChannel("dev"));
  });

  it("tells the browser only that its notifications changed", () => {
    expect(NotificationsChangedSignalSchema.parse({ t: NOTIFICATIONS_CHANGED_SIGNAL })).toEqual({ t: "notifications:changed" });
  });
});

describe("mcpNewAssignmentsKey", () => {
  it("is one set per connection under the prefix", () => {
    expect(mcpNewAssignmentsKey("dev", CONNECTION)).toBe(`dev:mcp:new-assignments:${CONNECTION}`);
  });
});
