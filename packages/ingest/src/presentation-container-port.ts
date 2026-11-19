// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The presentation DO's basic-container port over the run contract (inner#1306 test plan §91 D-3; design §5.1 step 2):
 * a probe request built only from the job's frozen admission, and its answer mapped onto the store's probe. A
 * malformed answer is a container fault, never a plan. The transport is injected.
 */

import type { VideoPresentationLedger } from '@breatic/shared';
import type { PresentationCapability, PresentationCarrierOutcome, PresentationContainerPort, PresentationProbe, VideoPresentationAdmission } from '@ingest/video-presentation-store.js';
import { presentationCarrierAnswerSchema, presentationLedgerAnswerSchema, presentationProbeAnswerSchema, type PresentationRunRequest } from '@ingest/presentation-run-contract.js';

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
  /**
   * The frozen facts every action restarts from, checked against the capability.
   * @param capability - The granted job.
   * @returns The common request fields.
   * @throws {Error} When the admission lacks frozen facts or the capability is another job's.
   */
  const frozen = (capability: PresentationCapability): Omit<Extract<PresentationRunRequest, { action: 'probe' }>, 'action'> => {
    const { limits, encoding, probe } = admission;
    if (capability.jobId !== admission.jobId || capability.sourceFingerprint !== admission.sourceFingerprint) throw new Error('The capability belongs to another job');
    if (limits?.sourceLedger === undefined || encoding === undefined || probe === undefined) throw new Error('The admission lacks the frozen probe facts');
    return { jobId: admission.jobId, sourceFingerprint: admission.sourceFingerprint, deadlineAt: admission.deadlineAt, sourceURL,
      limits: { ...limits, sourceLedger: limits.sourceLedger }, encoding, probe };
  };
  /**
   * The fields a writing action adds.
   * @param capability - The granted job.
   * @returns The token and the canonical key.
   * @throws {never} Never.
   */
  const writer = (capability: PresentationCapability): { token: string; storageKey: string } => ({ token: capability.token, storageKey: admission.storageKey });
  return {
    /**
     * Probe the source in the container.
     * @param capability - The granted job.
     * @returns The plan and its facts, or the failure code.
     * @throws {Error} When the admission lacks frozen facts, the capability is another job's or the answer is malformed.
     */
    async probe(capability: PresentationCapability): Promise<PresentationProbe> {
      const answer = presentationProbeAnswerSchema.parse(await send({ action: 'probe', ...frozen(capability) }));
      if (answer.kind === 'failed') return answer;
      const { plan, ...facts } = answer;
      return { kind: 'planned', toolInputId: facts.toolInputId, planSha256: facts.planSha256, routeInput: facts.routeInput, encoding: facts.encoding, work: facts.work,
        display: plan.display, playbackClock: plan.presentation };
    },
    /**
     * Write full and compact for the toolInputId in the container.
     * @param capability - The granted job.
     * @param toolInputId - The instance.
     * @param encodeFacts - The probe's encode facts, or null for a ledger-only repair.
     * @returns Nothing once written.
     * @throws {Error} With the container's `code` when the write failed; without one when the answer is malformed.
     */
    async writeLedger(capability: PresentationCapability, toolInputId: string, encodeFacts: VideoPresentationLedger['encoding'] | null): Promise<void> {
      const answer = presentationLedgerAnswerSchema.parse(await send({ action: 'ledger', ...frozen(capability), ...writer(capability), toolInputId, encodeFacts }));
      if (answer.kind === 'failed') throw Object.assign(new Error(`The ledger write failed: ${answer.code}`), { code: answer.code });
    },
    /**
     * Produce the identity or basic copy carrier in the container.
     * @param capability - The granted job.
     * @param route - The route.
     * @returns The written receipts for the store to measure, or the failure.
     * @throws {Error} When the answer is malformed.
     */
    async carrier(capability: PresentationCapability, route: 'identity' | 'copy'): Promise<PresentationCarrierOutcome> {
      const answer = presentationCarrierAnswerSchema.parse(await send({ action: 'carrier', ...frozen(capability), ...writer(capability), route, contentType: admission.contentType }));
      return answer.kind === 'failed' ? answer : { kind: 'written', receipts: answer.receipts };
    },
    usage: async () => null,
  };
}
