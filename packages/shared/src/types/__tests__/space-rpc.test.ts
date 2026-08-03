// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import {
  SpaceRpcRequestSchema,
  SpaceRpcResponseSchema,
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

// ── Task #27: the server mints Space ids, the client sends a claim token ──
//
// A client-chosen spaceId let a client re-submit the id of a Space that had
// been deleted: the server's "is this id taken" check looks at meta.spaces,
// and a deleted Space is no longer there, so it passed. The id now comes from
// the server, and the client sends a token instead — it identifies which
// machine asked, and nothing else. The server stores and echoes it without
// parsing it.

/** A well-formed uuid v4, used as the claim token in the cases below. */
const CLAIM_TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("SpaceRpcRequestSchema — server-minted ids and the claim token", () => {
  it("refuses a space:create that carries a spaceId", () => {
    // The whole point of moving id minting to the server is that a client
    // cannot name the Space it is creating. Accepting the field would leave
    // the old path open even if the handler ignored it.
    const r = SpaceRpcRequestSchema.safeParse({
      id: "r",
      type: "space:create",
      payload: {
        spaceId: "sp-1",
        type: "canvas",
        name: "Main",
        claimToken: CLAIM_TOKEN,
      },
    });
    expect(r.success).toBe(false);
  });

  it("parses a space:create carrying only type, name and claimToken", () => {
    const req = SpaceRpcRequestSchema.parse({
      id: "r",
      type: "space:create",
      payload: { type: "canvas", name: "Main", claimToken: CLAIM_TOKEN },
    });
    expect(req.type).toBe("space:create");
    if (req.type === "space:create") {
      expect(req.payload.claimToken).toBe(CLAIM_TOKEN);
    }
  });

  it("refuses a space:create with no claimToken", () => {
    const r = SpaceRpcRequestSchema.safeParse({
      id: "r",
      type: "space:create",
      payload: { type: "canvas", name: "Main" },
    });
    expect(r.success).toBe(false);
  });

  it("refuses a claimToken that is not a uuid v4", () => {
    // The token is written into a permanently shared document and travels
    // into the delete snapshot, so its shape is pinned. v1 carries a MAC
    // address and a timestamp; it is a uuid but not the one we accept.
    for (const bad of [
      "2c5ea4c0-4067-11e9-8bad-9b1deb4d3b7d", // uuid v1
      "not-a-uuid",
      "",
    ]) {
      const r = SpaceRpcRequestSchema.safeParse({
        id: "r",
        type: "space:create",
        payload: { type: "canvas", name: "Main", claimToken: bad },
      });
      expect(r.success, `claimToken ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

// ── Task #27: the open-tab list moves behind RPCs ────────────────────────
//
// It was the one part of the meta doc a client wrote directly, and that
// single exception is why the write gate had to understand which field an
// incoming frame touched. With the exception gone the rule is flat — a
// client never writes the meta doc — and the connection is simply read-only.

describe("SpaceRpcRequestSchema — tab RPCs", () => {
  it("parses tab:open and tab:close", () => {
    const open = SpaceRpcRequestSchema.parse({
      id: "r1",
      type: "tab:open",
      payload: { spaceId: "sp-1" },
    });
    expect(open.type).toBe("tab:open");

    const close = SpaceRpcRequestSchema.parse({
      id: "r2",
      type: "tab:close",
      payload: { spaceId: "sp-1" },
    });
    expect(close.type).toBe("tab:close");
  });

  it("refuses a tab request that names a user", () => {
    // Whose tab bar is being changed comes from the authenticated
    // connection, never from the request body. Refusing the field outright
    // means "change someone else's tabs" cannot even be expressed.
    for (const type of ["tab:open", "tab:close"]) {
      const r = SpaceRpcRequestSchema.safeParse({
        id: "r",
        type,
        payload: { spaceId: "sp-1", userId: "someone-else" },
      });
      expect(r.success, type).toBe(false);
    }
  });
});
