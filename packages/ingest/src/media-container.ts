// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
import { videoSourceLedgerKeyFor, type VideoPresentationPrepareAnswer } from '@breatic/shared';
import { preparePresentation, VideoPresentationStore, type VideoPresentationAdmission, type PresentationCapability, type PresentationChunkReport,
  type PresentationChunkUnit, type PresentationContainerPort, type PresentationJobIdentity, type PresentationJobRef, type PresentationReport, type PresentationView,
  type SourceLedgerDeclaration, type SourceLedgerMeasurement, type SourceLedgerWriteClaim, type PresentationCarrierMeasurement } from '@ingest/video-presentation-store.js';
import { writeVideoSourceLedger } from '@ingest/video-source-ledger-write.js';
import { noteFailure } from '@ingest/error-monitoring.js';
import { MEDIA_OBJECT_HOST, mediaObjectUrl, serveOneObject } from "@ingest/media-object-route.js";
import { createPresentationContainerPort } from '@ingest/presentation-container-port.js';
import { PRESENTATION_RUN_PATH, type PresentationRunRequest } from '@ingest/presentation-run-contract.js';
import { PRESENTATION_CARRIER_HANDLER, PRESENTATION_CARRIER_HOST, SOURCE_LEDGER_HANDLER, SOURCE_LEDGER_WRITE_HOST } from '@ingest/presentation-run-types.js';
import { hashStoredObject, writeStreamedObject } from "@ingest/stored-object.js";
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

  /**
   * Read the current presentation facts without starting a container; an expired admitted job fails as expired.
   * @param storageKey - Registered canonical key.
   * @param sourceFingerprint - Its registered hash.
   * @returns The store view.
   * @throws {Error} When durable storage or R2 fails.
   */
  async readPresentation(storageKey: string, sourceFingerprint: string): Promise<PresentationView> {
    const store = this.presentationStore();
    const view = await store.read(storageKey, sourceFingerprint);
    const { state, jobId, deadlineAt } = view.candidate;
    return (state === 'accepted' || state === 'building') && jobId !== null && deadlineAt !== null && deadlineAt <= Date.now()
      ? store.fail({ storageKey, sourceFingerprint, jobId, deadlineAt }, 'expired') : view;
  }

  /**
   * Accept or replay one canonical presentation job; the one admission entry, repairs included.
   * @param admission - Trusted registry facts, frozen prices, target policy and retry caps.
   * @returns The store view.
   * @throws {Error} When durable admission fails.
   */
  acceptPresentation(admission: VideoPresentationAdmission): Promise<PresentationView> {
    return this.presentationStore().accept(admission);
  }

  /**
   * Claim both ledger objects of a toolInputId before the outbound handler can write R2.
   * @param identity - The writer's capability.
   * @param toolInputId - The instance.
   * @param declaration - The producer's declared lengths, frame count and plan.
   * @returns One physical writer or a refusal.
   * @throws {Error} When durable state or R2 cannot be read.
   */
  claimSourceLedger(identity: PresentationCapability, toolInputId: string, declaration: SourceLedgerDeclaration): Promise<SourceLedgerWriteClaim | null> {
    return this.presentationStore().claimSourceLedger(identity, toolInputId, declaration);
  }

  /**
   * Commit the measured ledger and table under their still active claim.
   * @param identity - The writer's capability.
   * @param toolInputId - The instance.
   * @param owner - Durable pre-write owner.
   * @param measured - Actual measured stored bytes of both objects.
   * @returns Whether the ready ledger committed.
   * @throws {Error} When storage fails.
   */
  commitLedger(identity: PresentationCapability, toolInputId: string, owner: string, measured: SourceLedgerMeasurement): Promise<boolean> {
    return this.presentationStore().commitLedger(identity, toolInputId, owner, measured);
  }

  /**
   * Claim the basic copy's carrier key before the outbound handler can write R2 (§91 D2-2).
   * @param identity - The writer's capability.
   * @param key - The key the write names.
   * @param declaration - The declared length and type.
   * @param attempt - The copy attempt.
   * @returns The claim owner, `forbidden` for another key, or null.
   * @throws {Error} When durable state fails.
   */
  claimPresentationCarrier(identity: PresentationCapability, key: string, declaration: { byteLength: number; contentType: string }, attempt: number): Promise<{ owner: string } | 'forbidden' | null> {
    return this.presentationStore().claimPresentationCarrier(identity, key, declaration, attempt);
  }

  /**
   * Record the Worker's measurement of a claimed carrier write.
   * @param identity - The writer's capability.
   * @param owner - The claim owner.
   * @param measured - What landed.
   * @returns Whether the claim took it.
   * @throws {Error} When durable state fails.
   */
  commitPresentationCarrier(identity: PresentationCapability, owner: string, measured: PresentationCarrierMeasurement): Promise<boolean> {
    return this.presentationStore().commitPresentationCarrier(identity, owner, measured);
  }

  /**
   * Release only the failed ledger write's own claim.
   * @param identity - The writer's capability.
   * @param toolInputId - The instance.
   * @param owner - Failed physical writer.
   * @returns Nothing after exact release.
   * @throws {Error} When storage fails.
   */
  releaseSourceLedger(identity: PresentationCapability, toolInputId: string, owner: string): Promise<void> {
    return this.presentationStore().releaseSourceLedger(identity, toolInputId, owner);
  }

  /**
   * Run one basic execution of a presentation job, or re-read a started one (design §5.1 steps 1–2).
   * @param identity - The job identity; its deadline is the DO's.
   * @returns The worker-only prepare answer.
   * @throws {Error} When storage, R2 or the container fails.
   */
  preparePresentation(identity: PresentationJobRef): Promise<VideoPresentationPrepareAnswer> {
    return preparePresentation(this.presentationStore(), identity, this.presentationPort(), Date.now());
  }

  /**
   * Move a job to the next stage of its route, or publish its carrier at `publish`.
   * @param capability - The job's capability.
   * @param stage - The stage.
   * @returns Whether it was accepted.
   * @throws {Error} When storage or R2 fails.
   */
  advancePresentationStage(capability: PresentationCapability, stage: string): Promise<boolean> { return this.presentationStore().advanceStage(capability, stage); }

  /**
   * Apply one unit attempt report.
   * @param capability - The job's capability.
   * @param unit - The unit.
   * @param report - The report.
   * @returns Whether it was accepted.
   * @throws {Error} When storage fails.
   */
  reportPresentationChunk(capability: PresentationCapability, unit: PresentationChunkUnit, report: PresentationChunkReport): Promise<boolean> {
    return this.presentationStore().reportChunk(capability, unit, report);
  }

  /**
   * Record a job's measured usage.
   * @param capability - The job's capability.
   * @param fact - The finished usage.
   * @returns The store view.
   * @throws {Error} When storage fails.
   */
  reportPresentationFact(capability: PresentationCapability, fact: Extract<PresentationReport, { kind: 'finished' }>): Promise<PresentationView> {
    return this.presentationStore().report(capability, fact);
  }

  /**
   * Fail a job's candidate; expiry is `expired`.
   * @param identity - The job identity and deadline.
   * @param code - The failure code.
   * @returns The store view.
   * @throws {Error} When storage fails.
   */
  failPresentation(identity: PresentationJobIdentity, code: string): Promise<PresentationView> { return this.presentationStore().fail(identity, code); }

  /**
   * Acknowledge one already-recorded platform usage fact.
   * @param identity - Its original source and job identity.
   * @returns The store view.
   * @throws {Error} When persistence fails.
   */
  acknowledgePresentationUsage(identity: PresentationJobIdentity): Promise<PresentationView> { return this.presentationStore().acknowledgeUsage(identity); }

  /**
   * The basic container's presentation work.
   * @returns The port.
   * @throws {never} Constructing it starts no IO.
   */
  private presentationPort(): PresentationContainerPort {
    const store = this.presentationStore();
    /**
     * One run request to this instance's container, which reads the source only through the serve handler.
     * @param storageKey - The canonical key the container may read.
     * @param body - The request.
     * @returns The answer's JSON.
     * @throws {Error} When the container is unreachable or refuses.
     */
    const send = async (storageKey: string, body: PresentationRunRequest): Promise<unknown> => {
      const authorised: ServeOneKey = { key: storageKey };
      await this.setOutboundByHost(MEDIA_OBJECT_HOST, SERVE_OBJECT, authorised);
      await this.setOutboundByHost(SOURCE_LEDGER_WRITE_HOST, SOURCE_LEDGER_HANDLER, authorised);
      await this.setOutboundByHost(PRESENTATION_CARRIER_HOST, PRESENTATION_CARRIER_HANDLER, authorised);
      const answer = await this.containerFetch(new Request(`http://media${PRESENTATION_RUN_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      if (!answer.ok) throw new Error(`The presentation container answered ${answer.status}`);
      return answer.json();
    };
    /**
     * The port of the job a capability names, over this instance's container.
     * @param capability - The granted job.
     * @returns The port.
     * @throws {Error} When the job is no longer held.
     */
    const portFor = async (capability: PresentationCapability): Promise<PresentationContainerPort> => {
      const storageKey = capability.storageKey;
      const admission = storageKey === undefined ? null : await store.admissionOf({ storageKey, sourceFingerprint: capability.sourceFingerprint, jobId: capability.jobId });
      if (storageKey === undefined || admission === null) throw new Error('The presentation job is no longer held');
      return createPresentationContainerPort((body) => send(storageKey, body), admission, mediaObjectUrl(storageKey));
    };
    return {
      probe: async (capability) => (await portFor(capability)).probe(capability),
      writeLedger: async (capability, toolInputId, encoding) => (await portFor(capability)).writeLedger(capability, toolInputId, encoding),
      carrier: async (capability, route) => (await portFor(capability)).carrier(capability, route),
      usage: async () => null,
    };
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
 * Accept the producer's one ledger write, the compact table then the full ledger, only through the named toolInputId writer's durable pre-write claim.
 * @param request - Container-local PUT whose query carries the accepted identity and the declared lengths.
 * @param env - Actual canonical durable owner and R2 bindings.
 * @param ctx - The exact canonical key authorized for this container.
 * @returns 200 once both objects and the ready ledger are stored; 400 malformed; 403 another key; 409 refused claim; 502 storage failure.
 * @throws {never} Infrastructure faults are logged and returned as failed writes.
 */
export async function writeSourceLedgerPresentation(request: Request, env: MediaEnv, ctx: OutboundHandlerContext<ServeOneKey>): Promise<Response> {
  if (request.method !== 'PUT') return new Response('Not allowed', { status: 403 });
  const query = new URL(request.url).searchParams;
  const jobId = query.get('jobId');
  const sourceFingerprint = query.get('sourceFingerprint');
  const deadlineAt = positiveInteger(query.get('deadlineAt'));
  const token = query.get('token');
  const toolInputId = query.get('toolInputId');
  const planSha256 = query.get('planSha256');
  const byteLength = positiveInteger(query.get('byteLength'));
  const tableByteLength = positiveInteger(query.get('tableByteLength'));
  const frameCount = positiveInteger(query.get('tableFrameCount'));
  const contentLength = positiveInteger(request.headers.get('content-length'));
  if (jobId === null || jobId.length === 0 || sourceFingerprint === null || !/^[a-f0-9]{64}$/.test(sourceFingerprint) || deadlineAt === null ||
    token === null || token.length === 0 || toolInputId === null || !/^[a-f0-9]{64}$/.test(toolInputId) || planSha256 === null || !/^[a-f0-9]{64}$/.test(planSha256) ||
    query.get('producerVersion') !== '2' || byteLength === null || tableByteLength === null || frameCount === null ||
    contentLength === null || contentLength !== byteLength + tableByteLength || request.body === null) return new Response('Invalid ledger write', { status: 400 });
  // Each plan's ledger is its own object: the path is the full key of the toolInputId the query names (design §5.1 step 5).
  if (askedKey(request) !== videoSourceLedgerKeyFor(ctx.params.key, toolInputId)) return new Response('Not allowed', { status: 403 });
  try {
    const owner = env.MEDIA.get(env.MEDIA.idFromName(ctx.params.key));
    const result = await writeVideoSourceLedger({ bucket: env.BUCKET, owner, identity: { storageKey: ctx.params.key, jobId, sourceFingerprint, deadlineAt, token }, toolInputId,
      declaration: { producerVersion: 2, byteLength, table: { byteLength: tableByteLength, frameCount }, planSha256 }, body: request.body });
    return new Response(null, { status: result.status });
  } catch (err) {
    noteFailure('ingest_video_source_ledger_write_failed', { err, storageKey: ctx.params.key, jobId, sourceFingerprint });
    return new Response('Ledger write failed', { status: 502 });
  }
}

/**
 * Accept the basic copy's one carrier write at the copy key the DO claims for it before any byte lands (§91 D2-2); the
 * object is written once and the Worker answers its measurement of what landed.
 * @param request - Container-local PUT whose query carries the capability, the copy attempt and the declared length.
 * @param env - Actual canonical durable owner and R2 bindings.
 * @param ctx - The exact canonical key authorized for this container.
 * @returns 200 with the measured receipt; 400 malformed; 403 another key; 409 refused claim or an existing object; 502 storage failure.
 * @throws {never} Infrastructure faults are logged and returned as failed writes.
 */
export async function writePresentationCarrier(request: Request, env: MediaEnv, ctx: OutboundHandlerContext<ServeOneKey>): Promise<Response> {
  if (request.method !== 'PUT') return new Response('Not allowed', { status: 403 });
  const query = new URL(request.url).searchParams;
  const jobId = query.get('jobId');
  const sourceFingerprint = query.get('sourceFingerprint');
  const deadlineAt = positiveInteger(query.get('deadlineAt'));
  const token = query.get('token');
  const attempt = positiveInteger(query.get('attempt'));
  const byteLength = positiveInteger(query.get('byteLength'));
  const contentType = request.headers.get('content-type');
  const contentLength = positiveInteger(request.headers.get('content-length'));
  if (jobId === null || jobId.length === 0 || sourceFingerprint === null || !/^[a-f0-9]{64}$/.test(sourceFingerprint) || deadlineAt === null || token === null ||
    token.length === 0 || attempt === null || byteLength === null || contentType === null || contentType.length === 0 || contentLength !== byteLength || request.body === null) {
    return new Response('Invalid carrier write', { status: 400 });
  }
  const key = askedKey(request);
  const identity = { storageKey: ctx.params.key, jobId, sourceFingerprint, deadlineAt, token };
  try {
    const owner = env.MEDIA.get(env.MEDIA.idFromName(ctx.params.key));
    const claim = await owner.claimPresentationCarrier(identity, key, { byteLength, contentType }, attempt);
    if (claim === null || claim === 'forbidden') {
      await request.body.cancel();
      return new Response(claim === null ? 'Refused' : 'Not allowed', { status: claim === null ? 409 : 403 });
    }
    const fixed = new FixedLengthStream(byteLength);
    const [written] = await Promise.all([
      env.BUCKET.put(key, fixed.readable, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType } }),
      request.body.pipeTo(fixed.writable),
    ]);
    if (written === null) return new Response('Refused', { status: 409 });
    const measured = { storageKey: key, sha256: await hashStoredObject(env.BUCKET, key), sizeBytes: written.size, contentType };
    if (!await owner.commitPresentationCarrier(identity, claim.owner, { ...measured, etag: written.etag })) return new Response('Refused', { status: 409 });
    return Response.json(measured);
  } catch (err) {
    noteFailure('ingest_presentation_carrier_write_failed', { err, storageKey: ctx.params.key, jobId, sourceFingerprint });
    return new Response('Carrier write failed', { status: 502 });
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
  [SOURCE_LEDGER_HANDLER]: writeSourceLedgerPresentation,
  [PRESENTATION_CARRIER_HANDLER]: writePresentationCarrier,
};
