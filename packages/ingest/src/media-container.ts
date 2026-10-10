// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The container that holds ffmpeg (#209 + #210, design §3.3).
 *
 * ffmpeg is what reads an object's media numbers, and ffmpeg cannot run in a
 * Worker — so it runs in a container this Worker starts, beside the bucket,
 * while the finish request waits. Waiting is what lets the ledger row be
 * written once: by the time it is written the numbers and the cover are
 * already known, so nothing has to come back later and amend it. Starting one
 * and waiting under a deadline is the edge side, in `media-read.ts`, which is
 * also where the vocabulary the two sides share is declared.
 *
 * What runs in there is ffmpeg parsing bytes a user uploaded, so the container
 * is given nothing it could reach with: no credentials, no internet, and one
 * object. Three things make that true, and each of them is a separate refusal
 * — `enableInternet` off, so the only way out is the handler below; one key per
 * instance, so a request for any other key is refused by name; and ffmpeg's own
 * `-protocol_whitelist http,tcp`, so a crafted file cannot even ask for a
 * protocol that reaches elsewhere (#215).
 */

import { Container } from "@cloudflare/containers";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { serveOneObject } from "@ingest/media-object-route.js";
import { PROBE_PORT } from "@ingest/probe-answer.js";
import {
  SERVE_OBJECT,
  type MediaEnv,
  type ServeOneKey,
} from "@ingest/media-read.js";

/**
 * How long an idle instance is kept before it is stopped.
 *
 * An instance serves one upload, so once it has answered there is nothing left
 * for it to be kept warm for: the key it is named after carries a uuid and is
 * never asked about twice. A re-delivered finish for a video answers out of the
 * frame already standing; for an image or an audio file, which ask for no
 * cover, it runs again — either way the instance serves one delivery, not a
 * stream of them. Every second past the answer holds one of the instances a
 * deployment may run at once against an upload that will never come.
 *
 * What an instance is held for is the run itself, and the library covers that
 * on its own: a request in flight renews the timeout whatever this says.
 */
export const IDLE_BEFORE_STOP = "10s";

/**
 * The container that holds ffprobe and ffmpeg.
 *
 * One instance per storage key, which is what makes the outbound handler's
 * authorisation per-key: the key is set on the instance, and an instance
 * serves one upload. The cost is a cold start per upload rather than a warm
 * pool; a pool would mean an instance whose handler is authorised for one key
 * while another upload's bytes are being parsed in it.
 */
export class MediaContainer extends Container<MediaEnv> {
  defaultPort = PROBE_PORT;

  sleepAfter = IDLE_BEFORE_STOP;

  /**
   * No route out but the handler below. Every other host the runtime is asked
   * for is refused by the proxy rather than reaching the network.
   */
  enableInternet = false;

  /**
   * Carries that refusal to HTTPS as well.
   *
   * The line above is what makes the refusal true; this decides where it
   * happens. Without it an HTTPS attempt fails at the network with nothing
   * having judged it; with it the same attempt reaches the proxy, which
   * refuses it by the same rule as every other host.
   */
  interceptHttps = true;
}

/**
 * Answer the container's reads, for the one key its run is about.
 * @param request - What the container asked for.
 * @param env - The Worker's bindings, which is where the bucket is.
 * @param ctx - The instance's context, carrying the key it was started for.
 * @returns The object, a range of it, or a refusal.
 */
function serveObject(
  request: Request,
  env: MediaEnv,
  ctx: OutboundHandlerContext<ServeOneKey>,
): Promise<Response> {
  return serveOneObject(request, env.BUCKET, ctx.params.key);
}

MediaContainer.outboundHandlers = { [SERVE_OBJECT]: serveObject };
