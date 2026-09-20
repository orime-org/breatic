// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a stored failure code as something the reader can be told (#207).
 *
 * The lanes that fail an upload write a code of their own, and there are more
 * of them than a reader needs to tell apart: five separate ways our own side
 * can break all leave the same thing for the person to do. So the codes are
 * many and the causes this product names are few, and the mapping between
 * them lives here rather than in the sentence file.
 *
 * A code with no cause reaches the reader as itself — the raw identifier,
 * in every language.
 */

import { describe, expect, it } from "vitest";

import {
  asTaskFailureReason,
  encodeTaskFailure,
  readTaskFailure,
  TASK_FAILURE_REASONS,
} from "@shared/types/task-failure.js";
import { INGEST_SETTLEMENT_CODES } from "@shared/upload/ingest-failure.js";


describe("asTaskFailureReason", () => {
  it("has a cause for every code an upload can be settled on", () => {
    // Walked off the codes themselves. A lane that invents one has to name
    // what the person is told, and this is what says so for the four that the
    // Map lists by hand.
    for (const code of INGEST_SETTLEMENT_CODES) {
      expect(TASK_FAILURE_REASONS).toContain(asTaskFailureReason(code));
    }
  });

  it("gives the source's own failures a cause of their own", () => {
    expect(asTaskFailureReason("source_unreachable")).toBe("source_unreachable");
    expect(asTaskFailureReason("source_too_slow")).toBe("source_too_slow");
    expect(asTaskFailureReason("unsupported_type")).toBe("unsupported_type");
    expect(asTaskFailureReason("empty")).toBe("empty");
  });

  it("puts every way our own side broke under one cause", () => {
    // They differ in the log and nowhere else: whichever it was, the address
    // was fine and sending it again is what the person does next.
    for (const ours of [
      "store_failed",
      "assemble_failed",
      "ingest_refused",
      "type_not_reported",
      "not_started",
    ]) {
      expect(asTaskFailureReason(ours)).toBe("internal");
    }
  });

  it("leaves the causes that were already named where they were", () => {
    expect(asTaskFailureReason("aborted")).toBe("aborted");
    expect(asTaskFailureReason("over_cap")).toBe("over_cap");
    expect(asTaskFailureReason("expired")).toBe("expired");
    expect(asTaskFailureReason("no_result")).toBe("no_result");
  });

  it("names the causes a run can be refused on before it starts", () => {
    // The task row is opened before credits are checked, so a refusal is a
    // failed row on the node rather than a toast with nothing behind it.
    expect(asTaskFailureReason("no_credits")).toBe("no_credits");
  });

  it("keeps the two refusals a model can answer with apart", () => {
    // `internal` promises the address was fine and sending it again is what
    // the person does next. That is false for both of these: the safety gate
    // refused this question, and the service refused these bytes — the same
    // request repeats the same answer.
    expect(asTaskFailureReason("declined")).toBe("declined");
    expect(asTaskFailureReason("media_refused")).toBe("media_refused");
  });

  it("answers nothing for a sentence a provider wrote about itself", () => {
    expect(asTaskFailureReason("The model is overloaded, try again")).toBeNull();
    expect(asTaskFailureReason(null)).toBeNull();
    expect(asTaskFailureReason("")).toBeNull();
  });

});

/**
 * What a cause says about the file it happened to.
 *
 * A refusal over a format leaves the reader asking which of their files this
 * was and what it was in. Both are known where the refusal is raised and
 * nowhere the sentence is written, so they are stored beside the cause.
 */
describe("a cause and what it was about", () => {
  it("stays the bare code when there is nothing to add", () => {
    expect(encodeTaskFailure("understand_unsupported_type")).toBe(
      "understand_unsupported_type",
    );
    expect(encodeTaskFailure("no_credits", { file: "", type: "" })).toBe(
      "no_credits",
    );
  });

  it("carries the file and the type back out", () => {
    const stored = encodeTaskFailure("understand_unsupported_type", {
      file: "1758_a1b2.aiff",
      type: "AIFF",
    });

    expect(readTaskFailure(stored)).toEqual({
      reason: "understand_unsupported_type",
      file: "1758_a1b2.aiff",
      type: "AIFF",
    });
  });

  it("carries whichever half it was given", () => {
    expect(
      readTaskFailure(encodeTaskFailure("understand_unsupported_type", { type: "AIFF" })),
    ).toEqual({ reason: "understand_unsupported_type", type: "AIFF" });
    expect(
      readTaskFailure(
        encodeTaskFailure("understand_unsupported_type", { file: "a.aiff" }),
      ),
    ).toEqual({ reason: "understand_unsupported_type", file: "a.aiff" });
  });

  // Every row written before a cause could carry anything holds a bare code,
  // and reads back the same way it always has.
  it("reads a bare code as the cause it has always been", () => {
    expect(readTaskFailure("no_credits")).toEqual({ reason: "no_credits" });
  });

  // A provider's own error text is what that provider said, and it travels
  // as itself — including when it happens to open with a brace.
  it("claims nothing about a sentence that is not ours", () => {
    expect(readTaskFailure("{not json")).toEqual({ reason: null });
    expect(readTaskFailure('{"reason":"made_up"}')).toEqual({ reason: null });
    expect(readTaskFailure("[]")).toEqual({ reason: null });
  });
});
