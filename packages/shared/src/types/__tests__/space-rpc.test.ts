// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import {
  SpaceRpcRequestSchema,
  SpaceRpcResponseSchema,
  MessagesClearPayloadSchema,
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

  it("parses space:delete / lock / restore / messages:clear", () => {
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
    SpaceRpcRequestSchema.parse({
      id: "r5",
      type: "messages:clear",
      payload: { all: true },
    });
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

describe("MessagesClearPayloadSchema — exactly-one constraint", () => {
  it("accepts ids only", () => {
    expect(
      MessagesClearPayloadSchema.safeParse({ ids: ["m1", "m2"] }).success,
    ).toBe(true);
  });

  it("accepts olderThanMs only", () => {
    expect(
      MessagesClearPayloadSchema.safeParse({ olderThanMs: 1000 }).success,
    ).toBe(true);
  });

  it("accepts all=true only", () => {
    expect(MessagesClearPayloadSchema.safeParse({ all: true }).success).toBe(
      true,
    );
  });

  it("rejects empty payload (none set)", () => {
    expect(MessagesClearPayloadSchema.safeParse({}).success).toBe(false);
  });

  it("rejects multiple branches set", () => {
    expect(
      MessagesClearPayloadSchema.safeParse({ all: true, ids: ["x"] }).success,
    ).toBe(false);
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
      error: { code: "FORBIDDEN", message: "view role cannot create Space" },
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
