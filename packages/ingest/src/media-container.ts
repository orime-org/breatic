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
 * object to read (plus, in an upright run, the one upright copy to write).
 * Three things make that true, and each of them is a separate refusal —
 * `enableInternet` off, so the only ways out are the two handlers below; each
 * serves only the key the run was set up for, so a request for any other key
 * is refused by name; and ffmpeg's own
 * `-protocol_whitelist http,tcp`, so a crafted file cannot even ask for a
 * protocol that reaches elsewhere (#215).
 */

import { Container } from "@cloudflare/containers";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { askedKey } from "@ingest/object-url.js";
import { objectUrlOn } from '@ingest/object-url.js';
import { mediaObjectUrl, MEDIA_OBJECT_HOST } from '@ingest/media-object-route.js';
import { alphaPackedKeyFor, videoPresentationOriginalSchema, type VideoPresentationIngestSnapshot } from '@breatic/shared';
import { VideoPresentationStore, type VideoPresentationAdmission } from '@ingest/video-presentation-store.js';
import type { AcceptedVideoPresentationAttempt } from '@ingest/video-presentation-state.js';
import { ALPHA_RUN_PATH, ALPHA_REPORT_HOST, ALPHA_REPORT_HANDLER, ALPHA_PACKED_HOST, type AlphaPresentationReport, type AlphaRunBody } from '@ingest/alpha-run-contract.js';
import { noteFailure } from '@ingest/error-monitoring.js';
import { serveOneObject } from "@ingest/media-object-route.js";
import { writeStreamedObject } from "@ingest/stored-object.js";
import {
  UPRIGHT_HEIGHT_HEADER,
  UPRIGHT_WIDTH_HEADER,
  WRITE_UPRIGHT,
  type UprightWriteGrant,
} from "@ingest/upright-run.js";
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

  private readonly presentationRuns = new Map<string, Promise<VideoPresentationIngestSnapshot>>();

  /**
   * Resolve persisted source facts without starting another container.
   * @param storageKey - Registered canonical key.
   * @param sourceFingerprint - Its registered hash.
   * @returns Verified current presentation and accepted work.
   * @throws {Error} When durable storage or R2 fails.
   */
  async readPresentation(storageKey: string, sourceFingerprint: string): Promise<VideoPresentationIngestSnapshot> {
    const store = this.presentationStore();
    const snapshot = await store.read(storageKey, sourceFingerprint);
    const attempt = snapshot.attempt;
    return attempt !== null && (attempt.status === 'accepted' || attempt.status === 'running') && attempt.deadlineAt <= Date.now()
      ? store.fail({ ...attempt, sourceFingerprint }, 'expired') : snapshot;
  }

  /**
   * Accept or replay one canonical presentation job.
   * @param admission - Trusted registry facts and original work deadline.
   * @returns Fixed durable work identity.
   * @throws {Error} When durable admission fails.
   */
  acceptPresentation(admission: VideoPresentationAdmission): Promise<VideoPresentationIngestSnapshot> {
    return this.presentationStore().accept(admission);
  }

  /**
   * Apply one capability-bound container report.
   * @param fact - Trusted probe, geometry or measured usage.
   * @returns Whether the original owner accepted it.
   * @throws {Error} When persistence fails.
   */
  reportPresentation(fact: AlphaPresentationReport): Promise<boolean> { return this.presentationStore().report(fact); }

  /**
   * Stop an expired attempt without extending its budget.
   * @param identity - Originally accepted work.
   * @returns Current source state.
   * @throws {Error} When persistence fails.
   */
  expirePresentation(identity: AcceptedVideoPresentationAttempt): Promise<VideoPresentationIngestSnapshot> { return this.presentationStore().fail(identity, 'expired'); }

  /**
   * Acknowledge one already-recorded platform usage fact.
   * @param identity - Its original source and job identity.
   * @returns Durable acknowledgement without another charge or media run.
   * @throws {Error} When persistence fails.
   */
  acknowledgePresentationUsage(identity: AcceptedVideoPresentationAttempt): Promise<VideoPresentationIngestSnapshot> { return this.presentationStore().acknowledgeUsage(identity); }

  /**
   * Run the accepted probe under one request that keeps the shared container active.
   * @param identity - Fixed accepted identity and deadline.
   * @returns Actual current facts after complete reporting.
   * @throws {Error} When durable state cannot be read.
   */
  runPresentation(identity: AcceptedVideoPresentationAttempt): Promise<VideoPresentationIngestSnapshot> {
    const existing = this.presentationRuns.get(identity.jobId);
    if (existing !== undefined) return existing;
    const running = this.executePresentation(identity);
    this.presentationRuns.set(identity.jobId, running);
    void running.then(() => this.presentationRuns.delete(identity.jobId), (err: unknown) => {
      this.presentationRuns.delete(identity.jobId);
      noteFailure('ingest_video_presentation_storage_failed', { err, jobId: identity.jobId });
    });
    return running;
  }

  /**
   * Bind one source-only container request and retain its original execution lifetime.
   * @param identity - Fixed accepted source work.
   * @returns Durable source and expense facts.
   * @throws {Error} When storage cannot retain a failure.
   */
  private async executePresentation(identity: AcceptedVideoPresentationAttempt): Promise<VideoPresentationIngestSnapshot> {
    const store = this.presentationStore();
    if (identity.deadlineAt <= Date.now()) return store.fail(identity, 'expired');
    const prepared = await store.prepare(identity);
    const admission = prepared.admission;
    if (admission === null || prepared.token === null) return prepared.snapshot;
    if (admission.limits === undefined || admission.pricing === undefined) return store.fail(identity, 'admission_invalid');
    const source = await this.env.BUCKET.head(admission.storageKey);
    if (source === null) return store.fail(identity, 'source_missing');
    if (source.size > admission.limits.maxSourceBytes) return store.fail(identity, 'source_over_cap');
    try {
      await this.setOutboundByHost(MEDIA_OBJECT_HOST, SERVE_OBJECT, { key: admission.storageKey });
      await this.setOutboundByHost(ALPHA_REPORT_HOST, ALPHA_REPORT_HANDLER, { key: admission.storageKey });
      const outputURL = new URL(objectUrlOn(ALPHA_PACKED_HOST, alphaPackedKeyFor(admission.storageKey)));
      outputURL.search = new URLSearchParams({ jobId: identity.jobId, sourceFingerprint: identity.sourceFingerprint, deadlineAt: String(identity.deadlineAt), token: prepared.token }).toString();
      const body: AlphaRunBody = { ...identity, token: prepared.token, sourceURL: mediaObjectUrl(admission.storageKey), outputURL: outputURL.toString(),
        reportURL: objectUrlOn(ALPHA_REPORT_HOST, admission.storageKey), limits: admission.limits, vcpu: admission.pricing.size.vcpu };
      const answer = await super.fetch(new Request(`http://media${ALPHA_RUN_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      if (!answer.ok) return store.fail(identity, 'presentation_failed');
      const result = await answer.json<{ ok?: boolean; error?: string }>();
      if (result.ok !== true) return store.fail(identity, typeof result.error === 'string' && /^[a-z][a-z0-9_]*$/.test(result.error) ? result.error : 'presentation_failed');
      return store.snapshotFor(identity);
    } catch (err) {
      noteFailure('ingest_video_presentation_failed', { err, jobId: identity.jobId, sourceFingerprint: identity.sourceFingerprint });
      return store.fail(identity, identity.deadlineAt <= Date.now() ? 'expired' : 'presentation_failed');
    }
  }

  /**
   * Construct the sole storage owner with this object's actual durable serialization gate.
   * @returns The canonical presentation persistence owner.
   * @throws {never} No IO starts while the owner is constructed.
   */
  private presentationStore(): VideoPresentationStore {
    return new VideoPresentationStore(this.ctx.storage, this.env.BUCKET, work => this.ctx.blockConcurrencyWhile(work));
  }
}

/**
 * Accept only a report scoped to the source this container may read.
 * @param request - Container report delivered through its private outbound host.
 * @param env - Actual R2 and canonical durable object bindings.
 * @param ctx - The one authorized source key.
 * @returns Durable acknowledgement or a refusal.
 * @throws {Error} When durable reporting fails.
 */
export async function reportAlphaPresentation(request: Request, env: MediaEnv, ctx: OutboundHandlerContext<ServeOneKey>): Promise<Response> {
  if (request.method !== 'POST' || askedKey(request) !== ctx.params.key) return new Response('Not allowed', { status: 403 });
  const value = await request.json<Record<string, unknown>>().catch(() => null);
  if (value === null || typeof value.jobId !== 'string' || typeof value.sourceFingerprint !== 'string' || typeof value.deadlineAt !== 'number' || typeof value.token !== 'string') return new Response('Invalid report', { status: 400 });
  if (value.kind === 'probe' && (!videoPresentationOriginalSchema.safeParse(value.original).success || (value.classification !== 'confirmed_alpha' && value.classification !== 'confirmed_opaque'))) return new Response('Invalid probe', { status: 400 });
  if (value.kind !== 'probe' && value.kind !== 'encoded' && value.kind !== 'finished') return new Response('Invalid report', { status: 400 });
  if (value.kind === 'finished') {
    const usage = value.usage as { wallMs?: unknown; cpuUsec?: unknown } | undefined;
    if (usage === undefined || typeof usage.wallMs !== 'number' || !Number.isFinite(usage.wallMs) || usage.wallMs < 0 || (usage.cpuUsec !== null && (typeof usage.cpuUsec !== 'number' || !Number.isFinite(usage.cpuUsec) || usage.cpuUsec < 0))) return new Response('Invalid usage', { status: 400 });
  }
  const instance = env.MEDIA.get(env.MEDIA.idFromName(ctx.params.key));
  const accepted = await instance.reportPresentation(value as unknown as AlphaPresentationReport);
  return new Response(null, { status: accepted ? 200 : 409 });
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

/** The size of every part of an upright copy but the last. */
const UPRIGHT_PART_SIZE = 8 * 1024 * 1024;

/**
 * A pixel size the container stated, as the object's metadata holds it.
 * @param stated - The header's value.
 * @returns The value, or null when it is not a positive integer.
 */
function pixelsStated(stated: string | null): string | null {
  return stated !== null && /^[1-9]\d{0,9}$/.test(stated) ? stated : null;
}

/**
 * Take the upright picture the container turned, and store it at the one key
 * this run was set up to write (inner#1367 §4.4).
 *
 * The pixel size the container measured goes onto the object, so a
 * re-delivery of the finish answers the copy's size from the object without
 * turning it again; it starts a run only to cut a preview that is missing.
 * @param request - The container's PUT.
 * @param env - The Worker's bindings, which is where the bucket is.
 * @param ctx - The instance's context, carrying what it may write.
 * @returns 200 once stored; 403 for another key; 413 over the ceiling.
 */
export async function writeUpright(
  request: Request,
  env: MediaEnv,
  ctx: OutboundHandlerContext<UprightWriteGrant>,
): Promise<Response> {
  const grant = ctx.params;
  if (request.method !== "PUT" || request.body === null) {
    return new Response("Not allowed", { status: 405 });
  }
  const asked = askedKey(request);
  if (asked !== grant.key) return new Response("Not this object", { status: 403 });

  const width = pixelsStated(request.headers.get(UPRIGHT_WIDTH_HEADER));
  const height = pixelsStated(request.headers.get(UPRIGHT_HEIGHT_HEADER));
  const stored = await writeStreamedObject(env.BUCKET, grant.key, request.body, {
    contentType: grant.contentType,
    customMetadata: {
      ...(width !== null && { width }),
      ...(height !== null && { height }),
    },
    partSize: UPRIGHT_PART_SIZE,
    maxBytes: grant.maxBytes,
  });
  if (stored === "over_cap") return new Response("Too large", { status: 413 });
  return new Response(null, { status: 200 });
}

MediaContainer.outboundHandlers = {
  [SERVE_OBJECT]: serveObject,
  [WRITE_UPRIGHT]: writeUpright,
  [ALPHA_REPORT_HANDLER]: reportAlphaPresentation,
};
