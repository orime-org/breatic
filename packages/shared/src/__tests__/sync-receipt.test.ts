// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ZodType } from "zod";
import { existsSync } from "node:fs";
import * as publicApi from "../index.js";

interface ReceiptModule {
  SyncConfirmRequestSchema: ZodType<{ type: "sync:confirm"; id: string }>;
  SyncConfirmedResponseSchema: ZodType<{ type: "sync:confirmed"; id: string; ok: boolean }>;
}

const ID = "11111111-1111-4111-8111-111111111111";

/**
 * Loads the protocol implementation through the same boundary as its consumers.
 * @returns The actual schemas.
 * @throws {AssertionError} When the approved protocol module is absent.
 */
async function schemas(): Promise<ReceiptModule> {
  const path = "../sync-receipt.ts";
  expect(existsSync(new URL(path, import.meta.url)), "the document sync receipt schemas must exist").toBe(true);
  return import(path) as Promise<ReceiptModule>;
}

describe("document sync receipt contract (inner#1641)", () => {
  it("exports both schemas from the shared public entry", async () => {
    const protocol = await schemas();
    expect(publicApi).toHaveProperty("SyncConfirmRequestSchema", protocol.SyncConfirmRequestSchema);
    expect(publicApi).toHaveProperty("SyncConfirmedResponseSchema", protocol.SyncConfirmedResponseSchema);
  });

  it("preserves a request and either response for arbitrary valid UUIDs", async () => {
    const protocol = await schemas();
    fc.assert(fc.property(fc.uuid(), fc.boolean(), (id, ok) => {
      const request = { type: "sync:confirm", id };
      const response = { type: "sync:confirmed", id, ok };
      expect(protocol.SyncConfirmRequestSchema.parse(request)).toEqual(request);
      expect(protocol.SyncConfirmedResponseSchema.parse(response)).toEqual(response);
    }), { seed: 1641, numRuns: 100 });
  });

  it.each([
    {}, { type: "sync:confirm" }, { id: ID },
    { type: "sync:confirmed", id: ID },
    { type: "sync:confirm", id: "" },
    { type: "sync:confirm", id: "request-1" },
    { type: "sync:confirm", id: 1 },
    { type: "sync:confirm", id: ID, ok: true },
    { type: "sync:confirm", id: ID, payload: {} },
    null, [], "sync:confirm",
  ].map((input) => ({ input })))("rejects a malformed request: $input", async ({ input }) => {
    const protocol = await schemas();
    expect(protocol.SyncConfirmRequestSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    {}, { type: "sync:confirmed", id: ID },
    { type: "sync:confirm", id: ID, ok: true },
    { type: "sync:confirmed", id: "", ok: true },
    { type: "sync:confirmed", id: "request-1", ok: true },
    { type: "sync:confirmed", id: ID, ok: "true" },
    { type: "sync:confirmed", id: ID, ok: 1 },
    { type: "sync:confirmed", id: ID, ok: true, result: {} },
    null, [], "sync:confirmed",
  ].map((input) => ({ input })))("rejects a malformed response: $input", async ({ input }) => {
    const protocol = await schemas();
    expect(protocol.SyncConfirmedResponseSchema.safeParse(input).success).toBe(false);
  });
});
