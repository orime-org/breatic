// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
    // The column never emits any of these, so a cursor carrying one did not
    // come from us. Postgres reads three of the four quite happily —
    // `yesterday` is a date it resolves against the clock — which is worse
    // than a failed query: the page would silently start somewhere else.
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

  it("rejects a timestamp whose shape is right and whose value is not", () => {
    // Postgres refuses every one of these at the cast — the dates and times
    // as `date/time field value out of range`, the two offsets as `time zone
    // displacement out of range` — and the request ends as a 500, so the
    // shape alone cannot be the whole check. February 30th is the one to
    // watch: `Date.parse` rolls it forward to March instead of refusing it.
    for (const c of [
      "2026-13-04 03:00:00+00",
      "2026-07-45 03:00:00+00",
      "2026-07-04 99:00:00+00",
      "2026-07-04 03:70:00+00",
      "2026-07-04 03:00:70+00",
      "2026-02-30 00:00:00+00",
      "2026-04-31 00:00:00+00",
      "2025-02-29 00:00:00+00",
      "2026-07-04 03:00:00+99",
      "2026-07-04 03:00:00+05:70",
      "0000-07-04 03:00:00+00",
    ]) {
      expect(
        decodeActivityCursor(
          Buffer.from(JSON.stringify({ c, i: ID })).toString("base64url"),
        ),
      ).toBeNull();
    }
  });

  it("accepts the edges Postgres does produce", () => {
    for (const c of [
      "2024-02-29 00:00:00+00",
      "2026-12-31 23:59:59.999999+00",
      "2026-07-04 03:00:00+14",
      "2026-07-04 03:00:00-12",
      "2026-07-04 03:00:00+05:45",
    ]) {
      expect(
        decodeActivityCursor(
          Buffer.from(JSON.stringify({ c, i: ID })).toString("base64url"),
        ),
      ).not.toBeNull();
    }
  });

  it("rejects an id that is not a uuid", () => {
    // It reaches a uuid column. Every page these cursors walk compares the id
    // against one, so a value that is not a uuid fails the query wherever it
    // is decoded.
    for (const i of ["not-a-uuid", "0b8f8a52", `${ID} `, `${ID}x`]) {
      expect(
        decodeActivityCursor(
          Buffer.from(JSON.stringify({ c: "2026-07-04 03:00:00+00", i })).toString(
            "base64url",
          ),
        ),
      ).toBeNull();
    }
  });
});
