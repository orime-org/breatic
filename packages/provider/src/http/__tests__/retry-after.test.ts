// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryAfterOf } from "../request.js";

// The cases of shared's parseRetryAfter (shared/src/http/__tests__/decide-retry.test.ts), which provider follows (DD 33).
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const inFiveSeconds = new Date(NOW + 5_000).toUTCString();

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("retryAfterOf — the two forms RFC 9110 allows, read as shared reads them", () => {
  it.each([
    ["delay-seconds", "5"],
    ["HTTP-date", inFiveSeconds],
  ])("reads a single %s value", (_form, raw) => {
    expect(retryAfterOf(raw)).toBe(5_000);
  });

  it("still honours an explicit zero", () => {
    expect(retryAfterOf("0")).toBe(0);
  });

  it.each([
    ["delay-seconds", "5, 5"],
    ["HTTP-date", `${inFiveSeconds}, ${inFiveSeconds}`],
  ])("honours a %s value the server sent twice", (_form, raw) => {
    expect(retryAfterOf(raw)).toBe(5_000);
  });

  it("reads what a real Headers object produces from a repeated date field", () => {
    const headers = new Headers();
    headers.append("retry-after", inFiveSeconds);
    headers.append("retry-after", inFiveSeconds);
    expect(retryAfterOf(headers.get("retry-after"))).toBe(5_000);
  });

  it.each([
    ["delay-seconds", "5, 7"],
    ["HTTP-date", `${inFiveSeconds}, ${new Date(NOW + 9_000).toUTCString()}`],
  ])("reads a repeated %s whose copies disagree as no value", (_form, raw) => {
    expect(retryAfterOf(raw)).toBeUndefined();
  });

  it.each(["", "   ", "soon", "-1", "-5", "1.5", "NaN", "3.5.1", "2026-12-01"])("reads the malformed value %o as no value", (raw) => {
    expect(retryAfterOf(raw)).toBeUndefined();
  });

  it("reads a date already past as no value", () => {
    expect(retryAfterOf(new Date(NOW - 60_000).toUTCString())).toBeUndefined();
  });

  it.each([
    ["a non-GMT zone", "Thu, 30 Jul 2026 12:00:05 UTC"],
    ["a lower-case zone", "Thu, 30 Jul 2026 12:00:05 gmt"],
    ["a day that does not exist", "Tue, 31 Feb 2099 12:00:00 GMT"],
    ["a weekday that is not that date's weekday", "Mon, 30 Jul 2026 12:00:05 GMT"],
    ["a seconds field past 59", "Thu, 30 Jul 2026 12:05:99 GMT"],
  ])("reads an HTTP-date with %s as no value", (_why, raw) => {
    expect(retryAfterOf(raw)).toBeUndefined();
  });

  it("is not slowed by a value repeated thousands of times", () => {
    const hostile = `${Array.from({ length: 5_000 }, () => "5").join(", ")}, x`;
    const started = performance.now();
    expect(retryAfterOf(hostile)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(100);
  });
});
