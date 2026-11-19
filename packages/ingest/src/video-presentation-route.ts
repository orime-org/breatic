// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { videoPresentationIngestRequestSchema } from '@breatic/shared';
import { fromOurBackend } from '@ingest/backend-secret.js';
import { noteFailure } from '@ingest/error-monitoring.js';
import type { MediaEnv } from '@ingest/media-read.js';
import { presentationSnapshot, type PresentationView, type VideoPresentationAdmission } from '@ingest/video-presentation-store.js';

/** Backend-only metadata entry uses the existing canonical-key container binding. */
export interface VideoPresentationEnv extends MediaEnv { INGEST_SHARED_SECRET: string }

/**
 * Read, admit and advance staged presentation work for a server-resolved canonical source: one DO RPC per action.
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
  const { storageKey, sourceFingerprint } = body;
  const answer = (view: Partial<PresentationView>): Response => Response.json(presentationSnapshot(view, storageKey, sourceFingerprint));
  try {
    const instance = env.MEDIA.get(env.MEDIA.idFromName(storageKey));
    switch (body.action) {
      case 'read': return answer(await instance.readPresentation(storageKey, sourceFingerprint));
      case 'accept': {
        const source = await env.BUCKET.head(storageKey);
        if (source === null) return new Response('Source missing', { status: 404 });
        const { action: _action, ...fields } = body;
        const admission: VideoPresentationAdmission = fields;
        return answer(await instance.acceptPresentation(admission));
      }
      case 'prepare': return Response.json(await instance.preparePresentation({ storageKey, sourceFingerprint, jobId: body.jobId }));
      case 'advance_stage': {
        const { action: _action, stage, ...capability } = body;
        return Response.json({ accepted: await instance.advancePresentationStage(capability, stage) });
      }
      case 'report_chunk': {
        const { action: _action, unit, report, ...capability } = body;
        return Response.json({ accepted: await instance.reportPresentationChunk(capability, unit, report) });
      }
      case 'report': {
        const { action: _action, fact, ...capability } = body;
        return answer(await instance.reportPresentationFact(capability, fact));
      }
      case 'fail': {
        const { action: _action, code, ...identity } = body;
        return answer(await instance.failPresentation(identity, code));
      }
      case 'ack_usage': {
        const { action: _action, ...identity } = body;
        return answer(await instance.acknowledgePresentationUsage(identity));
      }
    }
  } catch (err) {
    noteFailure('ingest_video_presentation_boundary_failed', { err, action: body.action, storageKey, jobId: 'jobId' in body ? body.jobId : undefined });
    return new Response('Presentation unavailable', { status: 502 });
  }
}
