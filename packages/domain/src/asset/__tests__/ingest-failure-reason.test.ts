// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reason a failed call to the ingest Worker is settled with (inner#1595
 * T30–T32, P04).
 *
 * Three callers share it — finishing an upload, pulling a reader's link, and
 * the server opening an upload — and each passes its own word for "nothing
 * answered". An answer that arrived is the Worker's: its named refusal, or
 * the unnamed sentinel when it named none.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DeadlinePassed,
  INGEST_FAILURE_CODES,
  INGEST_NO_ANSWER,
  INGEST_REFUSED_UNNAMED,
  UploadHttpError,
} from "@breatic/shared";
import { ingestFailureReason } from "@domain/asset/ingest-failure-reason.js";

describe("ingestFailureReason", () => {
  it("T30: takes the name the Worker gave its refusal", () => {
    expect(ingestFailureReason(new UploadHttpError(415, "unsupported_type"), "aborted")).toBe(
      "unsupported_type",
    );
    expect(ingestFailureReason(new UploadHttpError(502, "store_failed"), INGEST_NO_ANSWER)).toBe(
      "store_failed",
    );
  });

  it("T31: reads an answer that named nothing as the Worker refusing unnamed", () => {
    expect(ingestFailureReason(new UploadHttpError(500, null), "aborted")).toBe(INGEST_REFUSED_UNNAMED);
    expect(ingestFailureReason(new UploadHttpError(401, null), INGEST_NO_ANSWER)).toBe(
      INGEST_REFUSED_UNNAMED,
    );
  });

  const noAnswers: [string, unknown][] = [
    ["a transport failure", new TypeError("fetch failed")],
    ["the deadline passing", new DeadlinePassed()],
    ["the caller stopping", new DOMException("x", "AbortError")],
    ["a plain error", new Error("socket hang up")],
    ["a thrown string", "str"],
    ["undefined", undefined],
  ];

  it.each(noAnswers)("T32: gives the caller's own word when nothing answered (%s)", (_label, err) => {
    expect(ingestFailureReason(err, "aborted")).toBe("aborted");
    expect(ingestFailureReason(err, INGEST_NO_ANSWER)).toBe(INGEST_NO_ANSWER);
  });

  it("P04: an answer gives its code or the unnamed sentinel; anything else gives noAnswer", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 400, max: 599 }),
        fc.oneof(fc.constantFrom(...INGEST_FAILURE_CODES), fc.constant(null)),
        fc.string(),
        (status, code, noAnswer) =>
          ingestFailureReason(new UploadHttpError(status, code), noAnswer) ===
          (code ?? INGEST_REFUSED_UNNAMED),
      ),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(fc.anything(), fc.string(), (x, noAnswer) => ingestFailureReason(x, noAnswer) === noAnswer),
      { numRuns: 200 },
    );
  });
});
