// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one reading of a turn's keys (inner#1953) the chat route admits a turn by and the turn runs on: a key that cannot
 * be read is a failure the turn reports on its own stream, never a thrown error, for a new turn and a resumed one alike.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ resolveKeys: vi.fn(), keysById: vi.fn(), keyOwnerOf: vi.fn() }));

vi.mock("@breatic/domain", () => ({ resolveKeys: h.resolveKeys, keysById: h.keysById, keyOwnerOf: h.keyOwnerOf }));

import { ON_OUR_KEYS, turnKeysOf } from "@server/agent/turn-keys.js";

const ACCOUNT = { owner: "account", keyOf: () => "acct" };
const broken = new Error("the seal does not open");

beforeEach(() => {
  vi.resetAllMocks();
  h.keyOwnerOf.mockResolvedValue("admin-1");
});

describe("turnKeysOf", () => {
  it("runs a new turn on the payer's key row, naming its owner", async () => {
    h.resolveKeys.mockResolvedValue({ keys: ACCOUNT, route: { mode: "default" }, keyId: "row-1", payerUserId: "admin-1" });
    expect(await turnKeysOf("p1")).toEqual({ keys: ACCOUNT, keyId: "row-1", keyOwner: "admin-1" });
  });

  it("runs a new turn on our keys when the payer holds none", async () => {
    h.resolveKeys.mockResolvedValue({ keys: { owner: "deployment" }, route: { mode: "default" }, keyId: null, payerUserId: null });
    expect(await turnKeysOf("p1")).toBe(ON_OUR_KEYS);
  });

  it("answers a new turn's unreadable key as a failure, not a throw", async () => {
    h.resolveKeys.mockRejectedValue(broken);
    expect(await turnKeysOf("p1")).toEqual({ failed: broken });
  });

  it("runs a resumed turn on the row its paused segment recorded, and on ours when it recorded none", async () => {
    h.keysById.mockResolvedValue({ keys: ACCOUNT });
    expect(await turnKeysOf("p1", { keyId: "row-1" })).toEqual({ keys: ACCOUNT, keyId: "row-1", keyOwner: "admin-1" });
    expect(await turnKeysOf("p1", { keyId: undefined })).toBe(ON_OUR_KEYS);
    expect(h.resolveKeys).not.toHaveBeenCalled();
  });

  it("answers a resumed turn's gone row as a failure that still names whose it was", async () => {
    h.keysById.mockRejectedValue(broken);
    expect(await turnKeysOf("p1", { keyId: "row-1" })).toEqual({ failed: broken, keyOwner: "admin-1" });
  });
});
