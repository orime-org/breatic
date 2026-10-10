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
import { noteFailure } from "@ingest/error-monitoring.js";
import { mediaNumbersFor } from "@ingest/media-metadata.js";
import { MEDIA_OBJECT_HOST, mediaObjectUrl, serveOneObject } from "@ingest/media-object-route.js";
import { PROBE_PATH, PROBE_PORT, readProbeAnswer, type ProbeRequest } from "@ingest/probe-answer.js";
import {
  SERVE_OBJECT,
  type MediaEnv,
  type ServeOneKey,
} from "@ingest/media-read.js";
import type { RecordedPart } from "@ingest/stored-object.js";
import {
  UprightArbiter,
  type ArbiterAnswer,
  type ArbiterAsk,
  type UprightRunAnswer,
  type UprightRunRequest,
} from "@ingest/upright-arbiter.js";
import { UPRIGHT_OBJECT_HOST, uprightObjectUrl } from "@ingest/upright-run.js";
import { WRITE_UPRIGHT, writeUprightVia, type UprightWrite } from "@ingest/upright-write.js";

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

  /** This key's upright arbiter (inner#1367), over this object's storage. */
  readonly #arbiter: UprightArbiter;

  /**
   * The instance, with its arbiter.
   * @param ctx - The object's state.
   * @param env - The Worker's bindings.
   */
  constructor(ctx: ConstructorParameters<typeof Container>[0], env: MediaEnv) {
    super(ctx, env);
    this.#arbiter = new UprightArbiter({
      storage: ctx.storage,
      bucket: env.BUCKET,
      exclusive: (fn) => ctx.blockConcurrencyWhile(fn),
      runContainer: (request) => this.#runUpright(request),
      log: (label, failure, err) => noteFailure(label, failure, err),
      now: () => Date.now(),
    });
  }

  /**
   * Ask for this key to be turned upright, or seal it.
   * @param ask - What one finish asks.
   * @returns Whether it was turned upright, with what the run measured.
   */
  askUpright(ask: ArbiterAsk): Promise<ArbiterAnswer> {
    return this.#arbiter.ask(ask);
  }

  /**
   * Complete or abort a write-back the outbound handler staged.
   * @param commit - The staged write-back.
   * @param commit.storageKey - The key it writes to.
   * @param commit.uploadId - R2's id for the multipart upload.
   * @param commit.parts - The parts that landed.
   * @returns Whether it now stands at the key.
   */
  commitUpright(commit: { storageKey: string; uploadId: string; parts: RecordedPart[] }): Promise<boolean> {
    return this.#arbiter.commit(commit);
  }

  /**
   * One upright run: turn, write back, then probe and cut a preview of what
   * was written. Awaited by the arbiter, so the request in flight keeps the
   * container up for as long as the run takes.
   * @param request - What the arbiter asks.
   * @returns How the run ended.
   */
  async #runUpright(request: UprightRunRequest): Promise<UprightRunAnswer> {
    const serve: ServeOneKey = { key: request.storageKey };
    const write: UprightWrite = {
      key: request.storageKey,
      receivedSha256: request.receivedSha256,
      httpMetadata: request.httpMetadata,
    };
    const asked: ProbeRequest = {
      objectUrl: mediaObjectUrl(request.storageKey),
      wantCover: false,
      wantPreview: true,
      toolTimeoutMs: request.toolTimeoutMs,
      deadlineAt: request.deadlineAt,
      upright: {
        writeUrl: uprightObjectUrl(request.storageKey),
        contentType: request.contentType,
        lossless: request.lossless,
        quality: request.quality,
      },
    };
    let answered: Response;
    try {
      await this.setOutboundByHost(MEDIA_OBJECT_HOST, SERVE_OBJECT, serve);
      await this.setOutboundByHost(UPRIGHT_OBJECT_HOST, WRITE_UPRIGHT, write);
      answered = await this.containerFetch(
        new Request(`http://media${PROBE_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(asked),
        }),
      );
    } catch (err) {
      noteFailure("ingest_upright_run_failed", { storageKey: request.storageKey }, err);
      return { kind: "failed" };
    }
    // The library answers 503 while every instance this deployment may run is
    // taken; the arbiter asks again while the finish still has time.
    if (answered.status === 503) {
      await answered.body?.cancel();
      return { kind: "noInstance" };
    }
    if (!answered.ok) {
      await answered.body?.cancel();
      return { kind: "failed" };
    }
    const read = await readProbeAnswer(answered);
    if (!read.answered) return { kind: "failed" };
    return { kind: "measured", media: mediaNumbersFor(request.contentType, read.report), preview: read.preview };
  }
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

MediaContainer.outboundHandlers = {
  [SERVE_OBJECT]: serveObject,
  [WRITE_UPRIGHT]: writeUprightVia((env, ctx) => {
    const media = (env as MediaEnv).MEDIA;
    return media.get(media.idFromString(ctx.containerId));
  }),
};
