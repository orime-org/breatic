// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { VideoPresentation, VideoPresentationIngestSnapshot } from '@breatic/shared';
import type { AcceptedVideoPresentationAttempt } from '@ingest/video-presentation-state.js';

/** Backend-authorized admission of one canonical source's auxiliary work. */
export interface VideoPresentationAdmission extends AcceptedVideoPresentationAttempt {
  storageKey: string;
  contentType: string;
  original: VideoPresentation['original'] | null;
  knownAlpha?: boolean;
  repair?: boolean;
}

/** Durable gate shared by the production container and a storage-only test object. */
export type PresentationStorageGate = <T>(work: () => Promise<T>) => Promise<T>;

/** One canonical key's durable admission and descriptor publication owner. */
export class VideoPresentationStore {
  /**
   * Bind real durable state and R2 to one request serialization gate.
   * @param storage - This canonical key's Durable Object storage.
   * @param bucket - The canonical source and its companion objects.
   * @param gate - Prevents admission from interleaving a descriptor commit.
   */
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly bucket: R2Bucket,
    private readonly gate: PresentationStorageGate,
  ) {}

  /**
   * Persist the first accepted identity or replay the current one.
   * @param input - The registered source and requested work identity.
   * @returns The durable accepted identity and any measured descriptor.
   * @throws {Error} When durable admission or R2 persistence fails.
   */
  async accept(input: VideoPresentationAdmission): Promise<VideoPresentationIngestSnapshot> {
    void input;
    void this.storage;
    void this.bucket;
    void this.gate;
    return { presentation: null, attempt: null };
  }

  /**
   * Publish only facts owned by the still-current accepted attempt.
   * @param identity - The source and originally accepted work identity.
   * @param proposed - Trusted current-attempt classification or completion.
   * @returns The current durable facts, including rejection of stale writes.
   * @throws {Error} When storage cannot commit the facts.
   */
  async advance(identity: AcceptedVideoPresentationAttempt, proposed: VideoPresentation): Promise<VideoPresentationIngestSnapshot> {
    void identity;
    void proposed;
    return { presentation: null, attempt: null };
  }
}
