// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The presentation DO's basic-container port over the probe contract (frames-split design §5.1 step 2): a probe request built
 * only from the job's frozen admission, and its answer mapped onto the store's probe. A malformed answer, or one whose plan
 * digest is not its plan's, is a container fault, never a plan. The transport is injected.
 */

import { videoPresentationPlanSha256 } from '@shared/upload/video-presentation-version.js';
import type { PresentationCapability, PresentationContainerPort, PresentationProbe, VideoPresentationAdmission } from '@ingest/video-presentation-store.js';
import { presentationProbeAnswerSchema, type PresentationRunRequest } from '@ingest/presentation-run-contract.js';

/** Send one run request to the container and hand back its parsed JSON answer. */
export type PresentationRunSend = (body: PresentationRunRequest) => Promise<unknown>;

/**
 * The port for one admitted job.
 * @param send - The container transport.
 * @param admission - The job's frozen admission.
 * @param sourceURL - Where the container reads the source.
 * @returns The port.
 * @throws {never} Constructing it starts no IO.
 */
export function createPresentationContainerPort(send: PresentationRunSend, admission: VideoPresentationAdmission, sourceURL: string): PresentationContainerPort {
  return {
    /**
     * Probe the source in the container.
     * @param capability - The granted job.
     * @returns The plan and its facts, or the failure code.
     * @throws {Error} When the admission lacks frozen facts, the capability is another job's or the answer is malformed.
     */
    async probe(capability: PresentationCapability): Promise<PresentationProbe> {
      const { limits, encoding, probe } = admission;
      if (capability.jobId !== admission.jobId || capability.sourceFingerprint !== admission.sourceFingerprint) throw new Error('The capability belongs to another job');
      if (limits === undefined || encoding === undefined || probe === undefined) throw new Error('The admission lacks the frozen probe facts');
      const answer = presentationProbeAnswerSchema.parse(await send({ action: 'probe', jobId: admission.jobId, sourceFingerprint: admission.sourceFingerprint,
        deadlineAt: admission.deadlineAt, sourceURL, limits, encoding, probe }));
      if (answer.kind === 'failed') return answer;
      if (await videoPresentationPlanSha256(answer.plan) !== answer.planSha256) throw new Error('The probe answered a digest of another plan');
      return answer;
    },
    usage: async () => null,
  };
}
