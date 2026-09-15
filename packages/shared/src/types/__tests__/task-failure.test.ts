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

  it("answers nothing for a sentence a provider wrote about itself", () => {
    expect(asTaskFailureReason("The model is overloaded, try again")).toBeNull();
    expect(asTaskFailureReason(null)).toBeNull();
    expect(asTaskFailureReason("")).toBeNull();
  });

});
