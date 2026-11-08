// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `POST /read-pages` (inner#1664): our server asks for a set of pages, and a
 * reader instance of the call's own reads them.
 */
import { readPagesRequestSchema } from "@breatic/shared";

import { fromOurBackend } from "@ingest/backend-secret.js";
import type { WebReaderContainer } from "@ingest/web-reader-container.js";

/** What the route reads from the Worker's bindings. */
export interface WebReaderEnv {
  INGEST_SHARED_SECRET: string;
  WEB_READER: DurableObjectNamespace<WebReaderContainer>;
}

/**
 * Read the pages a request names, in an instance of their own.
 *
 * When the caller goes, the instance is stopped: Workers RPC cannot carry an
 * abort signal into the object, so the stop is a call of its own.
 * @param request - The request.
 * @param env - The bindings.
 * @returns 200 with the pages, 401 without the secret, 400 for a body that is
 *   not a read-pages request, 499 when the caller went before the answer.
 * @throws {Error} When the reader failed while the caller was still waiting.
 */
export async function readPages(request: Request, env: WebReaderEnv): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  const parsed = readPagesRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response("Not a read-pages request", { status: 400 });

  const reader = env.WEB_READER.get(env.WEB_READER.idFromName(crypto.randomUUID()));
  const stop = (): void => {
    void reader.stop();
  };
  request.signal.addEventListener("abort", stop, { once: true });
  try {
    return Response.json(await reader.read(parsed.data));
  } catch (err) {
    // Nobody is waiting for this answer, and the reader ended because of it.
    if (request.signal.aborted) return new Response("The caller left", { status: 499 });
    throw err;
  } finally {
    request.signal.removeEventListener("abort", stop);
  }
}
