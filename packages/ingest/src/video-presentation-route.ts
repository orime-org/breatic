// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { videoPresentationIngestRequestSchema, type VideoPresentationIngestLedger, type VideoPresentationIngestSnapshot } from '@breatic/shared';
import { fromOurBackend } from '@ingest/backend-secret.js';
import { noteFailure } from '@ingest/error-monitoring.js';
import type { MediaEnv } from '@ingest/media-read.js';
import type { PresentationView, VideoPresentationAdmission } from '@ingest/video-presentation-store.js';
import type { PresentationLedgerInstance } from '@ingest/video-presentation-state.js';
import type { VideoCarrierStage } from '@shared/mini-tools/video-encode-plan.js';

/** Backend-only metadata entry uses the existing canonical-key container binding. */
export interface VideoPresentationEnv extends MediaEnv { INGEST_SHARED_SECRET: string }

/**
 * One instance in the §10.1 wire states: absent is null, both failure kinds are `failed` with their code.
 * @param instance - The store instance, if any.
 * @returns The wire ledger.
 * @throws {never} Never.
 */
function wireLedger(instance: PresentationLedgerInstance<NonNullable<VideoPresentationIngestLedger['receipt']>> | undefined): VideoPresentationIngestLedger | null {
  if (instance === undefined || instance.kind === 'absent') return null;
  switch (instance.kind) {
    case 'pending': return { state: 'pending', receipt: null, failure: null };
    case 'ready': return { state: 'ready', receipt: instance.receipt, failure: null };
    default: return { state: 'failed', receipt: null, failure: instance.code };
  }
}

/**
 * Project the store view to the ingest snapshot (§3.5 response row, §5.1 step 6): the selected bundle, the target
 * policy's preparation and the L state of the selected toolInputId alone, never the full arrays or every instance.
 * @param view - The store view; a stand-in answering another shape projects to nothing selected.
 * @param storageKey - The registered key.
 * @param sourceFingerprint - The source fingerprint.
 * @returns The snapshot.
 * @throws {never} Never.
 */
export function presentationSnapshot(view: Partial<PresentationView>, storageKey: string, sourceFingerprint: string): VideoPresentationIngestSnapshot {
  const presentation = view.presentation ?? null;
  const candidate = view.candidate;
  return {
    sourceBinding: { storageKey, sourceFingerprint },
    presentation,
    preparation: candidate?.jobId == null || view.targetPolicyVersion == null ? null : {
      targetPolicyVersion: view.targetPolicyVersion, jobId: candidate.jobId, stage: candidate.stage as VideoCarrierStage | null, failure: candidate.failure,
    },
    ledger: presentation === null ? null : wireLedger(view.ledgers?.[presentation.toolInputId]),
    ...(view.usageFact === undefined ? {} : { usageFact: view.usageFact }),
  };
}

/**
 * Read, admit, expire or acknowledge presentation work for a server-resolved canonical source.
 * @param request - Backend request carrying the shared secret.
 * @param env - Existing storage and metadata-container bindings.
 * @returns Owned presentation and durable auxiliary-work facts.
 * @throws {never} Infrastructure faults are reported and returned as a failed boundary.
 */
export async function videoPresentationRoute(request: Request, env: VideoPresentationEnv): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response('Unauthorized', { status: 401 });
  const parsed = videoPresentationIngestRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response('Invalid presentation request', { status: 400 });
  const body = parsed.data;
  try {
    const instance = env.MEDIA.get(env.MEDIA.idFromName(body.storageKey));
    const answer = (view: Partial<PresentationView>): Response => Response.json(presentationSnapshot(view, body.storageKey, body.sourceFingerprint));
    if (body.action === 'read') return answer(await instance.readPresentation(body.storageKey, body.sourceFingerprint));
    if (body.action === 'accept') {
      const source = await env.BUCKET.head(body.storageKey);
      if (source === null) return new Response('Source missing', { status: 404 });
      const admission: VideoPresentationAdmission = { storageKey: body.storageKey, sourceFingerprint: body.sourceFingerprint,
        jobId: body.jobId!, deadlineAt: body.deadlineAt!, original: body.original!, contentType: body.contentType!,
        registeredMetadata: body.registeredMetadata,
        limits: body.limits!, pricing: body.pricing!, targetPolicyVersion: body.targetPolicyVersion!, policy: body.policy!,
        actorUserId: body.actorUserId!, projectId: body.projectId!,
        packedURL: body.packedURL!, manifestURL: body.manifestURL!, knownAlpha: body.knownAlpha, repair: body.repair,
        ...(body.sourceLedgerURL === undefined ? {} : { sourceLedgerURL: body.sourceLedgerURL }),
        ...(body.sourceLedgerTableURL === undefined ? {} : { sourceLedgerTableURL: body.sourceLedgerTableURL }) };
      return answer(await instance.acceptPresentation(admission));
    }
    const identity = { storageKey: body.storageKey, sourceFingerprint: body.sourceFingerprint, jobId: body.jobId!, deadlineAt: body.deadlineAt! };
    if (body.action === 'ack_usage') return answer(await instance.acknowledgePresentationUsage(identity));
    if (body.action === 'expire') return answer(await instance.expirePresentation(identity));
    // ponytail: the staged container dispatch (plan, copy, encode, stitch) is wired with the worker contract; until then a run starts nothing.
    return new Response('Presentation runs are dispatched as staged jobs', { status: 501 });
  } catch (err) {
    noteFailure('ingest_video_presentation_boundary_failed', { err, action: body.action, storageKey: body.storageKey, jobId: body.jobId });
    return new Response('Presentation unavailable', { status: 502 });
  }
}
