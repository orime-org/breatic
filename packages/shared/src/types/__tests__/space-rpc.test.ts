// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import {
  SpaceRpcRequestSchema,
  SpaceRpcResponseSchema,
  ProjectMessageEntrySchema,
} from "../space-rpc.js";

describe("SpaceRpcRequestSchema — discriminated union", () => {
  it("parses a well-formed space:create request", () => {
    const req = SpaceRpcRequestSchema.parse({
      id: "req-1",
      type: "space:create",
      payload: { spaceId: "sp-1", type: "canvas", name: "Main" },
    });
    expect(req.type).toBe("space:create");
    if (req.type === "space:create") {
      expect(req.payload.spaceId).toBe("sp-1");
    }
  });

  it("parses space:delete / lock / restore", () => {
    SpaceRpcRequestSchema.parse({
      id: "r2",
      type: "space:delete",
      payload: { spaceId: "sp-1" },
    });
    SpaceRpcRequestSchema.parse({
      id: "r3",
      type: "space:lock",
      payload: { spaceId: "sp-1", locked: true },
    });
    SpaceRpcRequestSchema.parse({
      id: "r4",
      type: "space:restore",
      payload: { spaceId: "sp-1" },
    });
  });

  it("rejects the retired messages:clear type (activity feed ADR 2026-07-04)", () => {
    // The feed moved to the append-only PG activity table; the
    // destructive clear arm was removed with it. Locked in so the arm
    // cannot quietly return.
    const r = SpaceRpcRequestSchema.safeParse({
      id: "r5",
      type: "messages:clear",
      payload: { all: true },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown rpc type", () => {
    const r = SpaceRpcRequestSchema.safeParse({
      id: "r1",
      type: "space:explode",
      payload: { spaceId: "sp-1" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty id", () => {
    const r = SpaceRpcRequestSchema.safeParse({
      id: "",
      type: "space:delete",
      payload: { spaceId: "sp-1" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects space:create with invalid SpaceType", () => {
    const r = SpaceRpcRequestSchema.safeParse({
      id: "r",
      type: "space:create",
      payload: { spaceId: "sp-1", type: "voxel", name: "x" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects space:create with empty name", () => {
    const r = SpaceRpcRequestSchema.safeParse({
      id: "r",
      type: "space:create",
      payload: { spaceId: "sp-1", type: "canvas", name: "" },
    });
    expect(r.success).toBe(false);
  });
});

describe("SpaceRpcResponseSchema", () => {
  it("parses success response with result", () => {
    const r = SpaceRpcResponseSchema.parse({
      id: "r1",
      ok: true,
      result: { spaceId: "sp-1", type: "canvas", name: "Main" },
    });
    expect(r.ok).toBe(true);
  });

  it("parses success response without result (delete / lock)", () => {
    const r = SpaceRpcResponseSchema.parse({ id: "r1", ok: true });
    expect(r.ok).toBe(true);
  });

  it("parses error response", () => {
    const r = SpaceRpcResponseSchema.parse({
      id: "r1",
      ok: false,
      error: { code: "FORBIDDEN", message: "viewer role cannot create Space" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("FORBIDDEN");
  });

  it("rejects unknown error code", () => {
    const r = SpaceRpcResponseSchema.safeParse({
      id: "r1",
      ok: false,
      error: { code: "OH_NO", message: "x" },
    });
    expect(r.success).toBe(false);
  });
});

describe("ProjectMessageEntrySchema", () => {
  it("parses missing-node entry", () => {
    ProjectMessageEntrySchema.parse({
      id: "m1",
      kind: "missing-node",
      message: "project_message.missing_node.no_actor",
      context: { nodeId: "n-1" },
      createdAt: Date.now(),
    });
  });

  it("parses space-deleted entry with spaceName snapshot", () => {
    ProjectMessageEntrySchema.parse({
      id: "m2",
      kind: "space-deleted",
      actor: "user-1",
      spaceId: "sp-1",
      spaceName: "Main canvas",
      createdAt: Date.now(),
    });
  });

  it("rejects entry with unknown kind", () => {
    const r = ProjectMessageEntrySchema.safeParse({
      id: "m3",
      kind: "explosion",
      createdAt: 1,
    });
    expect(r.success).toBe(false);
  });
});
