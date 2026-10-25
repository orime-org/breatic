// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { alphaManifestKeyFor, alphaManifestMatchesPresentation, alphaManifestSchema, alphaPackedKeyFor, parseVideoPresentation, videoPresentationKeyFor,
  type AlphaManifest, type VideoPresentation, type VideoPresentationIngestSnapshot, type VideoPresentationPricing, type VideoPresentationProcessLimits } from '@breatic/shared';
import { advanceVideoPresentation, type AcceptedVideoPresentationAttempt } from '@ingest/video-presentation-state.js';

/** Backend-authorized admission of one canonical source's auxiliary work. */
export interface VideoPresentationAdmission extends AcceptedVideoPresentationAttempt {
  storageKey: string;
  contentType: string;
  original: VideoPresentation['original'] | null;
  knownAlpha?: boolean;
  repair?: boolean;
  limits?: VideoPresentationProcessLimits;
  pricing?: VideoPresentationPricing;
  actorUserId?: string;
  projectId?: string | null;
  packedURL?: string;
  manifestURL?: string;
}

/** Private durable state remains valid even while original metadata is unknown. */
interface PresentationRecord { admission: VideoPresentationAdmission; snapshot: VideoPresentationIngestSnapshot; descriptorETag: string | null }
const RECORD_KEY = 'video-presentation-v1';

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
    return this.gate(async () => {
      const current = await this.storage.get<PresentationRecord>(RECORD_KEY);
      if (current?.admission.sourceFingerprint === input.sourceFingerprint) {
        const status = current.snapshot.attempt?.status;
        if (status === 'accepted' || status === 'running' || input.repair !== true) return current.snapshot;
        if (current.snapshot.presentation?.state === 'alpha_ready' && await this.manifest(current.admission, current.snapshot.presentation) !== null) return current.snapshot;
      }
      const original = input.original;
      const presentation: VideoPresentation | null = original === null ? null : {
        schemaVersion: 1, sourceFingerprint: input.sourceFingerprint, original,
        state: input.knownAlpha === true ? 'alpha_pending' : 'classifying', attempt: { jobId: input.jobId, deadlineAt: input.deadlineAt },
      };
      const snapshot: VideoPresentationIngestSnapshot = { presentation, attempt: {
        jobId: input.jobId, deadlineAt: input.deadlineAt, status: 'accepted', usage: null,
      } };
      const head = await this.bucket.head(videoPresentationKeyFor(input.storageKey));
      const record: PresentationRecord = { admission: input, snapshot, descriptorETag: head?.etag ?? null };
      await this.storage.put(RECORD_KEY, record);
      if (presentation !== null) await this.writeDescriptor(record, presentation);
      return snapshot;
    });
  }

  /**
   * Publish only facts owned by the still-current accepted attempt.
   * @param identity - The source and originally accepted work identity.
   * @param proposed - Trusted current-attempt classification or completion.
   * @returns The current durable facts, including rejection of stale writes.
   * @throws {Error} When storage cannot commit the facts.
   */
  async advance(identity: AcceptedVideoPresentationAttempt, proposed: VideoPresentation): Promise<VideoPresentationIngestSnapshot> {
    return this.gate(async () => {
      const current = await this.storage.get<PresentationRecord>(RECORD_KEY);
      if (current === undefined) return { presentation: null, attempt: null };
      const accepted = current.admission;
      if (identity.sourceFingerprint !== accepted.sourceFingerprint || identity.jobId !== accepted.jobId || identity.deadlineAt !== accepted.deadlineAt) return current.snapshot;
      const next = advanceVideoPresentation(current.snapshot.presentation, accepted, proposed);
      if (next === null || next === current.snapshot.presentation) return current.snapshot;
      if (accepted.original !== null && (accepted.original.width !== next.original.width || accepted.original.height !== next.original.height || accepted.original.duration !== next.original.duration)) return current.snapshot;
      const manifest = next.state === 'alpha_ready' ? await this.manifest(accepted, next) : null;
      if (next.state === 'alpha_ready' && manifest === null) return current.snapshot;
      const status = next.state === 'failed' ? 'failed' : next.state === 'native' || next.state === 'alpha_ready' ? 'completed' : 'running';
      const snapshot: VideoPresentationIngestSnapshot = { presentation: next,
        ...(manifest === null ? {} : { manifest }), attempt: { jobId: accepted.jobId, deadlineAt: accepted.deadlineAt,
          status, usage: current.snapshot.attempt?.usage ?? null, ...(next.state === 'failed' ? { error: next.error } : {}) },
      };
      if (!await this.writeDescriptor(current, next)) return current.snapshot;
      current.snapshot = snapshot;
      current.admission.original = next.original;
      if (next.state === 'alpha_pending') current.admission.knownAlpha = true;
      await this.storage.put(RECORD_KEY, current);
      return snapshot;
    });
  }

  /**
   * Read current source facts and independently verify ready companion objects.
   * @param storageKey - Registered canonical key.
   * @param sourceFingerprint - Registered SHA256.
   * @returns Current source facts, retaining unknown for absent descriptors.
   * @throws {Error} When durable storage or R2 cannot be read.
   */
  async read(storageKey: string, sourceFingerprint: string): Promise<VideoPresentationIngestSnapshot> {
    return this.gate(async () => {
      const record = await this.storage.get<PresentationRecord>(RECORD_KEY);
      if (record?.admission.sourceFingerprint === sourceFingerprint) {
        if (record.snapshot.presentation?.state === 'alpha_ready' && await this.manifest(record.admission, record.snapshot.presentation) === null) {
          const failed: VideoPresentation = { ...record.snapshot.presentation, state: 'failed', error: 'presentation_missing' };
          await this.writeDescriptor(record, failed);
          record.snapshot = { presentation: failed, attempt: record.snapshot.attempt === null ? null : {
            ...record.snapshot.attempt, status: 'failed', error: 'presentation_missing',
          } };
          await this.storage.put(RECORD_KEY, record);
        }
        return record.snapshot;
      }
      const object = await this.bucket.get(videoPresentationKeyFor(storageKey));
      const value: unknown = object === null ? null : await object.json().catch(() => null);
      const presentation = parseVideoPresentation(value, sourceFingerprint);
      if (presentation?.state === 'alpha_ready') {
        const admission: VideoPresentationAdmission = { storageKey, sourceFingerprint, contentType: 'video/unknown',
          jobId: presentation.attempt?.jobId ?? 'legacy', deadlineAt: presentation.attempt?.deadlineAt ?? 1, original: presentation.original };
        const manifest = await this.manifest(admission, presentation);
        return manifest === null ? { presentation: null, attempt: null } : { presentation, manifest, attempt: null };
      }
      return { presentation, attempt: null };
    });
  }

  /**
   * Atomically publish a descriptor under its previously observed R2 ETag.
   * @param record - Current durable source and attempt owner.
   * @param presentation - The validated current descriptor.
   * @returns Whether this conditional write committed.
   * @throws {Error} When R2 transport fails.
   */
  private async writeDescriptor(record: PresentationRecord, presentation: VideoPresentation): Promise<boolean> {
    const written = await this.bucket.put(videoPresentationKeyFor(record.admission.storageKey), JSON.stringify(presentation), {
      onlyIf: record.descriptorETag === null ? { etagDoesNotMatch: '*' } : { etagMatches: record.descriptorETag },
      httpMetadata: { contentType: 'application/json' },
    });
    if (written === null) return false;
    record.descriptorETag = written.etag;
    await this.storage.put(RECORD_KEY, record);
    return true;
  }

  /**
   * Verify both physical companions and the owned canonical geometry.
   * @param admission - Canonical source and any expected public URLs.
   * @param presentation - Descriptor claiming readiness.
   * @returns Its validated manifest, or none when physical facts disagree.
   * @throws {Error} When R2 cannot be read.
   */
  private async manifest(admission: VideoPresentationAdmission, presentation: VideoPresentation): Promise<AlphaManifest | null> {
    const object = await this.bucket.get(alphaManifestKeyFor(admission.storageKey));
    const packed = await this.bucket.head(alphaPackedKeyFor(admission.storageKey));
    if (object === null || packed === null || packed.size === 0 || packed.httpMetadata?.contentType !== 'video/mp4') return null;
    const parsed = alphaManifestSchema.safeParse(await object.json().catch(() => null));
    if (!parsed.success || !alphaManifestMatchesPresentation(parsed.data, presentation)) return null;
    if (admission.packedURL !== undefined && parsed.data.packedURL !== admission.packedURL) return null;
    if (admission.manifestURL !== undefined && presentation.alpha?.manifestURL !== admission.manifestURL) return null;
    return parsed.data;
  }
}
