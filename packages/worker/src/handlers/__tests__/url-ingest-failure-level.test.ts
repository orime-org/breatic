// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { INGEST_NO_ANSWER, INGEST_REFUSED_UNNAMED } from "@breatic/shared";
import { urlIngestFailureLevel } from "@worker/handlers/url-ingest.js";

describe("urlIngestFailureLevel", () => {
  it("treats a link the reader handed us that cannot be taken as the reader's input", () => {
    expect(urlIngestFailureLevel("source_unreachable")).toBe("warn");
    expect(urlIngestFailureLevel("unsupported_type")).toBe("warn");
    expect(urlIngestFailureLevel("over_cap")).toBe("warn");
  });

  it("treats every failure on our side as an error", () => {
    expect(urlIngestFailureLevel("store_failed")).toBe("error");
    expect(urlIngestFailureLevel("assemble_failed")).toBe("error");
    expect(urlIngestFailureLevel(INGEST_REFUSED_UNNAMED)).toBe("error");
    expect(urlIngestFailureLevel(INGEST_NO_ANSWER)).toBe("error");
  });
});
