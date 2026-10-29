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
import { alphaPackedKeyFor, videoPresentationOriginalSchema, videoSourceLedgerKeyFor, type VideoPresentationIngestSnapshot } from '@breatic/shared';
import { VideoPresentationStore, type VideoPresentationAdmission, type AlphaPackedIdentity, type AlphaPackedWriteClaim, type AlphaPackedReceipt,
  type SourceLedgerDeclaration, type SourceLedgerMeasurement, type SourceLedgerWriteClaim } from '@ingest/video-presentation-store.js';
import { writeAlphaPacked } from '@ingest/video-presentation-packed.js';
import { writeVideoSourceLedger } from '@ingest/video-source-ledger-write.js';
import type { AcceptedVideoPresentationAttempt } from '@ingest/video-presentation-state.js';
import { ALPHA_RUN_PATH, ALPHA_REPORT_HOST, ALPHA_REPORT_HANDLER, ALPHA_PACKED_HOST, ALPHA_PACKED_HANDLER, SOURCE_LEDGER_HOST, SOURCE_LEDGER_HANDLER,
  type AlphaPresentationReport, type AlphaRunBody } from '@ingest/alpha-run-contract.js';
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
   * Claim packed bytes before the outbound handler can write R2.
   * @param identity - Originally accepted private capability.
   * @param byteLength - Complete length enforced by the actual storage stream.
   * @returns One physical writer or a refusal.
   * @throws {Error} When durable state cannot be read.
   */
  claimPacked(identity: AlphaPackedIdentity, byteLength: number): Promise<AlphaPackedWriteClaim | null> { return this.presentationStore().claimPacked(identity, byteLength); }

  /**
   * Retain an actual physical receipt before publishing the current manifest.
   * @param identity - Originally accepted private capability.
   * @param owner - Durable pre-write owner.
   * @param receipt - Actual measured stored bytes.
   * @returns Whether current readiness committed.
   * @throws {Error} When storage fails.
   */
  completePacked(identity: AlphaPackedIdentity, owner: string, receipt: AlphaPackedReceipt): Promise<boolean> { return this.presentationStore().completePacked(identity, owner, receipt); }

  /**
   * Release only the failed stream's own pre-write claim.
   * @param identity - Originally accepted private capability.
   * @param owner - Failed physical writer.
   * @returns Nothing after exact release.
   * @throws {Error} When storage fails.
   */
  releasePacked(identity: AlphaPackedIdentity, owner: string): Promise<void> { return this.presentationStore().releasePacked(identity, owner); }

  /**
   * Claim both ledger objects before the outbound handler can write R2.
   * @param identity - Originally accepted private capability.
   * @param declaration - The producer's declared ledger and table lengths and frame count.
   * @returns One physical writer or a refusal.
   * @throws {Error} When durable state or R2 cannot be read.
   */
  claimSourceLedger(identity: AlphaPackedIdentity, declaration: SourceLedgerDeclaration): Promise<SourceLedgerWriteClaim | null> {
    return this.presentationStore().claimSourceLedger(identity, declaration);
  }

  /**
   * Commit the measured ledger and table under their still active claim.
   * @param identity - Originally accepted private capability.
   * @param owner - Durable pre-write owner.
   * @param measured - Actual measured stored bytes of both objects.
   * @returns Whether the ready ledger committed.
   * @throws {Error} When storage fails.
   */
  completeSourceLedger(identity: AlphaPackedIdentity, owner: string, measured: SourceLedgerMeasurement): Promise<boolean> {
    return this.presentationStore().completeSourceLedger(identity, owner, measured);
  }

  /**
   * Release only the failed ledger write's own claim.
   * @param identity - Originally accepted private capability.
   * @param owner - Failed physical writer.
   * @returns Nothing after exact release.
   * @throws {Error} When storage fails.
   */
  releaseSourceLedger(identity: AlphaPackedIdentity, owner: string): Promise<void> { return this.presentationStore().releaseSourceLedger(identity, owner); }

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
    // This job produces a ledger only when it owns a pending one; a settled ledger is never produced again.
    const ledger = prepared.snapshot.sourceLedger;
    const producesLedger = ledger?.state === 'pending' && ledger.attempt.jobId === identity.jobId && admission.limits.sourceLedger !== undefined &&
      admission.sourceLedgerURL !== undefined && admission.sourceLedgerTableURL !== undefined;
    const { sourceLedger: _ledgerLimits, ...presentationLimits } = admission.limits;
    try {
      await this.setOutboundByHost(MEDIA_OBJECT_HOST, SERVE_OBJECT, { key: admission.storageKey });
      await this.setOutboundByHost(ALPHA_REPORT_HOST, ALPHA_REPORT_HANDLER, { key: admission.storageKey });
      await this.setOutboundByHost(ALPHA_PACKED_HOST, ALPHA_PACKED_HANDLER, { key: admission.storageKey });
      if (producesLedger) await this.setOutboundByHost(SOURCE_LEDGER_HOST, SOURCE_LEDGER_HANDLER, { key: admission.storageKey });
      const capability = { jobId: identity.jobId, sourceFingerprint: identity.sourceFingerprint, deadlineAt: String(identity.deadlineAt), token: prepared.token };
      const outputURL = new URL(objectUrlOn(ALPHA_PACKED_HOST, alphaPackedKeyFor(admission.storageKey)));
      outputURL.search = new URLSearchParams(capability).toString();
      const ledgerURL = new URL(objectUrlOn(SOURCE_LEDGER_HOST, videoSourceLedgerKeyFor(admission.storageKey)));
      ledgerURL.search = new URLSearchParams(capability).toString();
      const body: AlphaRunBody = { ...identity, token: prepared.token, sourceURL: mediaObjectUrl(admission.storageKey), outputURL: outputURL.toString(),
        reportURL: objectUrlOn(ALPHA_REPORT_HOST, admission.storageKey), limits: producesLedger ? admission.limits : presentationLimits, vcpu: admission.pricing.size.vcpu,
        ...(producesLedger ? { sourceLedgerOutputURL: ledgerURL.toString() } : {}), ...(admission.ledgerOnly === true ? { ledgerOnly: true } : {}) };
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
  if (value.kind !== 'probe' && value.kind !== 'encoded' && value.kind !== 'finished' && value.kind !== 'source_ledger_failed') return new Response('Invalid report', { status: 400 });
  if (value.kind === 'source_ledger_failed' && (typeof value.error !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value.error))) return new Response('Invalid ledger failure', { status: 400 });
  if (value.kind === 'finished') {
    const usage = value.usage as { wallMs?: unknown; cpuUsec?: unknown } | undefined;
    if (usage === undefined || typeof usage.wallMs !== 'number' || !Number.isFinite(usage.wallMs) || usage.wallMs < 0 || (usage.cpuUsec !== null && (typeof usage.cpuUsec !== 'number' || !Number.isFinite(usage.cpuUsec) || usage.cpuUsec < 0))) return new Response('Invalid usage', { status: 400 });
  }
  const instance = env.MEDIA.get(env.MEDIA.idFromName(ctx.params.key));
  const accepted = await instance.reportPresentation(value as unknown as AlphaPresentationReport);
  return new Response(null, { status: accepted ? 200 : 409 });
}

/**
 * Accept packed bytes only through their canonical owner's durable pre-write claim.
 * @param request - Container-local complete encoded stream.
 * @param env - Actual canonical durable owner and R2 bindings.
 * @param ctx - The exact canonical key authorized for this container.
 * @returns Physical publication acknowledgement or an explicit refusal.
 * @throws {never} Infrastructure faults are logged and returned as failed writes.
 */
export async function writeAlphaPresentation(request: Request, env: MediaEnv, ctx: OutboundHandlerContext<ServeOneKey>): Promise<Response> {
  if (request.method !== 'PUT' || askedKey(request) !== alphaPackedKeyFor(ctx.params.key)) return new Response('Not allowed', { status: 403 });
  const query = new URL(request.url).searchParams;
  const jobId = query.get('jobId');
  const sourceFingerprint = query.get('sourceFingerprint');
  const deadlineAt = Number(query.get('deadlineAt'));
  const token = query.get('token');
  const length = request.headers.get('content-length');
  const byteLength = Number(length);
  if (jobId === null || jobId.length === 0 || sourceFingerprint === null || !/^[a-f0-9]{64}$/.test(sourceFingerprint) || !Number.isSafeInteger(deadlineAt) || deadlineAt <= 0 ||
    token === null || token.length === 0 || length === null || !Number.isSafeInteger(byteLength) || byteLength <= 0 || request.body === null) return new Response('Invalid packed write', { status: 400 });
  try {
    const owner = env.MEDIA.get(env.MEDIA.idFromName(ctx.params.key));
    const result = await writeAlphaPacked({ bucket: env.BUCKET, owner, identity: { jobId, sourceFingerprint, deadlineAt, token }, body: request.body, byteLength });
    return new Response(null, { status: result.status });
  } catch (err) {
    noteFailure('ingest_video_presentation_write_failed', { err, storageKey: ctx.params.key, jobId, sourceFingerprint });
    return new Response('Packed write failed', { status: 502 });
  }
}

/**
 * A positive safe integer written as plain decimal digits.
 * @param value - One query parameter.
 * @returns The integer, or null when it is anything else.
 * @throws {never} Never.
 */
function positiveInteger(value: string | null): number | null {
  const parsed = value !== null && /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Accept the producer's one ledger write, the compact table then the full ledger, only through their durable pre-write claim.
 * @param request - Container-local PUT whose query carries the accepted identity and the declared lengths.
 * @param env - Actual canonical durable owner and R2 bindings.
 * @param ctx - The exact canonical key authorized for this container.
 * @returns 200 once both objects and the ready ledger are stored; 400 malformed; 403 another key; 409 refused claim; 502 storage failure.
 * @throws {never} Infrastructure faults are logged and returned as failed writes.
 */
export async function writeSourceLedgerPresentation(request: Request, env: MediaEnv, ctx: OutboundHandlerContext<ServeOneKey>): Promise<Response> {
  if (request.method !== 'PUT' || askedKey(request) !== videoSourceLedgerKeyFor(ctx.params.key)) return new Response('Not allowed', { status: 403 });
  const query = new URL(request.url).searchParams;
  const jobId = query.get('jobId');
  const sourceFingerprint = query.get('sourceFingerprint');
  const deadlineAt = positiveInteger(query.get('deadlineAt'));
  const token = query.get('token');
  const byteLength = positiveInteger(query.get('byteLength'));
  const tableByteLength = positiveInteger(query.get('tableByteLength'));
  const frameCount = positiveInteger(query.get('tableFrameCount'));
  const contentLength = positiveInteger(request.headers.get('content-length'));
  if (jobId === null || jobId.length === 0 || sourceFingerprint === null || !/^[a-f0-9]{64}$/.test(sourceFingerprint) || deadlineAt === null ||
    token === null || token.length === 0 || query.get('producerVersion') !== '2' || byteLength === null || tableByteLength === null || frameCount === null ||
    contentLength === null || contentLength !== byteLength + tableByteLength || request.body === null) return new Response('Invalid ledger write', { status: 400 });
  try {
    const owner = env.MEDIA.get(env.MEDIA.idFromName(ctx.params.key));
    const result = await writeVideoSourceLedger({ bucket: env.BUCKET, owner, identity: { jobId, sourceFingerprint, deadlineAt, token },
      declaration: { producerVersion: 2, byteLength, table: { byteLength: tableByteLength, frameCount } }, body: request.body });
    return new Response(null, { status: result.status });
  } catch (err) {
    noteFailure('ingest_video_source_ledger_write_failed', { err, storageKey: ctx.params.key, jobId, sourceFingerprint });
    return new Response('Ledger write failed', { status: 502 });
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
  [ALPHA_PACKED_HANDLER]: writeAlphaPresentation,
  [SOURCE_LEDGER_HANDLER]: writeSourceLedgerPresentation,
};
