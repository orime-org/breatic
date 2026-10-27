// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decide, type Failure } from "../decide.js";

describe("decide — media submit (design 5.3, media column)", () => {
  it.each<[string, Failure, "switch" | "stop"]>([
    ["request never left (DNS, refused)", { kind: "not_sent" }, "switch"],
    ["408", { kind: "http_status", status: 408 }, "switch"],
    ["429", { kind: "http_status", status: 429 }, "switch"],
    ["500", { kind: "http_status", status: 500 }, "switch"],
    ["503", { kind: "http_status", status: 503 }, "switch"],
    ["upstream has no such model", { kind: "model_not_found" }, "switch"],
    ["the account has no balance", { kind: "insufficient_balance" }, "switch"],
    ["400", { kind: "http_status", status: 400 }, "stop"],
    ["409", { kind: "http_status", status: 409 }, "stop"],
    ["422", { kind: "http_status", status: 422 }, "stop"],
    ["sent but no answer (timeout, reset)", { kind: "no_answer" }, "stop"],
    ["deadline abort", { kind: "aborted" }, "stop"],
  ])("%s → %s", (_label, failure, expected) => {
    expect(decide(failure, "media_submit", 0, 3)).toBe(expected);
  });

  it("never retries the same upstream, whatever the failure", () => {
    fc.assert(
      fc.property(failureArb(), fc.nat(5), fc.nat(5), (failure, used, max) => {
        expect(decide(failure, "media_submit", used, max)).not.toBe("retry");
      }),
    );
  });
});

describe("decide — LLM before the first content part (design 5.3, LLM column)", () => {
  it.each<[string, Failure, "switch" | "stop"]>([
    ["request never left", { kind: "not_sent" }, "switch"],
    ["upstream has no such model", { kind: "model_not_found" }, "switch"],
    ["the account has no balance", { kind: "insufficient_balance" }, "switch"],
    ["400", { kind: "http_status", status: 400 }, "stop"],
    ["422", { kind: "http_status", status: 422 }, "stop"],
    ["sent but no answer, or the stream broke", { kind: "no_answer" }, "stop"],
    ["deadline abort", { kind: "aborted" }, "stop"],
  ])("%s → %s", (_label, failure, expected) => {
    expect(decide(failure, "llm_before_content", 0, 3)).toBe(expected);
  });

  it.each([408, 409, 429, 500, 502, 503, 504])("%i retries the same upstream while retries remain", (status) => {
    expect(decide({ kind: "http_status", status }, "llm_before_content", 0, 2)).toBe("retry");
    expect(decide({ kind: "http_status", status }, "llm_before_content", 1, 2)).toBe("retry");
  });

  it.each([408, 409, 429, 500, 502, 503, 504])("%i switches once the retries are spent", (status) => {
    expect(decide({ kind: "http_status", status }, "llm_before_content", 2, 2)).toBe("switch");
  });

  it("with no retries allowed, a 5xx switches at once", () => {
    expect(decide({ kind: "http_status", status: 502 }, "llm_before_content", 0, 0)).toBe("switch");
  });
});

describe("decide — statuses outside the switch list", () => {
  it.each([401, 403, 404, 413])("%i stops in both phases", (status) => {
    expect(decide({ kind: "http_status", status }, "media_submit", 0, 3)).toBe("stop");
    expect(decide({ kind: "http_status", status }, "llm_before_content", 0, 3)).toBe("stop");
  });

  it("only not_sent, model_not_found, insufficient_balance, 408, 429 and 5xx ever lead away from the upstream, and 409 too before an LLM's content", () => {
    fc.assert(
      fc.property(failureArb(), fc.constantFrom("media_submit", "llm_before_content" as const), fc.nat(5), fc.nat(5),
        (failure, phase, used, max) => {
          const decision = decide(failure, phase, used, max);
          if (decision === "stop") return;
          const switchable = failure.kind === "not_sent" || failure.kind === "model_not_found" || failure.kind === "insufficient_balance"
            || (failure.kind === "http_status" && (failure.status === 408 || failure.status === 429 || failure.status >= 500
              || (phase === "llm_before_content" && failure.status === 409)));
          expect(switchable).toBe(true);
        }),
    );
  });
});

/**
 * Any failure class, with statuses from the whole 4xx and 5xx range.
 * @returns The arbitrary.
 */
function failureArb(): fc.Arbitrary<Failure> {
  return fc.oneof(
    fc.constant<Failure>({ kind: "not_sent" }),
    fc.constant<Failure>({ kind: "no_answer" }),
    fc.constant<Failure>({ kind: "model_not_found" }),
    fc.constant<Failure>({ kind: "insufficient_balance" }),
    fc.constant<Failure>({ kind: "aborted" }),
    fc.integer({ min: 400, max: 599 }).map<Failure>((status) => ({ kind: "http_status", status })),
  );
}
