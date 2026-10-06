// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How `/fetch` answers a source that broke partway through its body.
 *
 * The fetch mock cannot fail a body midway, so the transfer itself is stood in
 * for here and `write-stream-as-parts.test.ts` drives the real one against a
 * failing stream, which is where its `SourceReadError` comes from. What this file asserts is the answer and who hears of it:
 * the caller is told the source failed, and only a provider's link is
 * reported, since a link the reader handed us is theirs to replace.
 */

import { fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, vi, type MockInstance } from "vitest";
import { INGEST_FAILURE_HEADER } from "@breatic/shared";
import type * as StoredObject from "@ingest/stored-object.js";
import {
  catchEnvelopes,
  pull,
  sentEvents,
  SOURCE_ORIGIN,
  SOURCE_PATH,
} from "./helpers/reported-events.js";

vi.mock("@ingest/stored-object.js", async (importOriginal) => {
  const actual = await importOriginal<typeof StoredObject>();
  return {
    ...actual,
    writeStreamAsParts: async (): Promise<never> => {
      throw new actual.SourceReadError(new Error("connection reset mid-body"));
    },
  };
});

let logged: MockInstance<typeof console.error>;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  catchEnvelopes();
  fetchMock
    .get(SOURCE_ORIGIN)
    .intercept({ path: SOURCE_PATH, method: "GET" })
    .reply(200, new Uint8Array(1024), { headers: { "content-type": "image/png" } });
});

describe("a source that breaks partway through its body", () => {
  it("is answered as unreachable and reported when it is a provider's result link", async () => {
    const response = await pull();

    expect(response.status).toBe(502);
    expect(response.headers.get(INGEST_FAILURE_HEADER)).toBe("source_unreachable");
    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.label).toBe("ingest_source_read_failed");
  });

  it("is answered as unreachable and only logged when the reader handed us the link", async () => {
    const response = await pull({ contentType: "application/octet-stream", typeFromSource: true });

    expect(response.headers.get(INGEST_FAILURE_HEADER)).toBe("source_unreachable");
    expect(sentEvents()).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith(
      "ingest_source_read_failed",
      expect.objectContaining({ err: expect.stringContaining("connection reset mid-body") }),
    );
  });
});
