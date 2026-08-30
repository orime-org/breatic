// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The ingest Worker: where the browser's bytes go (#173, design §4).
 *
 * It sits between the browser and R2 because someone has to hash what
 * actually landed. The browser's own claim about the content decides only
 * whether to move bytes at all; what gets written into the ledger has to be
 * computed over the stored object, and computing it here means reading the
 * object back inside Cloudflare's network, where egress is free.
 *
 * It is authorised entirely by what our server signed. The Worker holds no
 * database and asks us nothing: a ticket carries the key, the studio, the part
 * layout and the size ceiling, all under one HMAC, so every check it performs
 * is against values the browser cannot alter.
 */

import { verifyUploadTicket } from "@breatic/shared";

export { UploadSession } from "@ingest/upload-session.js";

/** What wrangler binds into the Worker. */
export interface Env {
  BUCKET: R2Bucket;
  UPLOAD_SESSION: DurableObjectNamespace;
  /** Signs the ticket we verify, and authenticates the report we send back. */
  INGEST_SHARED_SECRET: string;
  /** Where an upload's outcome is reported. */
  SERVER_REPORT_URL: string;
  /** Comma-separated origins the browser may send parts from. */
  ALLOWED_ORIGINS: string;
}

/**
 * The instance holding one upload's bookkeeping.
 *
 * Addressed by storage key rather than by R2's `uploadId`, because the first
 * request has no upload id yet — the whole point of that request is to get
 * one, and getting the same one back on a retry needs somewhere to have
 * remembered it.
 * @param env - The Worker's bindings.
 * @param storageKey - The key this upload writes to.
 * @returns A stub for that upload's Durable Object.
 */
function sessionFor(env: Env, storageKey: string): DurableObjectStub {
  return env.UPLOAD_SESSION.get(env.UPLOAD_SESSION.idFromName(storageKey));
}

/**
 * Open an upload: verify the ticket, then let the Durable Object decide
 * whether this is a new upload or a retry of one already open.
 * @param request - The browser's request, carrying the ticket in a header.
 * @param env - The Worker's bindings.
 * @returns The instance's answer, or 401 when the ticket does not verify.
 */
async function startUpload(request: Request, env: Env): Promise<Response> {
  const ticket = request.headers.get("x-upload-ticket");
  if (ticket === null) return new Response("Unauthorized", { status: 401 });

  const verified = await verifyUploadTicket(
    ticket,
    env.INGEST_SHARED_SECRET,
    Date.now(),
  );
  if (!verified.ok) return new Response("Unauthorized", { status: 401 });

  // Everything past here depends on what happened before — whether this upload
  // is already open, already finishing, or already done — so the instance that
  // remembers decides it.
  return sessionFor(env, verified.payload.storageKey).fetch(
    new Request("https://session/open", {
      method: "POST",
      body: JSON.stringify(verified.payload),
    }),
  );
}

export default {
  /**
   * Route one request.
   * @param request - The incoming request.
   * @param env - The bound resources and configuration.
   * @param ctx - The execution context, for work that outlives the response.
   * @returns The response.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/uploads") {
      return startUpload(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
