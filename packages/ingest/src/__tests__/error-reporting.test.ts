// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What reaches Sentry when the Worker fails.
 *
 * The SDK is the real one, pointed at a DSN whose host the fetch mock answers,
 * so what is asserted is the envelope it actually sent: whether a failure was
 * reported, under which label, and with which release and environment. A
 * failure the reader caused by handing us a link we cannot take is written to
 * the log only.
 *
 * Every case here runs under the same settings (see `helpers/reported-events`);
 * what the settings turn into is `error-monitoring.node.test.ts`'s subject.
 */

import { fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, vi, type MockInstance } from "vitest";
import {
  catchEnvelopes,
  openUpload,
  pull,
  sendPart,
  sentEvents,
  SHA,
  SOURCE_ORIGIN,
  SOURCE_PATH,
} from "./helpers/reported-events.js";

let logged: MockInstance<typeof console.error>;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  catchEnvelopes();
});

/** The provider cannot be reached at all. */
function sourceUnreachable(): void {
  fetchMock
    .get(SOURCE_ORIGIN)
    .intercept({ path: SOURCE_PATH, method: "GET" })
    .replyWithError(new Error("connection reset"));
}

/** The provider answers that the link is gone. */
function sourceGone(): void {
  fetchMock
    .get(SOURCE_ORIGIN)
    .intercept({ path: SOURCE_PATH, method: "GET" })
    .reply(404, "");
}

/** The provider serves bytes no reader names as anything we take. */
function sourceServesNothingWeTake(): void {
  const bytes = Uint8Array.from({ length: 1024 }, (_, i) => (i * 31 + 7) & 0xff);
  fetchMock
    .get(SOURCE_ORIGIN)
    .intercept({ path: SOURCE_PATH, method: "GET" })
    .reply(200, bytes, { headers: { "content-type": "image/png" } });
}

describe("failures on a provider's result link", () => {
  it("reports a source that could not be reached, with the error that said so", async () => {
    sourceUnreachable();

    await pull();

    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.label).toBe("ingest_source_unreachable");
    expect(events[0]?.exception?.values[0]?.value).toContain("connection reset");
    expect(events[0]?.release).toBe(SHA);
    expect(events[0]?.environment).toBe("production");
  });

  it("filters the signed upload ticket out of the request it reports", async () => {
    sourceUnreachable();

    await pull();

    const headers = sentEvents()[0]?.request?.headers ?? {};
    expect(headers["x-upload-ticket"]).toBe("[Filtered]");
    expect(headers["x-ingest-secret"]).toBe("[Filtered]");
  });

  it("reports a source that answered with a failure, under its label", async () => {
    sourceGone();

    await pull();

    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toBe("ingest_source_refused");
    expect(events[0]?.tags?.label).toBe("ingest_source_refused");
  });
});

describe("failures on a link the reader handed us", () => {
  it("writes an unreachable source to the log without reporting it", async () => {
    sourceUnreachable();

    await pull({ contentType: "application/octet-stream", typeFromSource: true });

    expect(sentEvents()).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith(
      "ingest_source_unreachable",
      expect.objectContaining({ err: expect.stringContaining("connection reset") }),
    );
  });

  it("writes a source that answered with a failure to the log without reporting it", async () => {
    sourceGone();

    await pull({ contentType: "application/octet-stream", typeFromSource: true });

    expect(sentEvents()).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith(
      "ingest_source_refused",
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe("stored bytes of a kind we do not take", () => {
  it("are written to the log without being reported", async () => {
    sourceServesNothingWeTake();

    const response = await pull();

    expect(response.status).toBe(415);
    expect(sentEvents()).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith(
      "ingest_stored_type_refused",
      expect.objectContaining({ storedType: expect.any(String) }),
    );
  });
});

describe("a browser that drops its connection while sending a part", () => {
  it("is only logged, under its own label", async () => {
    const upload = await openUpload();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("browser went away"));
      },
    });

    const response = await sendPart(upload, body);

    expect(response.status).toBe(400);
    expect(sentEvents()).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith(
      "ingest_part_read_failed",
      expect.objectContaining({ err: expect.stringContaining("browser went away") }),
    );
  });
});
