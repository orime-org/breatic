// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload ticket signing and verification (#173 design §4.1).
 *
 * The ticket is minted by our server and verified by the ingest Worker, two
 * runtimes that share no Node API. Both sides call the same functions from
 * this package, which is the only workspace package free of `node:` imports.
 */
import { describe, expect, it } from "vitest";

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
    alarmIdleSeconds: 300,
    sessionTokenTtlSeconds: 900,
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
