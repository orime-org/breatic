// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import {
  encodeActivityCursor,
  decodeActivityCursor,
} from "@core/activity/project-activities.repo.js";

const ID = "0b8f8a52-9f1c-4f6e-9a52-1c2d3e4f5a6b";

describe("activity keyset cursor", () => {
  it("round-trips (createdAt, id) through encode/decode", () => {
    const createdAt = "2026-07-04 03:00:00+00";
    const decoded = decodeActivityCursor(encodeActivityCursor(createdAt, ID));
    expect(decoded).not.toBeNull();
    expect(decoded?.createdAt).toBe(createdAt);
    expect(decoded?.id).toBe(ID);
  });

  it("carries the microseconds the column stores", () => {
    // The whole point of the text form: a Date would round this to `.123`,
    // and the rows between `.123000` and `.123456` would never be paged to.
    const createdAt = "2026-07-04 03:00:00.123456+00";
    const decoded = decodeActivityCursor(encodeActivityCursor(createdAt, ID));
    expect(decoded?.createdAt).toBe(createdAt);
  });

  it("cursor is opaque (no raw timestamp or uuid visible)", () => {
    const cursor = encodeActivityCursor("2026-06-08 12:26:40+00", ID);
    expect(cursor).not.toContain("0b8f8a52");
    expect(cursor).not.toContain("2026-06-08");
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

  it("rejects a timestamp that is not one Postgres would have produced", () => {
    // These reach a `::timestamptz` cast, so a shape the column never emits is
    // a value that arrived over the network and would fail the query.
    for (const c of [
      "2026-07-04T03:00:00.000Z",
      "1780900000000",
      "2026-07-04 03:00:00",
      "yesterday",
    ]) {
      expect(
        decodeActivityCursor(
          Buffer.from(JSON.stringify({ c, i: ID })).toString("base64url"),
        ),
      ).toBeNull();
    }
  });
});
