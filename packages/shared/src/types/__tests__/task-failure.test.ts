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
  encodeTaskFailure,
  readTaskFailure,
  TASK_FAILURE_REASONS,
} from "@shared/types/task-failure.js";
import { INGEST_SETTLEMENT_CODES } from "@shared/upload/ingest-failure.js";


describe("the cause a stored code is read as", () => {
  it("has a cause for every code an upload can be settled on", () => {
    // Walked off the codes themselves. A lane that invents one has to name
    // what the person is told, and this is what says so for the four that the
    // Map lists by hand.
    for (const code of INGEST_SETTLEMENT_CODES) {
      expect(TASK_FAILURE_REASONS).toContain(readTaskFailure(code).reason);
    }
  });

  it("gives the source's own failures a cause of their own", () => {
    expect(readTaskFailure("source_unreachable").reason).toBe("source_unreachable");
    expect(readTaskFailure("source_too_slow").reason).toBe("source_too_slow");
    expect(readTaskFailure("unsupported_type").reason).toBe("unsupported_type");
    expect(readTaskFailure("empty").reason).toBe("empty");
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
      expect(readTaskFailure(ours).reason).toBe("internal");
    }
  });

  it("leaves the causes that were already named where they were", () => {
    expect(readTaskFailure("aborted").reason).toBe("aborted");
    expect(readTaskFailure("over_cap").reason).toBe("over_cap");
    expect(readTaskFailure("expired").reason).toBe("expired");
    expect(readTaskFailure("no_result").reason).toBe("no_result");
  });

  it("names the causes a run can be refused on before it starts", () => {
    // The task row is opened before credits are checked, so a refusal is a
    // failed row on the node rather than a toast with nothing behind it.
    expect(readTaskFailure("no_credits").reason).toBe("no_credits");
  });

  it("keeps the two refusals a model can answer with apart", () => {
    // `internal` promises the address was fine and sending it again is what
    // the person does next. That is false for both of these: the safety gate
    // refused this question, and the service refused these bytes — the same
    // request repeats the same answer.
    expect(readTaskFailure("declined").reason).toBe("declined");
    expect(readTaskFailure("media_refused").reason).toBe("media_refused");
  });

  it("answers nothing for a sentence a provider wrote about itself", () => {
    expect(readTaskFailure("The model is overloaded, try again").reason).toBeNull();
    expect(readTaskFailure(null).reason).toBeNull();
    expect(readTaskFailure("").reason).toBeNull();
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
