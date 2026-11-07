// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { INGEST_NO_ANSWER, INGEST_REFUSED_UNNAMED } from "@breatic/shared";
import { isUserLinkFault, urlIngestFailureLevel } from "@domain/asset/user-source.js";

describe("urlIngestFailureLevel", () => {
  it("treats a link the user handed us that cannot be taken as the user's input", () => {
    expect(urlIngestFailureLevel("source_unreachable")).toBe("warn");
    expect(urlIngestFailureLevel("unsupported_type")).toBe("warn");
    expect(urlIngestFailureLevel("over_cap")).toBe("warn");
    expect(urlIngestFailureLevel("empty")).toBe("warn");
  });

  it("treats every failure on our side as an error", () => {
    expect(urlIngestFailureLevel("store_failed")).toBe("error");
    expect(urlIngestFailureLevel("assemble_failed")).toBe("error");
    expect(urlIngestFailureLevel(INGEST_REFUSED_UNNAMED)).toBe("error");
    expect(urlIngestFailureLevel(INGEST_NO_ANSWER)).toBe("error");
  });
});

describe("isUserLinkFault", () => {
  it("puts a link that could not be reached or held the wrong thing down to the link", () => {
    for (const reason of ["source_unreachable", "unsupported_type", "over_cap", "empty"]) {
      expect(isUserLinkFault(reason), reason).toBe(true);
    }
  });

  it("puts a failure in storing or judging what arrived down to our side", () => {
    for (const reason of ["store_failed", "assemble_failed", INGEST_REFUSED_UNNAMED, "type_not_reported", INGEST_NO_ANSWER]) {
      expect(isUserLinkFault(reason), reason).toBe(false);
    }
  });
});
