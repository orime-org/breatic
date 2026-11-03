// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The presentation DO's basic-container port over the run contract (inner#1306 test plan §91 D-3; design §5.1 step 2):
 * a probe request built only from the job's frozen admission, and its answer mapped onto the store's probe. A
 * malformed answer is a container fault, never a plan. The transport is injected.
 */

import type { PresentationCapability, PresentationContainerPort, PresentationProbe, VideoPresentationAdmission } from '@ingest/video-presentation-store.js';
import { presentationProbeAnswerSchema, type PresentationRunRequest } from '@ingest/presentation-run-contract.js';

/** Send one run request to the container and hand back its parsed JSON answer. */
export type PresentationRunSend = (body: PresentationRunRequest) => Promise<unknown>;

/**
 * The port for one admitted job.
 * @param send - The container transport.
 * @param admission - The job's frozen admission.
 * @param sourceURL - Where the container reads the source.
 * @returns The port; the ledger and carrier actions arrive with S6d D2.
 * @throws {never} Constructing it starts no IO.
 */
export function createPresentationContainerPort(send: PresentationRunSend, admission: VideoPresentationAdmission, sourceURL: string): PresentationContainerPort {
  const pending = (): never => { throw new Error('The presentation ledger and carrier actions arrive with S6d D2'); };
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
      if (limits?.sourceLedger === undefined || encoding === undefined || probe === undefined) throw new Error('The admission lacks the frozen probe facts');
      const answer = presentationProbeAnswerSchema.parse(await send({ action: 'probe', jobId: admission.jobId, sourceFingerprint: admission.sourceFingerprint,
        deadlineAt: admission.deadlineAt, sourceURL, limits: { ...limits, sourceLedger: limits.sourceLedger }, encoding, probe }));
      if (answer.kind === 'failed') return answer;
      const { plan, ...facts } = answer;
      return { kind: 'planned', toolInputId: facts.toolInputId, planSha256: facts.planSha256, routeInput: facts.routeInput, encoding: facts.encoding, work: facts.work,
        display: plan.display, playbackClock: plan.presentation };
    },
    writeLedger: async () => pending(),
    carrier: async () => pending(),
    usage: async () => null,
  };
}
