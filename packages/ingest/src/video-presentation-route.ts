// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { videoPresentationIngestRequestSchema } from '@breatic/shared';
import { fromOurBackend } from '@ingest/backend-secret.js';
import { noteFailure } from '@ingest/error-monitoring.js';
import type { MediaEnv } from '@ingest/media-read.js';
import type { VideoPresentationAdmission } from '@ingest/video-presentation-store.js';

/** Backend-only metadata entry uses the existing canonical-key container binding. */
export interface VideoPresentationEnv extends MediaEnv { INGEST_SHARED_SECRET: string }

/**
 * Read, admit or execute presentation metadata for a server-resolved canonical source.
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
    if (body.action === 'read') return Response.json(await instance.readPresentation(body.storageKey, body.sourceFingerprint));
    if (body.action === 'accept') {
      const source = await env.BUCKET.head(body.storageKey);
      if (source === null) return new Response('Source missing', { status: 404 });
      const admission: VideoPresentationAdmission = { storageKey: body.storageKey, sourceFingerprint: body.sourceFingerprint,
        jobId: body.jobId!, deadlineAt: body.deadlineAt!, original: body.original!, contentType: body.contentType!,
        registeredMetadata: body.registeredMetadata,
        limits: body.limits!, pricing: body.pricing!, actorUserId: body.actorUserId!, projectId: body.projectId!,
        packedURL: body.packedURL!, manifestURL: body.manifestURL!, knownAlpha: body.knownAlpha, repair: body.repair,
        ...(body.sourceLedgerURL === undefined ? {} : { sourceLedgerURL: body.sourceLedgerURL }) };
      return Response.json(await instance.acceptPresentation(admission));
    }
    const identity = { sourceFingerprint: body.sourceFingerprint, jobId: body.jobId!, deadlineAt: body.deadlineAt! };
    if (body.action === 'ack_usage') return Response.json(await instance.acknowledgePresentationUsage(identity));
    if (body.action === 'expire') return Response.json(await instance.expirePresentation(identity));
    return Response.json(await instance.runPresentation(identity));
  } catch (err) {
    noteFailure('ingest_video_presentation_boundary_failed', { err, action: body.action, storageKey: body.storageKey, jobId: body.jobId });
    return new Response('Presentation unavailable', { status: 502 });
  }
}
