// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The ingest Worker's `POST /uploads`, stood in for server integration tests
 * (inner#1595 test spec §0.4, design §7.2).
 *
 * The server opens every upload itself now, with the shared secret, before it
 * answers the browser. Integration tests run the real routes, the real
 * database and the real domain, and only this one call to the Worker is
 * replaced: `openUploadAtIngest` in `@breatic/shared` becomes a counter that
 * verifies the ticket it is handed, records the call, and answers the way the
 * current mode says. A file uses it with
 *
 * ```ts
 * vi.mock("@breatic/shared", async (importOriginal) =>
 *   (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
 * );
 * ```
 *
 * The answer it gives on success is what the Worker's own `issueToken` would
 * sign (`packages/ingest/src/index.ts`), so the browser's later
 * `POST /assets/uploads/:uploadId/complete` passes `requireUploadSession`
 * against it unchanged.
 *
 * This module must not import `@breatic/shared` at runtime: it is loaded from
 * inside that module's mock factory, so the real exports come in through
 * `importOriginal` instead.
 */

import type * as Shared from "@breatic/shared";

/** What the caller bounds the open with. */
export interface OpenBound {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/** One call the double received. */
export interface OpenCall {
  /** The key the ticket was signed for. */
  storageKey: string;
  /** The ticket exactly as the server sent it. */
  ticket: string;
  /** What the ticket says, as the Worker's verifier reads it. */
  payload: Shared.UploadTicketPayload;
  /** The secret the server sent alongside. */
  secret: string;
  /** The deadline and stop signal the server bound the call with. */
  bound: OpenBound | undefined;
  /** When the call arrived, in epoch ms. */
  at: number;
  /** What the double answered with, when it answered at all. */
  answer?: { uploadId: string; token: string };
}

/**
 * How the double answers a key: `"ok"` opens the upload; anything else is
 * thrown as the open's failure. It may answer later, to hold a call open.
 */
export type OpenMode = (storageKey: string) => unknown;

const calls: OpenCall[] = [];
let mode: OpenMode = () => "ok";
let seq = 0;

/**
 * The secret the server is configured with, read when a call arrives.
 * @returns The shared secret the integration environment hands the server.
 */
function serverSecret(): string {
  return process.env.INGEST_SHARED_SECRET ?? "";
}

/**
 * Build `@breatic/shared` with `openUploadAtIngest` replaced by the double.
 * @param importOriginal - Vitest's loader for the real module.
 * @returns The real module's exports with the one function replaced.
 */
export async function sharedWithOpenDouble(
  importOriginal: () => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const real = (await importOriginal()) as typeof Shared;

  /**
   * The double itself: verify, record, answer.
   * @param target - The upload to open, ticket included.
   * @param secret - The shared secret the server sends.
   * @param bound - The caller's deadline and stop signal.
   * @returns The upload id and first session token, as the Worker answers.
   * @throws {Error} When the ticket does not verify against the server's secret.
   * @throws {unknown} Whatever the current mode answers instead of `"ok"`.
   */
  const openUploadAtIngest = async (
    target: Shared.IngestTarget,
    secret: string,
    bound?: OpenBound,
  ): Promise<{ uploadId: string; token: string }> => {
    const at = Date.now();
    const verified = await real.verifyUploadTicket(target.ticket, serverSecret(), at);
    if (!verified.ok) {
      throw new Error(`the open double was handed a ticket that does not verify: ${verified.reason}`);
    }
    const { payload } = verified;
    const call: OpenCall = { storageKey: payload.storageKey, ticket: target.ticket, payload, secret, bound, at };
    calls.push(call);

    const outcome = await mode(payload.storageKey);
    if (outcome !== "ok") throw outcome;

    const uploadId = `double-${++seq}`;
    const token = await real.signSessionToken(
      {
        storageKey: payload.storageKey,
        uploadId,
        contentType: payload.contentType,
        expiresAt: payload.deadlineAt,
        partSize: payload.partSize,
        totalParts: payload.totalParts,
      },
      serverSecret(),
    );
    call.answer = { uploadId, token };
    return call.answer;
  };

  return { ...(real as unknown as Record<string, unknown>), openUploadAtIngest };
}

/**
 * Every call received since the last reset, in arrival order.
 * @returns The calls.
 */
export function openCalls(): readonly OpenCall[] {
  return calls;
}

/**
 * How many times each key was opened since the last reset.
 * @returns Key to number of calls.
 */
export function opensByKey(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.storageKey, (counts.get(call.storageKey) ?? 0) + 1);
  return counts;
}

/**
 * The call for one key; fails the test when there is not exactly one.
 * @param storageKey - The key.
 * @returns Its only call.
 * @throws {Error} When the key was opened zero times or more than once.
 */
export function onlyOpenOf(storageKey: string): OpenCall {
  const mine = calls.filter((call) => call.storageKey === storageKey);
  if (mine.length !== 1) throw new Error(`${storageKey} was opened ${mine.length} times, not once`);
  return mine[0]!;
}

/**
 * Choose how the double answers from now on.
 * @param next - Called with each key; `"ok"` opens, anything else is thrown.
 */
export function setOpenMode(next: OpenMode): void {
  mode = next;
}

/** Forget every call and answer `"ok"` again; call it in `beforeEach`. */
export function resetOpenDouble(): void {
  calls.length = 0;
  mode = () => "ok";
}
