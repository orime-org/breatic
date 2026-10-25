// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { DurableObject } from 'cloudflare:workers';
import type { VideoPresentation, VideoPresentationIngestSnapshot } from '@breatic/shared';
import { VideoPresentationStore, type VideoPresentationAdmission } from '@ingest/video-presentation-store.js';
import type { AcceptedVideoPresentationAttempt } from '@ingest/video-presentation-state.js';

/** Real workerd storage fixture; it deliberately does not pretend to be a container. */
export class PresentationStateTestObject extends DurableObject<{ BUCKET: R2Bucket }> {
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
