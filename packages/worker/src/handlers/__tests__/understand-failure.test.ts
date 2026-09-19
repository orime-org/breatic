// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a failed understand run as something the reader is told (#2175).
 *
 * The run's own module says why it failed in its own vocabulary — five ways
 * an address yields nothing, five ways a service refuses. The node's task row
 * stores one of ours, and the reader is told it in their own language, so the
 * two vocabularies meet here and nowhere else.
 */

import { describe, expect, it } from "vitest";
import { MediaUnavailable, UnderstandRefused } from "@breatic/domain";

import {
  AnsweredNothing,
  understandFailureCode,
} from "@worker/handlers/understand-failure.js";
import { storedFailure } from "@worker/handlers/dispatch.js";

describe("what an address that yielded nothing is stored as", () => {
  // Each of the five says something different about what the reader does
  // next, and each already has a code of ours saying exactly that.
  it.each([
    ["unreachable", "source_unreachable"],
    ["unsupported-type", "unsupported_type"],
    ["too-large", "over_cap"],
    ["slow", "source_too_slow"],
    ["empty", "empty"],
  ] as const)("reads %s as %s", (kind, code) => {
    expect(understandFailureCode(new MediaUnavailable(kind, {}))).toBe(code);
  });
});

describe("what a service that would not answer is stored as", () => {
  // `internal` promises the address was fine and that sending it again is
  // what the person does next. That is true of two of these and false of the
  // other three, which is why they do not share a code.
  it.each([
    ["content-filter", "declined"],
    ["media", "media_refused"],
    ["unfetchable", "source_unreachable"],
    ["deployment", "internal"],
    ["transient", "internal"],
  ] as const)("reads %s as %s", (kind, code) => {
    expect(understandFailureCode(new UnderstandRefused(400, "no", kind))).toBe(
      code,
    );
  });
});

describe("what a run that answered nothing is stored as", () => {
  // The service answered, so nothing refused anything — there is simply no
  // reading to put on the node. `internal` would tell the reader we broke,
  // and `no_result` is the code that says what happened.
  it("is stored as the run having produced none", () => {
    expect(understandFailureCode(new AnsweredNothing())).toBe("no_result");
  });

  // The whole reason it is a type: a message read back as a code is a
  // sentence being trusted to stay spelled that way.
  it("is not read off the words of any other error", () => {
    expect(understandFailureCode(new Error("no_result"))).toBe("internal");
  });
});

describe("anything else", () => {
  // Something on our side broke, and which part is in the log rather than on
  // the node: a reader has the same thing to do either way.
  it("is stored as ours to answer for", () => {
    expect(understandFailureCode(new Error("boom"))).toBe("internal");
    expect(understandFailureCode("not an error")).toBe("internal");
  });
});

describe("what a failed run's row is given", () => {
  // A read's failures are ours to name, so the row holds a code and the
  // reader is told it in their own language.
  it("gives a read's failure the code that names it", () => {
    expect(storedFailure("understand", new MediaUnavailable("slow", {}))).toBe(
      "source_too_slow",
    );
  });

  // A generation's failure is whatever the provider said about itself, and
  // that travels as itself — there is no code of ours for it.
  it("passes a generation's failure through in the words it came in", () => {
    expect(storedFailure("image", new Error("the model is overloaded"))).toBe(
      "the model is overloaded",
    );
  });
});
