// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import {
  encodeActivityCursor,
  decodeActivityCursor,
} from "@core/activity/project-activities.repo.js";

describe("activity keyset cursor", () => {
  it("round-trips (createdAt, id) through encode/decode", () => {
    const createdAt = new Date("2026-07-04T03:00:00.000Z");
    const id = "0b8f8a52-9f1c-4f6e-9a52-1c2d3e4f5a6b";
    const cursor = encodeActivityCursor(createdAt, id);
    const decoded = decodeActivityCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded?.createdAt.getTime()).toBe(createdAt.getTime());
    expect(decoded?.id).toBe(id);
  });

  it("cursor is opaque (no raw timestamp or uuid visible)", () => {
    const cursor = encodeActivityCursor(
      new Date(1780900000000),
      "0b8f8a52-9f1c-4f6e-9a52-1c2d3e4f5a6b",
    );
    expect(cursor).not.toContain("0b8f8a52");
    expect(cursor).not.toContain("1780900000000");
  });

  it("decode returns null for garbage instead of throwing (falls back to first page)", () => {
    expect(decodeActivityCursor("not-base64!!!")).toBeNull();
    expect(decodeActivityCursor("")).toBeNull();
    // valid base64 but wrong shape
    expect(
      decodeActivityCursor(Buffer.from('{"x":1}').toString("base64url")),
    ).toBeNull();
    // wrong types inside
    expect(
      decodeActivityCursor(
        Buffer.from('{"c":"nope","i":42}').toString("base64url"),
      ),
    ).toBeNull();
  });
});
