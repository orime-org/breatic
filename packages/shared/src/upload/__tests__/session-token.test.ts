// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Session token verification refuses anything that is not a session token
 * (inner#1595 B1).
 *
 * Tickets and session tokens are signed by the same `signPayload` with the
 * same secret, so a signature alone cannot tell them apart; the payload's
 * shape is what does. Every input here is signed with the real secret and is
 * still in date, so a refusal can only come from the shape.
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

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

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

/** A ticket's payload, the fields `signTicketFor` signs. */
function ticketPayload(): UploadTicketPayload {
  return {
    storageKey: "image/2026-10-26/1_k.png",
    studioId: "studio-1",
    userId: "user-1",
    totalParts: 2,
    partSize: 8 * 1024 * 1024,
    contentType: "image/png",
    expiresAt: NOW + 300_000,
    deadlineAt: NOW + 7_200_000,
  };
}

describe("a session token check refuses what is not a session token", () => {
  const fields = ["uploadId", "storageKey"] as const;
  const bad: [string, (p: Record<string, unknown>, f: string) => void][] = [
    ["missing", (p, f) => { delete p[f]; }],
    ["empty", (p, f) => { p[f] = ""; }],
    ["null", (p, f) => { p[f] = null; }],
    ["a number", (p, f) => { p[f] = 42; }],
  ];
  it.each(fields.flatMap((f) => bad.map(([how, edit]) => [f, how, edit] as const)))(
    "T83: refuses a token whose %s is %s",
    async (field, _how, edit) => {
      const p: Record<string, unknown> = { ...tokenPayload() };
      edit(p, field);
      const token = await signPayload(p, SECRET);

      await expect(verifySessionToken(token, SECRET, NOW)).resolves.toBeNull();
    },
  );

  it("T83: refuses a real ticket", async () => {
    const ticket = await signUploadTicket(ticketPayload(), SECRET);

    await expect(verifySessionToken(ticket, SECRET, NOW)).resolves.toBeNull();
  });

  it.each([null, 42, "s", []])(
    "T83: refuses a signed payload that is not an object (%j) without throwing",
    async (body) => {
      const token = await signPayload(body, SECRET);

      await expect(verifySessionToken(token, SECRET, NOW)).resolves.toBeNull();
    },
  );

  it("T84: still reads the tokens the Worker signs, which never verify as tickets", async () => {
    const p = tokenPayload();
    const token = await signSessionToken(p, SECRET);

    await expect(verifySessionToken(token, SECRET, NOW)).resolves.toEqual(p);
    await expect(verifyUploadTicket(token, SECRET, NOW)).resolves.toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("P07: no ticket our server could sign reads as a session token", async () => {
    const ticket = fc.record(
      {
        storageKey: fc.string({ minLength: 1 }),
        studioId: fc.string({ minLength: 1 }),
        userId: fc.string({ minLength: 1 }),
        totalParts: fc.integer({ min: 1, max: 10_000 }),
        partSize: fc.integer({ min: MIN_PART_SIZE_BYTES, max: 2 ** 31 }),
        contentType: fc.string(),
        expiresAt: fc.integer({ min: NOW, max: NOW + 10 ** 9 }),
        deadlineAt: fc.integer({ min: NOW, max: NOW + 10 ** 9 }),
        typeFromSource: fc.boolean(),
      },
      {
        requiredKeys: [
          "storageKey",
          "studioId",
          "userId",
          "totalParts",
          "partSize",
          "contentType",
          "expiresAt",
          "deadlineAt",
        ],
      },
    );
    await fc.assert(
      fc.asyncProperty(ticket, async (p) => {
        const signed = await signUploadTicket(p, SECRET);

        expect(await verifySessionToken(signed, SECRET, NOW)).toBeNull();
        expect(await verifyUploadTicket(signed, SECRET, NOW)).toEqual({ ok: true, payload: p });
      }),
      { numRuns: 200 },
    );
  });
});
