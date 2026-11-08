// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ReadPageStatus } from "@breatic/shared";

import { statusOfResponse } from "../classify.js";

describe("statusOfResponse", () => {
  it.each<[number, ReadPageStatus]>([
    [401, "needs_login"],
    [407, "needs_login"],
    [403, "refused"],
    [404, "unreachable"],
    [410, "unreachable"],
    [429, "busy"],
    [500, "busy"],
    [502, "busy"],
    [503, "busy"],
  ])("answers HTTP %i with %s, whatever the body's type", (httpStatus, expected) => {
    expect(statusOfResponse(httpStatus, "text/html; charset=utf-8")).toBe(expected);
    expect(statusOfResponse(httpStatus, null)).toBe(expected);
  });

  it.each(["image/png", "audio/mpeg", "video/mp4", "application/zip"])(
    "refuses a 200 of type %s as unsupported_type",
    (contentType) => {
      expect(statusOfResponse(200, contentType)).toBe("unsupported_type");
    },
  );

  it.each(["text/html", "text/html; charset=utf-8", "text/plain", "application/pdf"])(
    "reads on through a 200 of type %s",
    (contentType) => {
      expect(statusOfResponse(200, contentType)).toBeNull();
    },
  );

  it("reads on through a 200 that names no type", () => {
    expect(statusOfResponse(200, null)).toBeNull();
  });

  it("answers every 5xx status but 530 with busy", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 500, max: 599 }).filter((httpStatus) => httpStatus !== 530),
        fc.constantFrom("text/html", "application/pdf", null),
        (httpStatus, contentType) => {
          expect(statusOfResponse(httpStatus, contentType)).toBe("busy");
        },
      ),
    );
  });

  // Plan §9 row J: 530 is what Cloudflare answers when the origin's name does
  // not resolve or the origin cannot be reached; the site is not busy, it is
  // not there.
  it("answers 530 with unreachable, whatever the body's type", () => {
    expect(statusOfResponse(530, "text/html; charset=utf-8")).toBe("unreachable");
    expect(statusOfResponse(530, null)).toBe("unreachable");
  });

  // Plan §9 row J: the Worker's outbound handler answers a send that threw
  // with 502 and `x-breatic-unreachable: 1`; the caller passes whether the
  // response carried that mark, and the mark wins over the status.
  it("answers a response marked unreachable by the outbound handler with unreachable", () => {
    expect(statusOfResponse(502, "text/plain", true)).toBe("unreachable");
    expect(statusOfResponse(502, null, true)).toBe("unreachable");
  });

  it("answers an unmarked 502 with busy, as before", () => {
    expect(statusOfResponse(502, "text/plain", false)).toBe("busy");
    expect(statusOfResponse(502, "text/plain")).toBe("busy");
  });
});
