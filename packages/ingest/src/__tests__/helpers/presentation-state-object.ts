// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { DurableObject } from 'cloudflare:workers';
import type { VideoPresentation, VideoPresentationIngestSnapshot } from '@breatic/shared';
import { VideoPresentationStore, type VideoPresentationAdmission, type PreparedAlphaAdmission, type AlphaPackedIdentity, type AlphaPackedWriteClaim, type AlphaPackedReceipt } from '@ingest/video-presentation-store.js';
import type { AlphaPresentationReport } from '@ingest/alpha-run-contract.js';
import type { AcceptedVideoPresentationAttempt } from '@ingest/video-presentation-state.js';

/** Real workerd storage fixture; it deliberately does not pretend to be a container. */
export class PresentationStateTestObject extends DurableObject<{ BUCKET: R2Bucket }> {
  /**
   * Expose the production accepted capability using actual durable state.
   * @param identity - Original source and deadline.
   * @returns The production active capability.
   * @throws {Error} When durable preparation fails.
   */
  prepare(identity: AcceptedVideoPresentationAttempt): Promise<PreparedAlphaAdmission> {
    return new VideoPresentationStore(this.ctx.storage, this.env.BUCKET, work => this.ctx.blockConcurrencyWhile(work)).prepare(identity);
  }

  /**
   * Read one original expense fact without presenting it as the current attempt.
   * @param identity - Accepted original source and deadline.
   * @returns Its durable receipt including archived measured usage.
   * @throws {Error} When storage fails.
   */
  snapshotFor(identity: AcceptedVideoPresentationAttempt): Promise<VideoPresentationIngestSnapshot> {
    return new VideoPresentationStore(this.ctx.storage, this.env.BUCKET, work => this.ctx.blockConcurrencyWhile(work)).snapshotFor(identity);
  }

  /**
   * Apply trusted container facts through the production owner.
   * @param fact - Capability-bound probe or measured usage.
   * @returns Whether it was accepted.
   * @throws {Error} When persistence fails.
   */
  report(fact: AlphaPresentationReport): Promise<boolean> {
    return new VideoPresentationStore(this.ctx.storage, this.env.BUCKET, work => this.ctx.blockConcurrencyWhile(work)).report(fact);
  }

  /**
   * Delegate the exact physical write claim to production storage.
   * @param identity - Accepted private capability.
   * @param byteLength - Actual complete length.
   * @returns Production pre-write authorization.
   * @throws {Error} When storage fails.
   */
  claimPacked(identity: AlphaPackedIdentity, byteLength: number): Promise<AlphaPackedWriteClaim | null> {
    return new VideoPresentationStore(this.ctx.storage, this.env.BUCKET, work => this.ctx.blockConcurrencyWhile(work)).claimPacked(identity, byteLength);
  }

  /**
   * Delegate physical receipt publication to production storage.
   * @param identity - Accepted private capability.
   * @param owner - Actual pre-write owner.
   * @param receipt - Actual R2 bytes.
   * @returns Whether readiness committed.
   * @throws {Error} When storage fails.
   */
  completePacked(identity: AlphaPackedIdentity, owner: string, receipt: AlphaPackedReceipt): Promise<boolean> {
    return new VideoPresentationStore(this.ctx.storage, this.env.BUCKET, work => this.ctx.blockConcurrencyWhile(work)).completePacked(identity, owner, receipt);
  }

  /**
   * Release a physical writer through production storage.
   * @param identity - Accepted private capability.
   * @param owner - Physical write owner.
   * @returns Nothing after release.
   * @throws {Error} When storage fails.
   */
  releasePacked(identity: AlphaPackedIdentity, owner: string): Promise<void> {
    return new VideoPresentationStore(this.ctx.storage, this.env.BUCKET, work => this.ctx.blockConcurrencyWhile(work)).releasePacked(identity, owner);
  }
  /**
   * Read actual storage facts through the production persistence helper.
   * @param storageKey - Canonical key.
   * @param sourceFingerprint - Registered content hash.
   * @returns Current verified source presentation.
   * @throws {Error} When the production persistence helper rejects.
   */
  read(storageKey: string, sourceFingerprint: string): Promise<VideoPresentationIngestSnapshot> {
    return new VideoPresentationStore(this.ctx.storage, this.env.BUCKET, (work) => this.ctx.blockConcurrencyWhile(work)).read(storageKey, sourceFingerprint);
  }

  /**
   * Delegate admission to the same persistence owner used in production.
   * @param input - Canonical source and proposed attempt.
   * @returns Actual durable storage and R2 facts.
   * @throws {Error} When the production persistence helper rejects.
   */
  accept(input: VideoPresentationAdmission): Promise<VideoPresentationIngestSnapshot> {
    return new VideoPresentationStore(this.ctx.storage, this.env.BUCKET, (work) => this.ctx.blockConcurrencyWhile(work)).accept(input);
  }

  /**
   * Delegate advancement to the production persistence helper.
   * @param identity - Accepted source and attempt identity.
   * @param proposed - The descriptor being published.
   * @returns Actual current durable facts.
   * @throws {Error} When the production persistence helper rejects.
   */
  advance(identity: AcceptedVideoPresentationAttempt, proposed: VideoPresentation): Promise<VideoPresentationIngestSnapshot> {
    return new VideoPresentationStore(this.ctx.storage, this.env.BUCKET, (work) => this.ctx.blockConcurrencyWhile(work)).advance(identity, proposed);
  }
}
