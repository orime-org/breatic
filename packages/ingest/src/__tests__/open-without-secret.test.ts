// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What is written down when `POST /uploads` arrives without our secret
 * (inner#1595, acceptance 2).
 *
 * Tickets no longer leave our server, so a ticket that verifies arriving
 * without the secret can only mean one leaked from our side: it is reported
 * under `ingest_open_without_secret` with the key, user and studio it names.
 * A ticket that does not verify says nothing about us and is only refused.
 *
 * Every request in this file runs under the monitoring settings of
 * `helpers/reported-events`, because the SDK keeps the client of the first
 * request an isolate sees.
 */

import { env, fetchMock, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, vi, type MockInstance } from "vitest";
import worker from "@ingest/index.js";
import { ask, counted, mint, openForTest } from "./helpers/open-upload.js";
import {
  askUploads,
  catchEnvelopes,
  MONITORED,
  sentEnvelopes,
  sentEvents,
  type SentEvent,
} from "./helpers/reported-events.js";

const LABEL = "ingest_open_without_secret";
const SECRET_W = env.INGEST_SHARED_SECRET;
const SAME_LENGTH_WRONG = `${SECRET_W.slice(0, -1)}${SECRET_W.endsWith("x") ? "y" : "x"}`;

let logged: MockInstance<typeof console.error>;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  catchEnvelopes();
});

/**
 * The console.error calls made under the refusal's label.
 * @returns Their arguments.
 */
function labelled(): unknown[][] {
  return logged.mock.calls.filter((call) => call[0] === LABEL);
}

/**
 * The refusal reports the SDK sent, told apart by their label tag.
 * @returns Those events, in the order sent.
 */
function reports(): SentEvent[] {
  return sentEvents().filter((event) => event.tags?.label === LABEL);
}

/**
 * The request id a refusal report's message ends in, after its label and key.
 * @param event - The report.
 * @param storageKey - The key it should name.
 * @returns The id, or undefined when the message does not have that shape.
 */
function idOf(event: SentEvent | undefined, storageKey: string): string | undefined {
  const prefix = `${LABEL} ${storageKey} `;
  const message = event?.message ?? "";
  if (!message.startsWith(prefix)) return undefined;
  const id = message.slice(prefix.length);
  return id.length > 0 && !id.includes(" ") ? id : undefined;
}

/**
 * Assert one report names this key, user and studio, under its own request id.
 * @param event - The report.
 * @param who - The key, user and studio the ticket named.
 * @returns The request id it carried.
 */
function expectReport(
  event: SentEvent | undefined,
  who: { storageKey: string; userId: string; studioId: string },
): string {
  const id = idOf(event, who.storageKey);
  expect(id).toBeDefined();
  expect(event?.fingerprint).toEqual([LABEL]);
  expect(event?.contexts?.ingest).toEqual({ ...who, requestId: id });
  return id ?? "";
}

describe("a valid ticket without our secret", () => {
  it("T08: is refused and reported with the key, user and studio it names", async () => {
    const { ticket, storageKey } = await mint({ userId: "user-7", studioId: "studio-7" });

    const answer = await askUploads({ "x-upload-ticket": ticket });

    expect(answer.status).toBe(401);
    const events = reports();
    expect(events).toHaveLength(1);
    const who = { storageKey, userId: "user-7", studioId: "studio-7" };
    const id = expectReport(events[0], who);
    expect(labelled()).toEqual([[LABEL, { ...who, requestId: id }]]);
  });

  it("T09: with a wrong secret is reported the same way", async () => {
    const { ticket, storageKey } = await mint({ userId: "user-7", studioId: "studio-7" });

    const answer = await askUploads({ "x-ingest-secret": SAME_LENGTH_WRONG, "x-upload-ticket": ticket });

    expect(answer.status).toBe(401);
    const events = reports();
    expect(events).toHaveLength(1);
    const who = { storageKey, userId: "user-7", studioId: "studio-7" };
    const id = expectReport(events[0], who);
    expect(labelled()).toEqual([[LABEL, { ...who, requestId: id }]]);
  });

  it("T11: carries neither the ticket nor the secret it was sent", async () => {
    const { ticket } = await mint();

    await askUploads({ "x-ingest-secret": SAME_LENGTH_WRONG, "x-upload-ticket": ticket });

    const headers = sentEvents()[0]?.request?.headers ?? {};
    expect(headers["x-upload-ticket"]).toBe("[Filtered]");
    expect(headers["x-ingest-secret"]).toBe("[Filtered]");
    const raw = sentEnvelopes();
    expect(raw.length).toBeGreaterThan(0);
    for (const envelope of raw) {
      expect(envelope).not.toContain(ticket);
      expect(envelope).not.toContain(SAME_LENGTH_WRONG);
    }
  });
});

describe("a ticket that does not verify, without our secret", () => {
  it.each([
    ["no ticket", async (): Promise<Record<string, string>> => ({})],
    [
      "a tampered signature",
      async (): Promise<Record<string, string>> => {
        const [body] = (await mint()).ticket.split(".");
        return { "x-upload-ticket": `${body}.dGFtcGVyZWQ=` };
      },
    ],
    ["not a ticket", async (): Promise<Record<string, string>> => ({ "x-upload-ticket": "not-a-ticket" })],
    [
      "an expired ticket",
      async (): Promise<Record<string, string>> => ({
        "x-upload-ticket": (await mint({ expiresAt: Date.now() - 1 })).ticket,
      }),
    ],
  ])("T10: %s is only refused, not reported", async (_name, headersFor) => {
    const answer = await askUploads(await headersFor());

    expect(answer.status).toBe(401);
    expect(sentEvents()).toHaveLength(0);
    expect(labelled()).toHaveLength(0);
  });
});

describe("a valid ticket with our secret", () => {
  it("T12: opens and reports nothing", async () => {
    const { ticket } = await mint();

    const answer = await askUploads({ "x-ingest-secret": SECRET_W, "x-upload-ticket": ticket });

    expect(answer.status).toBe(200);
    expect(reports()).toHaveLength(0);
    expect(labelled()).toHaveLength(0);
  });
});

// inner#1595 B2: the SDK's dedupe drops an event equal to the previous one in
// this isolate, so every refusal carries its own request id in its message.
describe("refusals in a row, in one isolate", () => {
  it("T87: three different tickets each leave their own report", async () => {
    const people = ["a", "b", "c"].map((x) => ({ userId: `user-${x}`, studioId: `studio-${x}` }));
    const tickets = [await mint(people[0]), await mint(people[1]), await mint(people[2])];

    await askUploads({ "x-upload-ticket": tickets[0]!.ticket });
    await askUploads({ "x-ingest-secret": SAME_LENGTH_WRONG, "x-upload-ticket": tickets[1]!.ticket });
    await askUploads({ "x-upload-ticket": tickets[2]!.ticket });

    const events = reports();
    expect(events).toHaveLength(3);
    const ids = tickets.map((t, i) => expectReport(events[i], { storageKey: t.storageKey, ...people[i]! }));
    expect(new Set(ids).size).toBe(3);
  });

  it("T88: the same ticket refused twice leaves two reports", async () => {
    const t = await mint({ userId: "user-7", studioId: "studio-7" });
    const who = { storageKey: t.storageKey, userId: "user-7", studioId: "studio-7" };

    await askUploads({ "x-upload-ticket": t.ticket });
    await askUploads({ "x-upload-ticket": t.ticket });

    const events = reports();
    expect(events).toHaveLength(2);
    expect(expectReport(events[0], who)).not.toBe(expectReport(events[1], who));
    expect(labelled()).toHaveLength(2);
  });

  it("T88: an opened upload in between does not merge the two reports", async () => {
    const t = await mint({ userId: "user-7", studioId: "studio-7" });
    const who = { storageKey: t.storageKey, userId: "user-7", studioId: "studio-7" };

    await askUploads({ "x-upload-ticket": t.ticket });
    expect((await askUploads({ "x-ingest-secret": SECRET_W, "x-upload-ticket": t.ticket })).status).toBe(200);
    await askUploads({ "x-upload-ticket": t.ticket });

    const events = reports();
    expect(events).toHaveLength(2);
    expect(expectReport(events[0], who)).not.toBe(expectReport(events[1], who));
    expect(labelled()).toHaveLength(2);
  });

  it.each([
    ["without a secret", {}],
    ["with a wrong secret", { "x-ingest-secret": SAME_LENGTH_WRONG }],
  ])("T90: takes Cloudflare's ray id as the request id (%s)", async (_label, secret) => {
    const RAY = "8f1e2d3c4b5a6978-SJC";
    const t = await mint({ userId: "user-7", studioId: "studio-7" });

    await askUploads({ ...secret, "x-upload-ticket": t.ticket, "cf-ray": RAY });

    const events = reports();
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toBe(`${LABEL} ${t.storageKey} ${RAY}`);
    expect(events[0]?.contexts?.ingest?.requestId).toBe(RAY);
    expect((labelled()[0]?.[1] as { requestId?: string } | undefined)?.requestId).toBe(RAY);
  });
});

// inner#1595 B1: a session token is signed with the same secret as a ticket,
// so only the shape of what it signs keeps it from opening an upload.
describe("a session token sent as a ticket", () => {
  it("T85: opens nothing with or without our secret, and is never reported as a ticket", async () => {
    const bucket = counted({ ...env, ...MONITORED });
    const { token } = await openForTest(
      (await mint({ userId: "user-7", studioId: "studio-7" })).ticket,
      bucket.env,
    );
    const opened = Object.values(bucket.opens).reduce((a, b) => a + b, 0);

    const bare = await ask({ "x-upload-ticket": token }, bucket.env);
    const withSecret = await ask({ "x-upload-ticket": token, "x-ingest-secret": SECRET_W }, bucket.env);
    const ctx = createExecutionContext();
    const fetched = await worker.fetch(
      new Request("https://ingest.example.com/fetch", {
        method: "POST",
        headers: { "x-ingest-secret": SECRET_W, "x-upload-ticket": token },
        body: JSON.stringify({ url: "https://provider.test.example/out.png" }),
      }),
      bucket.env,
      ctx,
    );
    await fetched.text();
    await waitOnExecutionContext(ctx);

    expect(bare.status).toBe(401);
    expect(withSecret.status).toBe(401);
    expect(fetched.status).toBe(401);
    expect(Object.values(bucket.opens).reduce((a, b) => a + b, 0)).toBe(opened);
    expect(reports()).toHaveLength(0);
    expect(labelled()).toHaveLength(0);
  });
});
