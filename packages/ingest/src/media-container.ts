// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading an object's media numbers at the edge (#209 + #210, design §3.3).
 *
 * ffmpeg is what reads them, and ffmpeg cannot run in a Worker — so it runs in
 * a container this Worker starts, beside the bucket, while the finish request
 * waits. Waiting is what lets the ledger row be written once: by the time it
 * is written the numbers and the cover are already known, so nothing has to
 * come back later and amend it.
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
import {
  MEDIA_OBJECT_HOST,
  mediaObjectUrl,
  serveOneObject,
} from "@ingest/media-object-route.js";
import {
  PROBE_PATH,
  PROBE_PORT,
  readProbeAnswer,
  type ProbeAnswer,
  type ProbeRequest,
} from "@ingest/probe-answer.js";
import { NOTHING_FOUND } from "@ingest/media-metadata.js";
import type { MediaLimits } from "@breatic/shared";

/** What reading media off a stored object needs bound. */
export interface MediaEnv {
  BUCKET: R2Bucket;
  MEDIA: DurableObjectNamespace<MediaContainer>;
}

/** Which key one instance may read, handed to its outbound handler. */
interface ServeOneKey {
  key: string;
}

/**
 * The media types worth handing to ffmpeg.
 *
 * Everything else — a text file, a PDF, an archive — has none of the three
 * numbers, and starting a container to be told so costs a second per upload.
 */
const PROBEABLE = /^(?:image|video|audio)\//;

/** What one read answered, or nothing when it could not be run. */
const NOTHING_READ: ProbeAnswer = Object.freeze({
  report: NOTHING_FOUND,
  cover: null,
});

/** What the deadline resolves with, telling it apart from what a run answers. */
const UNFINISHED = Symbol("unfinished");

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

/** The name the instance refers to that handler by. */
const SERVE_OBJECT = "serveObject";

MediaContainer.outboundHandlers = { [SERVE_OBJECT]: serveObject };

/**
 * Read one stored object's media numbers, and cut a cover when one is wanted.
 *
 * Answers as nothing found for anything that goes wrong — an unreachable
 * container, a run past the deadline, an unreadable answer. None of it decides
 * whether the upload succeeded: what it decides is whether a node shows a
 * resolution and a poster, and a video without one shows the film icon.
 * @param env - The Worker's bindings.
 * @param about - The object to read.
 * @param about.storageKey - Its key, which is also the only key this run may
 *   read.
 * @param about.contentType - What the ticket signed, which says whether ffmpeg
 *   has anything to say about it.
 * @param about.wantCover - Whether to ask for a frame as well.
 * @param about.limits - How long this run gets, and how long one tool inside
 *   it may take. Both come off `config/storage.yaml` by way of the caller; the
 *   Worker reads no configuration of its own.
 * @returns What the container answered, or nothing found.
 */
export async function readMediaAtEdge(
  env: MediaEnv,
  about: {
    storageKey: string;
    contentType: string;
    wantCover: boolean;
    limits: MediaLimits;
  },
): Promise<ProbeAnswer> {
  if (!PROBEABLE.test(about.contentType)) return NOTHING_READ;

  const instance = env.MEDIA.get(env.MEDIA.idFromName(about.storageKey));
  const asked: ProbeRequest = {
    objectUrl: mediaObjectUrl(about.storageKey),
    wantCover: about.wantCover,
    toolTimeoutMs: about.limits.toolTimeoutMs,
  };

  const answered = await Promise.race([
    (async (): Promise<Response> => {
      // What arrives as `ctx.params` in the handler above. The stub is reached
      // over RPC, whose types carry no generic through, so the link between
      // what is sent and what is read is stated here.
      const authorised: ServeOneKey = { key: about.storageKey };
      await instance.setOutboundByHost(
        MEDIA_OBJECT_HOST,
        SERVE_OBJECT,
        authorised,
      );
      return instance.fetch(
        new Request(`http://media${PROBE_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(asked),
        }),
      );
    })(),
    // Stops the waiting, not the run. Nothing can reach into a container to
    // end one, and what is left behind sleeps on its own.
    new Promise<typeof UNFINISHED>((resolve) => {
      setTimeout(() => resolve(UNFINISHED), about.limits.runDeadlineMs);
    }),
  ]).catch((err: unknown) => {
    console.error("ingest_media_read_failed", {
      storageKey: about.storageKey,
      err: err instanceof Error ? err.stack : String(err),
    });
    return null;
  });

  if (answered === UNFINISHED) {
    // Written down because from the caller's side a run still going is
    // indistinguishable from one that threw — and a cold start on the long
    // tail is the commonest way this step fails. The timer that resolved this
    // is the only thing that could say so, and it says it here rather than
    // where it fires, so a run that answered first never reaches this line.
    console.error("ingest_media_read_unfinished", {
      storageKey: about.storageKey,
      runDeadlineMs: about.limits.runDeadlineMs,
    });
    return NOTHING_READ;
  }
  if (answered === null) return NOTHING_READ;
  if (!answered.ok) {
    console.error("ingest_media_read_refused", {
      storageKey: about.storageKey,
      status: answered.status,
    });
    return NOTHING_READ;
  }
  return readProbeAnswer(answered);
}
