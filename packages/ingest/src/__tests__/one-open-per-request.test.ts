// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Nothing but our secret opens an upload (inner#1595, acceptance 1, 2 and 5).
 *
 * P01 is the Worker's part of the proof that one ticket opens at most one
 * upload: whatever order, concurrency and repetition `POST /uploads` arrives
 * in, and whatever it carries as a ticket (a real one, a forged one, an
 * expired one, or what an earlier answer handed back), a request without the
 * right secret adds nothing to `createMultipartUpload`. P02 pins that each
 * such request with a ticket that verifies leaves exactly one report.
 *
 * Every request runs under the monitoring settings, because the SDK keeps the
 * client of the first request an isolate sees and P02 reads what it sent.
 */

import { env, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fc from "fast-check";
import { verifySessionToken } from "@breatic/shared";
import { ask, counted, mint, type OpenAnswer } from "./helpers/open-upload.js";
import { catchEnvelopes, MONITORED, sentEvents } from "./helpers/reported-events.js";

const LABEL = "ingest_open_without_secret";
const SECRET_W = env.INGEST_SHARED_SECRET;

type SecretKind = "absent" | "correct" | "sameLengthWrong" | "longer" | "empty";
type TicketKind =
  | { kind: "K0" | "K1" | "K2" | "absent" | "expired" | "tampered" | "echoToken" | "echoUploadId" }
  | { kind: "random"; value: string };

/** One request as generated, before `times` is expanded. */
interface Req {
  secret: SecretKind;
  ticket: TicketKind;
  times: number;
}

/** What each request resolved to once sent. */
interface Sent {
  secret: SecretKind;
  /** The index of the valid ticket it carried, or null. */
  valid: number | null;
  answer: OpenAnswer;
}

const secretArb: fc.Arbitrary<SecretKind> = fc.constantFrom(
  "absent",
  "correct",
  "sameLengthWrong",
  "longer",
  "empty",
);

const ticketArb: fc.Arbitrary<TicketKind> = fc.oneof(
  fc
    .constantFrom("K0", "K1", "K2", "absent", "expired", "tampered", "echoToken", "echoUploadId")
    .map((kind): TicketKind => ({ kind })),
  fc.string().map((value): TicketKind => ({ kind: "random", value })),
);

/**
 * The secret header for a generated kind.
 * @param secret - The kind.
 * @returns The header to send, if any.
 */
function secretHeader(secret: SecretKind): Record<string, string> {
  switch (secret) {
    case "absent":
      return {};
    case "correct":
      return { "x-ingest-secret": SECRET_W };
    case "sameLengthWrong":
      return { "x-ingest-secret": `${SECRET_W.slice(0, -1)}${SECRET_W.endsWith("x") ? "y" : "x"}` };
    case "longer":
      return { "x-ingest-secret": `${SECRET_W}x` };
    case "empty":
      return { "x-ingest-secret": "" };
  }
}

/** One round's fixed tickets. */
interface Round {
  valid: { ticket: string; storageKey: string }[];
  expired: string;
  tampered: string;
}

/**
 * Sign the three valid tickets, an expired one and a tampered one.
 * @returns The round's tickets.
 */
async function round(): Promise<Round> {
  const valid = [await mint(), await mint(), await mint()];
  const expired = (await mint({ expiresAt: Date.now() - 1 })).ticket;
  const [body] = (await mint()).ticket.split(".");
  return { valid, expired, tampered: `${body}.dGFtcGVyZWQ=` };
}

/**
 * Resolve the ticket header for one request.
 * @param ticket - The generated kind.
 * @param r - The round's tickets.
 * @param lastOk - The last 200 answer seen this round, if any.
 * @returns The header to send, and which valid ticket it is.
 */
function ticketHeader(
  ticket: TicketKind,
  r: Round,
  lastOk: OpenAnswer | null,
): { header: Record<string, string>; valid: number | null } {
  switch (ticket.kind) {
    case "K0":
    case "K1":
    case "K2": {
      const i = Number(ticket.kind[1]);
      return { header: { "x-upload-ticket": r.valid[i]?.ticket ?? "" }, valid: i };
    }
    case "expired":
      return { header: { "x-upload-ticket": r.expired }, valid: null };
    case "tampered":
      return { header: { "x-upload-ticket": r.tampered }, valid: null };
    case "random":
      return { header: { "x-upload-ticket": ticket.value }, valid: null };
    case "echoToken":
      return lastOk?.token === undefined
        ? { header: {}, valid: null }
        : { header: { "x-upload-ticket": lastOk.token }, valid: null };
    case "echoUploadId":
      return lastOk?.uploadId === undefined
        ? { header: {}, valid: null }
        : { header: { "x-upload-ticket": lastOk.uploadId }, valid: null };
    case "absent":
      return { header: {}, valid: null };
  }
}

/**
 * Send one round of requests.
 * @param reqs - The generated requests.
 * @param mode - Sent one after another or all at once.
 * @param e - The bindings the Worker runs with.
 * @param r - The round's tickets.
 * @returns What each expanded request was and how it was answered, in order.
 */
async function sendRound(
  reqs: Req[],
  mode: "sequential" | "concurrent",
  e: Parameters<typeof ask>[1],
  r: Round,
): Promise<Sent[]> {
  const expanded = reqs.flatMap((req) => Array.from({ length: req.times }, () => req));
  if (mode === "concurrent") {
    return Promise.all(
      expanded.map(async (req) => {
        const { header, valid } = ticketHeader(req.ticket, r, null);
        const answer = await ask({ ...secretHeader(req.secret), ...header }, e);
        return { secret: req.secret, valid, answer };
      }),
    );
  }
  const sent: Sent[] = [];
  let lastOk: OpenAnswer | null = null;
  for (const req of expanded) {
    const { header, valid } = ticketHeader(req.ticket, r, lastOk);
    const answer = await ask({ ...secretHeader(req.secret), ...header }, e);
    if (answer.status === 200) lastOk = answer;
    sent.push({ secret: req.secret, valid, answer });
  }
  return sent;
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  catchEnvelopes();
});

const reqArb = (times: fc.Arbitrary<number>): fc.Arbitrary<Req> =>
  fc.record({ secret: secretArb, ticket: ticketArb, times });

describe("POST /uploads under any mix of requests", () => {
  it("P01: only our secret with a valid ticket opens an upload", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(reqArb(fc.integer({ min: 1, max: 3 })), { minLength: 1, maxLength: 10 }),
        fc.constantFrom("sequential" as const, "concurrent" as const),
        async (reqs, mode) => {
          catchEnvelopes();
          const r = await round();
          const bucket = counted({ ...env, ...MONITORED });

          const sent = await sendRound(reqs, mode, bucket.env, r);

          const opening = sent.filter((s) => s.secret === "correct" && s.valid !== null);
          // 1. every open comes from our secret with a valid ticket
          const total = Object.values(bucket.opens).reduce((a, b) => a + b, 0);
          expect(total).toBe(opening.length);
          // 2. per ticket, opens equal the requests that carried it with our secret
          r.valid.forEach(({ storageKey }, i) => {
            const n = opening.filter((s) => s.valid === i).length;
            expect(bucket.opens[storageKey]).toBe(n === 0 ? undefined : n);
          });
          // 3. the rest are 401; the opening ones are 200 with a token for their upload
          for (const s of sent) {
            if (s.secret === "correct" && s.valid !== null) {
              expect(s.answer.status).toBe(200);
              const payload = await verifySessionToken(s.answer.token ?? "", SECRET_W, Date.now());
              expect(payload?.uploadId).toBe(s.answer.uploadId);
            } else {
              expect(s.answer.status).toBe(401);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("P02: each refused request with a valid ticket leaves exactly one report", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(reqArb(fc.constant(1)), { minLength: 1, maxLength: 6 }),
        async (reqs) => {
          catchEnvelopes();
          const r = await round();

          const sent = await sendRound(reqs, "sequential", { ...env, ...MONITORED }, r);

          const refusedValid = sent.filter((s) => s.secret !== "correct" && s.valid !== null);
          // Told apart by the label tag: each message carries its own request id.
          const reports = sentEvents().filter((event) => event.tags?.label === LABEL);
          expect(reports).toHaveLength(refusedValid.length);
          const keys = refusedValid.map((s) => r.valid[s.valid ?? -1]?.storageKey);
          expect(reports.map((event) => event.contexts?.ingest?.storageKey)).toEqual(keys);
          const ids = reports.map((event, i) => {
            const prefix = `${LABEL} ${keys[i]} `;
            expect(event.message?.startsWith(prefix)).toBe(true);
            const id = event.message?.slice(prefix.length) ?? "";
            expect(id).not.toBe("");
            expect(event.contexts?.ingest?.requestId).toBe(id);
            expect(event.fingerprint).toEqual([LABEL]);
            return id;
          });
          expect(new Set(ids).size).toBe(ids.length);
        },
      ),
      { numRuns: 20 },
    );
  });
});
