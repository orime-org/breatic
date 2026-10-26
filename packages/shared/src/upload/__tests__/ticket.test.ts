// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload ticket signing and verification (#173 design §4.1).
 *
 * The ticket is minted by our server and verified by the ingest Worker, two
 * runtimes that share no Node API. Both sides call the same functions from
 * this package, which is the only workspace package free of `node:` imports.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  signSessionToken,
  verifySessionToken,
  type SessionTokenPayload,
} from "@shared/upload/session-token.js";
import { signPayload } from "@shared/upload/signed-payload.js";
import {
  MIN_PART_SIZE_BYTES,
  signUploadTicket,
  verifyUploadTicket,
  type UploadTicketPayload,
} from "@shared/upload/ticket.js";

const SECRET = "test-secret-at-least-32-bytes-long-xxxx";

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

function payload(overrides: Partial<UploadTicketPayload> = {}): UploadTicketPayload {
  return {
    storageKey: "1756555200000_0198f0c2-1a2b-7c3d-8e4f-5a6b7c8d9e0f.mp4",
    studioId: "0198f0c2-aaaa-7c3d-8e4f-5a6b7c8d9e01",
    userId: "0198f0c2-bbbb-7c3d-8e4f-5a6b7c8d9e02",
    totalParts: 3,
    partSize: 8 * 1024 * 1024,
    contentType: "video/mp4",
    deadlineAt: Date.now() + 7_200_000,
    expiresAt: NOW + 5 * 60_000,
    ...overrides,
  };
}

describe("signUploadTicket / verifyUploadTicket", () => {
  it("verifies a ticket it just signed and returns the payload unchanged", async () => {
    const p = payload();
    const token = await signUploadTicket(p, SECRET);

    const result = await verifyUploadTicket(token, SECRET, NOW);

    expect(result).toEqual({ ok: true, payload: p });
  });

  it("rejects a ticket whose expiresAt has passed", async () => {
    const token = await signUploadTicket(payload(), SECRET);

    const result = await verifyUploadTicket(token, SECRET, NOW + 6 * 60_000);

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a ticket at the exact expiry instant", async () => {
    const p = payload();
    const token = await signUploadTicket(p, SECRET);

    const result = await verifyUploadTicket(token, SECRET, p.expiresAt);

    expect(result).toEqual({ ok: true, payload: p });
  });

  it("rejects a ticket signed with a different secret", async () => {
    const token = await signUploadTicket(payload(), SECRET);

    const result = await verifyUploadTicket(token, `${SECRET}-other`, NOW);

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a ticket whose totalParts was edited after signing", async () => {
    const token = await signUploadTicket(payload({ totalParts: 3 }), SECRET);
    const [body, signature] = token.split(".");
    const decoded = JSON.parse(atob(body!)) as UploadTicketPayload;
    const forged = `${btoa(JSON.stringify({ ...decoded, totalParts: 9999 }))}.${signature}`;

    const result = await verifyUploadTicket(forged, SECRET, NOW);

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a ticket whose storageKey was edited after signing", async () => {
    const token = await signUploadTicket(payload(), SECRET);
    const [body, signature] = token.split(".");
    const decoded = JSON.parse(atob(body!)) as UploadTicketPayload;
    const forged = `${btoa(JSON.stringify({ ...decoded, storageKey: "someone-elses-key.mp4" }))}.${signature}`;

    const result = await verifyUploadTicket(forged, SECRET, NOW);

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a structurally malformed token without throwing", async () => {
    for (const token of ["", "no-dot", "a.b.c", "!!!.!!!"]) {
      const result = await verifyUploadTicket(token, SECRET, NOW);
      expect(result).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses to sign a ticket whose partSize is under R2's floor", async () => {
    const under = payload({ partSize: MIN_PART_SIZE_BYTES - 1, totalParts: 3 });

    await expect(signUploadTicket(under, SECRET)).rejects.toThrow(/partSize/);
  });

  it("signs a single-part ticket under the floor, since that part is the last one", async () => {
    const small = payload({ partSize: 1024, totalParts: 1 });

    const token = await signUploadTicket(small, SECRET);

    await expect(verifyUploadTicket(token, SECRET, NOW)).resolves.toEqual({
      ok: true,
      payload: small,
    });
  });
});

/** A session token's payload, the fields the Worker's `issueToken` signs. */
function tokenPayload(over: Partial<SessionTokenPayload> = {}): SessionTokenPayload {
  return {
    storageKey: "image/2026-10-26/1_k.png",
    uploadId: "upload-1",
    contentType: "image/png",
    expiresAt: NOW + 900_000,
    partSize: 8 * 1024 * 1024,
    totalParts: 2,
    ...over,
  };
}

const MALFORMED = { ok: false, reason: "malformed" };

// inner#1595 B1: both credentials are signed by one secret, so the ticket
// check must refuse anything shaped like a session token.
describe("a ticket check refuses what is not a ticket (inner#1595 B1)", () => {
  it.each(["upload-1", "", null])(
    "T81: refuses a validly signed ticket payload carrying uploadId %j",
    async (uploadId) => {
      const token = await signPayload({ ...payload(), uploadId }, SECRET);

      await expect(verifyUploadTicket(token, SECRET, NOW)).resolves.toEqual(MALFORMED);
    },
  );

  it("T81: refuses a real session token, and one that also carries every ticket field", async () => {
    const real = await signSessionToken(tokenPayload(), SECRET);
    const both = await signPayload(
      { ...tokenPayload(), studioId: "s", userId: "u", deadlineAt: NOW + 7_200_000 },
      SECRET,
    );

    await expect(verifyUploadTicket(real, SECRET, NOW)).resolves.toEqual(MALFORMED);
    await expect(verifyUploadTicket(both, SECRET, NOW)).resolves.toEqual(MALFORMED);
  });

  const fields = ["userId", "studioId", "storageKey"] as const;
  const bad: [string, (p: Record<string, unknown>, f: string) => void][] = [
    ["missing", (p, f) => { delete p[f]; }],
    ["empty", (p, f) => { p[f] = ""; }],
    ["null", (p, f) => { p[f] = null; }],
    ["a number", (p, f) => { p[f] = 42; }],
  ];
  it.each(fields.flatMap((f) => bad.map(([how, edit]) => [f, how, edit] as const)))(
    "T82: refuses a ticket whose %s is %s",
    async (field, _how, edit) => {
      const p: Record<string, unknown> = { ...payload() };
      edit(p, field);
      const token = await signPayload(p, SECRET);

      await expect(verifyUploadTicket(token, SECRET, NOW)).resolves.toEqual(MALFORMED);
    },
  );

  it.each([null, 42, "s", []])(
    "T82: refuses a signed payload that is not an object (%j) without throwing",
    async (body) => {
      const token = await signPayload(body, SECRET);

      await expect(verifyUploadTicket(token, SECRET, NOW)).resolves.toEqual(MALFORMED);
    },
  );

  it("T84: still verifies the tickets our server signs, and neither reads as a session token", async () => {
    const plain = payload();
    const fromSource = payload({ typeFromSource: true });
    for (const p of [plain, fromSource]) {
      const token = await signUploadTicket(p, SECRET);

      await expect(verifyUploadTicket(token, SECRET, NOW)).resolves.toEqual({ ok: true, payload: p });
      await expect(verifySessionToken(token, SECRET, NOW)).resolves.toBeNull();
    }
  });

  it("P08: no session token payload, with or without ticket fields, verifies as a ticket", async () => {
    const token = fc.record({
      storageKey: fc.string({ minLength: 1 }),
      uploadId: fc.string({ minLength: 1 }),
      contentType: fc.string(),
      expiresAt: fc.integer({ min: NOW, max: NOW + 10 ** 9 }),
      partSize: fc.integer({ min: 1, max: 2 ** 31 }),
      totalParts: fc.integer({ min: 1, max: 10_000 }),
    });
    const extra = fc.option(
      fc.record({
        userId: fc.string({ minLength: 1 }),
        studioId: fc.string({ minLength: 1 }),
        deadlineAt: fc.integer({ min: NOW, max: NOW + 10 ** 9 }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(token, extra, async (p, more) => {
        const signed = more === null
          ? await signSessionToken(p, SECRET)
          : await signPayload({ ...p, ...more }, SECRET);

        expect(await verifyUploadTicket(signed, SECRET, NOW)).toEqual(MALFORMED);
        if (more === null) {
          expect(await verifySessionToken(signed, SECRET, NOW)).toEqual(p);
        }
      }),
      { numRuns: 200 },
    );
  });
});
