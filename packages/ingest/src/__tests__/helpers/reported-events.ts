// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the real Sentry SDK sent, read back off the fetch mock.
 *
 * The DSN points at a host the fetch mock answers, so an assertion is about
 * the envelope the SDK actually posted. The SDK keeps one client per isolate,
 * made from the settings of the first request it sees, so every request a
 * test file sends carries the same settings.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
} from "cloudflare:test";
import { signUploadTicket, type UploadTicketPayload } from "@breatic/shared";
import worker, { type Env } from "@ingest/index.js";

const SENTRY_ORIGIN = "https://sentry.test.example";
const DSN = "https://publickey@sentry.test.example/1";

/** Where the source a test pulls from lives. */
export const SOURCE_ORIGIN = "https://provider.test.example";

/** The path of that source. */
export const SOURCE_PATH = "/results/out.png";

/** The release every request reports under. */
export const SHA = "4ca3e774ad2bb6b8f9406579ddc4bb611e5037a0";

/** One event out of a Sentry envelope. */
export interface SentEvent {
  release?: string;
  environment?: string;
  message?: string;
  tags?: Record<string, string>;
  exception?: { values: { value?: string }[] };
  request?: { headers?: Record<string, string> };
}

/** The monitoring settings every request runs under. */
const MONITORED: Pick<Env, "SENTRY_DSN" | "SENTRY_RELEASE" | "SENTRY_ENVIRONMENT"> = {
  SENTRY_DSN: DSN,
  SENTRY_RELEASE: SHA,
  SENTRY_ENVIRONMENT: "production",
};

let envelopes: string[] = [];
let seq = 0;

/**
 * Start catching what the SDK posts, forgetting what earlier tests caught.
 * Call it from `beforeEach`, after the fetch mock is active.
 */
export function catchEnvelopes(): void {
  envelopes = [];
  fetchMock
    .get(SENTRY_ORIGIN)
    .intercept({ path: (path) => path.startsWith("/api/1/envelope/"), method: "POST" })
    .reply((request) => {
      envelopes.push(String(request.body));
      return { statusCode: 200, data: "{}" };
    })
    .persist();
}

/**
 * The events the SDK sent, read out of the envelopes it posted.
 * @returns Every event item, in the order sent.
 */
export function sentEvents(): SentEvent[] {
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

/**
 * Ask the Worker to pull the source into a fresh key.
 * @param over - Ticket fields to override.
 * @returns The Worker's answer, its body already read.
 */
export async function pull(over: Partial<UploadTicketPayload> = {}): Promise<Response> {
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

/**
 * Open an upload the way the browser does.
 * @returns The upload's id and the token its first part carries.
 */
export async function openUpload(): Promise<{ uploadId: string; token: string }> {
  const ticket = await signUploadTicket(
    {
      storageKey: `video/2026-10-06/${seq++}_part.mp4`,
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 2,
      partSize: 5 * 1024 * 1024,
      contentType: "video/mp4",
      expiresAt: Date.now() + 300_000,
      sessionTokenTtlSeconds: 900,
    },
    env.INGEST_SHARED_SECRET,
  );
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://ingest.example.com/uploads", {
      method: "POST",
      headers: { "x-upload-ticket": ticket },
    }),
    { ...env, ...MONITORED },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response.json<{ uploadId: string; token: string }>();
}

/**
 * Send one part whose body is the given stream.
 * @param upload - The upload the part belongs to.
 * @param upload.uploadId - Its id.
 * @param upload.token - The token the part carries.
 * @param body - What the part sends.
 * @returns The Worker's answer, its body already read.
 */
export async function sendPart(
  upload: { uploadId: string; token: string },
  body: ReadableStream<Uint8Array>,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://ingest.example.com/uploads/${upload.uploadId}/parts/1`, {
      method: "PUT",
      headers: { "x-upload-token": upload.token },
      body,
      duplex: "half",
    } as RequestInit),
    { ...env, ...MONITORED },
    ctx,
  );
  await response.text();
  await waitOnExecutionContext(ctx);
  return response;
}
