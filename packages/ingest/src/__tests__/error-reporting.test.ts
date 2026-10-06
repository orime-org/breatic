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
 * The SDK keeps one client per isolate, made from the settings of the first
 * request it sees, so every case here runs under the same settings. What the
 * settings turn into is `error-monitoring.node.test.ts`'s subject.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, vi, type MockInstance } from "vitest";
import { signUploadTicket, type UploadTicketPayload } from "@breatic/shared";
import worker, { type Env } from "@ingest/index.js";

const SENTRY_ORIGIN = "https://sentry.test.example";
const DSN = "https://publickey@sentry.test.example/1";
const SOURCE_ORIGIN = "https://provider.test.example";
const SOURCE_PATH = "/results/out.png";
const SHA = "4ca3e774ad2bb6b8f9406579ddc4bb611e5037a0";

let seq = 0;
let envelopes: string[] = [];
let logged: MockInstance<typeof console.error>;

/** One event out of a Sentry envelope. */
interface SentEvent {
  release?: string;
  environment?: string;
  message?: string;
  tags?: Record<string, string>;
  exception?: { values: { value?: string }[] };
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  envelopes = [];
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchMock
    .get(SENTRY_ORIGIN)
    .intercept({ path: (path) => path.startsWith("/api/1/envelope/"), method: "POST" })
    .reply((request) => {
      envelopes.push(String(request.body));
      return { statusCode: 200, data: "{}" };
    })
    .persist();
});

/**
 * The events the SDK sent, read out of the envelopes it posted.
 * @returns Every event item, in the order sent.
 */
function sentEvents(): SentEvent[] {
  return envelopes.flatMap((envelope) => {
    const lines = envelope.split("\n").filter((line) => line.length > 0);
    const events: SentEvent[] = [];
    for (let i = 1; i + 1 < lines.length; i += 2) {
      const header = JSON.parse(lines[i] ?? "{}") as { type?: string };
      if (header.type === "event") events.push(JSON.parse(lines[i + 1] ?? "{}") as SentEvent);
    }
    return events;
  });
}

/** The monitoring settings every case here runs under. */
const MONITORED: Pick<Env, "SENTRY_DSN" | "SENTRY_RELEASE" | "SENTRY_ENVIRONMENT"> = {
  SENTRY_DSN: DSN,
  SENTRY_RELEASE: SHA,
  SENTRY_ENVIRONMENT: "production",
};

/**
 * Ask the Worker to pull the source into a fresh key.
 * @param over - Ticket fields to override.
 * @returns The Worker's answer.
 */
async function pull(over: Partial<UploadTicketPayload> = {}): Promise<Response> {
  const ticket = await signUploadTicket(
    {
      storageKey: `image/2026-10-06/${seq++}_reported.png`,
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 4,
      partSize: 5 * 1024 * 1024,
      contentType: "image/png",
      expiresAt: Date.now() + 300_000,
      sessionTokenTtlSeconds: 900,
      ...over,
    },
    env.INGEST_SHARED_SECRET,
  );
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://ingest.example.com/fetch", {
      method: "POST",
      headers: { "x-ingest-secret": env.INGEST_SHARED_SECRET, "x-upload-ticket": ticket },
      body: JSON.stringify({ url: `${SOURCE_ORIGIN}${SOURCE_PATH}` }),
    }),
    { ...env, ...MONITORED },
    ctx,
  );
  // Read as every caller reads it: the SDK holds a plain-text answer as a
  // stream and sends its events once the body has been read.
  await response.text();
  await waitOnExecutionContext(ctx);
  return response;
}

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
