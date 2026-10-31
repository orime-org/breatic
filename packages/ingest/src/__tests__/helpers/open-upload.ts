// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Opening an upload the way our server does (inner#1595).
 *
 * `POST /uploads` is called only by our own services, carrying the shared
 * secret next to the ticket; the browser is handed the upload id and the first
 * token and never holds a ticket. Every test that needs an open upload goes
 * through `openForTest`, so the request that opens one is written once and
 * carries the secret everywhere.
 *
 * `counted()` wraps the real R2 binding to count what reaches it. R2 offers no
 * way to list in-progress multipart uploads, so counting the calls is the only
 * way to say how many uploads a request opened.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { signUploadTicket, type UploadTicketPayload } from "@breatic/shared";
import worker, { type Env } from "@ingest/index.js";

let seq = 0;

/**
 * A ticket the way our server mints one, over a key nothing else uses.
 * @param over - Ticket fields to override.
 * @returns The ticket and the key it names.
 */
export async function mint(
  over: Partial<UploadTicketPayload> = {},
): Promise<{ ticket: string; storageKey: string }> {
  const storageKey = over.storageKey ?? `video/2026-10-26/${seq++}_${crypto.randomUUID()}_open.mp4`;
  const ticket = await signUploadTicket(
    {
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 2,
      partSize: 5 * 1024 * 1024,
      contentType: "video/mp4",
      expiresAt: Date.now() + 300_000,
      deadlineAt: Date.now() + 7_200_000,
      ...over,
      storageKey,
    },
    env.INGEST_SHARED_SECRET,
  );
  return { ticket, storageKey };
}

/** What `POST /uploads` answered, its body already read. */
export interface OpenAnswer {
  status: number;
  /** Present on a 200. */
  uploadId?: string;
  /** Present on a 200. */
  token?: string;
}

/**
 * Send `POST /uploads` with exactly the given headers.
 * @param headers - The request headers.
 * @param e - The bindings the Worker runs with.
 * @returns The status and, on a 200, the upload id and token.
 */
export async function ask(headers: Record<string, string>, e: Env = env): Promise<OpenAnswer> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://ingest.example.com/uploads", { method: "POST", headers }),
    e,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  if (response.status !== 200) return { status: response.status };
  const body = JSON.parse(text) as { uploadId: string; token: string };
  return { status: response.status, uploadId: body.uploadId, token: body.token };
}

/**
 * Open an upload as our server does: the ticket plus the shared secret.
 * @param ticket - The signed ticket.
 * @param e - The bindings the Worker runs with; the secret is read from them.
 * @returns The upload id and the token the first part carries.
 * @throws {Error} When the Worker does not open the upload.
 */
export async function openForTest(
  ticket: string,
  e: Env = env,
): Promise<{ uploadId: string; token: string }> {
  const answer = await ask(
    { "x-upload-ticket": ticket, "x-ingest-secret": e.INGEST_SHARED_SECRET },
    e,
  );
  if (answer.uploadId === undefined || answer.token === undefined) {
    throw new Error(`POST /uploads answered ${answer.status}`);
  }
  return { uploadId: answer.uploadId, token: answer.token };
}

/** Bindings whose bucket counts what reaches it. */
export interface Counted {
  /** The bindings to hand the Worker. */
  env: Env;
  /** `createMultipartUpload` calls, by the storage key they named. */
  opens: Record<string, number>;
  /** Every bucket method called, by name, in order. */
  calls: string[];
}

/**
 * Wrap the real R2 binding so every call is counted, then forwarded unchanged.
 * @param base - The bindings to start from.
 * @returns The wrapped bindings and the counts.
 */
export function counted(base: Env = env): Counted {
  const real = base.BUCKET;
  const opens: Record<string, number> = {};
  const calls: string[] = [];
  const bucket = new Proxy(real, {
    get(_target, prop): unknown {
      const value: unknown = Reflect.get(real, prop);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        calls.push(String(prop));
        if (prop === "createMultipartUpload") {
          const key = String(args[0]);
          opens[key] = (opens[key] ?? 0) + 1;
        }
        return (value as (...a: unknown[]) => unknown).apply(real, args);
      };
    },
  });
  return { env: { ...base, BUCKET: bucket }, opens, calls };
}
