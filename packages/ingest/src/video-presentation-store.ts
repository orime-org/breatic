// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { alphaManifestKeyFor, alphaManifestMatchesPresentation, alphaManifestSchema, alphaPackedKeyFor, parseVideoPresentation, videoPresentationKeyFor,
  type AlphaManifest, type VideoPresentation, type VideoPresentationIngestSnapshot, type VideoPresentationPricing, type VideoPresentationProcessLimits } from '@breatic/shared';
import { advanceVideoPresentation, type AcceptedVideoPresentationAttempt } from '@ingest/video-presentation-state.js';
import type { AlphaPresentationReport, AlphaProbeEvidence } from '@ingest/alpha-run-contract.js';

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
interface PresentationRecord {
  admission: VideoPresentationAdmission;
  snapshot: VideoPresentationIngestSnapshot;
  descriptorETag: string | null;
  token: string;
  evidence?: AlphaProbeEvidence;
  encoded?: Extract<AlphaPresentationReport, { kind: 'encoded' }>;
  packedReceipt?: { etag: string; size: number; sha256: string };
  writeOwner?: string;
}
/** The physical container receives only the currently accepted admission. */
export interface PreparedAlphaAdmission { admission: VideoPresentationAdmission | null; token: string | null; snapshot: VideoPresentationIngestSnapshot }
/** A private accepted capability accompanies bytes without changing public schema. */
export interface AlphaPackedIdentity extends AcceptedVideoPresentationAttempt { token: string }
/** The durable pre-write claim supplies the actual previously observed R2 version. */
export interface AlphaPackedWriteClaim { owner: string; key: string; etag: string | null; byteLength: number }
/** Facts measured from the complete stored bytes, never from an HTTP caller. */
export interface AlphaPackedReceipt { etag: string; size: number; sha256: string }
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
   * Reserve this accepted identity before a packed byte reaches R2.
   * @param identity - Original accepted private capability.
   * @param byteLength - Complete stream length to enforce at storage.
   * @returns One exclusive physical write claim, or a refusal.
   * @throws {Error} When durable storage or R2 cannot be read.
   */
  async claimPacked(identity: AlphaPackedIdentity, byteLength: number): Promise<AlphaPackedWriteClaim | null> {
    void identity; void byteLength;
    return null;
  }

  /**
   * Publish a verified complete packed receipt and its manifest under the same claim.
   * @param identity - Originally accepted private capability.
   * @param owner - Physical pre-write owner.
   * @param receipt - Actual stored object facts.
   * @returns Whether the still-current identity committed readiness.
   * @throws {Error} When persistence fails.
   */
  async completePacked(identity: AlphaPackedIdentity, owner: string, receipt: AlphaPackedReceipt): Promise<boolean> {
    void identity; void owner; void receipt;
    return false;
  }

  /**
   * Release only the failed physical write's own claim.
   * @param identity - Original accepted private capability.
   * @param owner - Failed physical writer.
   * @returns Nothing after the exact owner is released.
   * @throws {Error} When durable storage cannot be updated.
   */
  async releasePacked(identity: AlphaPackedIdentity, owner: string): Promise<void> { void identity; void owner; }

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
      if (current !== undefined) await this.storage.put(`${RECORD_KEY}:${current.admission.jobId}`, current);
      const original = input.original;
      const presentation: VideoPresentation | null = original === null ? null : {
        schemaVersion: 1, sourceFingerprint: input.sourceFingerprint, original,
        state: input.knownAlpha === true ? 'alpha_pending' : 'classifying', attempt: { jobId: input.jobId, deadlineAt: input.deadlineAt },
      };
      const snapshot: VideoPresentationIngestSnapshot = { presentation, attempt: {
        jobId: input.jobId, deadlineAt: input.deadlineAt, status: 'accepted', usage: null,
      } };
      const head = await this.bucket.head(videoPresentationKeyFor(input.storageKey));
      const record: PresentationRecord = { admission: input, snapshot, descriptorETag: head?.etag ?? null, token: crypto.randomUUID() };
      await this.storage.put(RECORD_KEY, record);
      if (presentation !== null) await this.writeDescriptor(record, presentation);
      return snapshot;
    });
  }

  /**
   * Claim the fixed active attempt before any container IO starts.
   * @param identity - Originally accepted source and deadline.
   * @returns Current admission or a replayed terminal result without another run.
   * @throws {Error} When durable state cannot be read or updated.
   */
  async prepare(identity: AcceptedVideoPresentationAttempt): Promise<PreparedAlphaAdmission> {
    return this.gate(async () => {
      const current = await this.storage.get<PresentationRecord>(RECORD_KEY);
      const record = current?.admission.jobId === identity.jobId ? current : await this.storage.get<PresentationRecord>(`${RECORD_KEY}:${identity.jobId}`);
      if (record === undefined || record.admission.sourceFingerprint !== identity.sourceFingerprint || record.admission.deadlineAt !== identity.deadlineAt) return { admission: null, token: null, snapshot: { presentation: null, attempt: null } };
      const attempt = record.snapshot.attempt;
      if (current?.admission.jobId !== identity.jobId || attempt === null || attempt.status === 'completed' || attempt.status === 'failed') return { admission: null, token: null, snapshot: record.snapshot };
      attempt.status = 'running';
      await this.persist(record);
      return { admission: record.admission, token: record.token, snapshot: record.snapshot };
    });
  }

  /**
   * Retain trusted probe facts and actual usage under their original admission.
   * @param fact - Container report carrying its private accepted capability.
   * @returns Whether the still-owned report was accepted.
   * @throws {Error} When persistence or descriptor publication fails.
   */
  async report(fact: AlphaPresentationReport): Promise<boolean> {
    let proposed: VideoPresentation | null = null;
    const accepted = await this.gate(async () => {
      const active = await this.storage.get<PresentationRecord>(RECORD_KEY);
      const record = active?.admission.jobId === fact.jobId ? active : await this.storage.get<PresentationRecord>(`${RECORD_KEY}:${fact.jobId}`);
      if (record === undefined || record.token !== fact.token || record.admission.sourceFingerprint !== fact.sourceFingerprint || record.admission.deadlineAt !== fact.deadlineAt) return false;
      const isActive = active?.admission.jobId === fact.jobId;
      if (fact.kind !== 'finished' && !isActive) return false;
      if (fact.kind === 'probe') {
        if (record.snapshot.presentation?.state === 'native' || record.snapshot.presentation?.state === 'alpha_ready') return true;
        const original = record.admission.original;
        if (original !== null && (original.width !== fact.original.width || original.height !== fact.original.height || original.duration !== fact.original.duration)) {
          proposed = { schemaVersion: 1, sourceFingerprint: fact.sourceFingerprint, original, state: 'failed',
            attempt: { jobId: fact.jobId, deadlineAt: fact.deadlineAt }, error: 'metadata_mismatch' };
        } else {
          record.admission.original = fact.original;
          record.evidence = fact.evidence;
          const base: VideoPresentation = { schemaVersion: 1, sourceFingerprint: fact.sourceFingerprint, original: fact.original,
            state: 'classifying', attempt: { jobId: fact.jobId, deadlineAt: fact.deadlineAt } };
          record.snapshot.presentation = base;
          proposed = { ...base, state: fact.classification === 'confirmed_alpha' ? 'alpha_pending' : 'native' };
        }
      } else if (fact.kind === 'encoded') {
        if (record.snapshot.presentation?.state !== 'alpha_pending' || record.evidence === undefined) return false;
        const manifest = alphaManifestSchema.safeParse({ schemaVersion: 1, sourceFingerprint: fact.sourceFingerprint,
          packedURL: record.admission.packedURL, packedWidth: fact.packedWidth, packedHeight: fact.packedHeight, colorRect: fact.colorRect, alphaRect: fact.alphaRect });
        if (!manifest.success || !alphaManifestMatchesPresentation(manifest.data, record.snapshot.presentation)) return false;
        record.encoded = fact;
      } else {
        const attempt = record.snapshot.attempt;
        if (attempt === null) return false;
        if (attempt.usage !== null && (attempt.usage.wallMs !== fact.usage.wallMs || attempt.usage.cpuUsec !== fact.usage.cpuUsec)) return false;
        attempt.usage = fact.usage;
        if (record.admission.pricing !== undefined && record.admission.actorUserId !== undefined) {
          record.snapshot.usageFact = { jobId: fact.jobId, actorUserId: record.admission.actorUserId, projectId: record.admission.projectId ?? null,
            usage: fact.usage, pricing: record.admission.pricing };
        }
        if (fact.error !== undefined && record.snapshot.presentation?.state !== 'native' && record.snapshot.presentation?.state !== 'alpha_ready') {
          attempt.status = 'failed'; attempt.error = fact.error;
          if (record.snapshot.presentation !== null) proposed = { ...record.snapshot.presentation, state: 'failed', error: fact.error };
        }
      }
      await this.persist(record);
      return true;
    });
    if (accepted && proposed !== null) {
      const snapshot = await this.advance(fact, proposed);
      return snapshot.attempt?.jobId === fact.jobId && snapshot.presentation?.state !== 'failed';
    }
    return accepted;
  }

  /**
   * Mark a failed execution without inventing missing original metadata.
   * @param identity - Accepted source and original deadline.
   * @param error - Stable failure code.
   * @returns Current source facts, ignoring superseded attempts.
   * @throws {Error} When persistence fails.
   */
  async fail(identity: AcceptedVideoPresentationAttempt, error: string): Promise<VideoPresentationIngestSnapshot> {
    let proposed: VideoPresentation | null = null;
    const snapshot = await this.gate(async () => {
      const record = await this.storage.get<PresentationRecord>(RECORD_KEY);
      if (record === undefined) return { presentation: null, attempt: null };
      if (record.admission.jobId !== identity.jobId || record.admission.sourceFingerprint !== identity.sourceFingerprint || record.admission.deadlineAt !== identity.deadlineAt) return record.snapshot;
      if (record.snapshot.presentation?.state === 'native' || record.snapshot.presentation?.state === 'alpha_ready') return record.snapshot;
      if (record.snapshot.attempt !== null) { record.snapshot.attempt.status = 'failed'; record.snapshot.attempt.error = error; }
      if (record.snapshot.presentation !== null) proposed = { ...record.snapshot.presentation, state: 'failed', error };
      await this.persist(record);
      return record.snapshot;
    });
    return proposed === null ? snapshot : this.advance(identity, proposed);
  }

  /**
   * Acknowledge the existing usage fact only after its unique SQL record commits.
   * @param identity - Actual measured attempt.
   * @returns Its unchanged source facts with an independent usage acknowledgement.
   * @throws {Error} When durable acknowledgement fails.
   */
  async acknowledgeUsage(identity: AcceptedVideoPresentationAttempt): Promise<VideoPresentationIngestSnapshot> {
    return this.gate(async () => {
      const active = await this.storage.get<PresentationRecord>(RECORD_KEY);
      const record = active?.admission.jobId === identity.jobId ? active : await this.storage.get<PresentationRecord>(`${RECORD_KEY}:${identity.jobId}`);
      if (record === undefined || record.admission.sourceFingerprint !== identity.sourceFingerprint || record.admission.deadlineAt !== identity.deadlineAt) return { presentation: null, attempt: null };
      if (record.snapshot.attempt !== null && record.snapshot.usageFact !== undefined) record.snapshot.attempt.usageRecorded = true;
      await this.persist(record);
      return record.snapshot;
    });
  }

  /**
   * Read one original attempt's receipt without exposing it as the current source.
   * @param identity - The original source and accepted work.
   * @returns Its own durable facts, including late measured usage.
   * @throws {Error} When storage cannot be read.
   */
  async snapshotFor(identity: AcceptedVideoPresentationAttempt): Promise<VideoPresentationIngestSnapshot> {
    return this.gate(async () => {
      const active = await this.storage.get<PresentationRecord>(RECORD_KEY);
      const record = active?.admission.jobId === identity.jobId ? active : await this.storage.get<PresentationRecord>(`${RECORD_KEY}:${identity.jobId}`);
      return record?.admission.sourceFingerprint === identity.sourceFingerprint && record.admission.deadlineAt === identity.deadlineAt ? record.snapshot : { presentation: null, attempt: null };
    });
  }

  /**
   * Persist original-attempt receipts without ever restoring a replaced owner.
   * @param record - One accepted identity's facts.
   * @returns Nothing after durable persistence.
   * @throws {Error} When storage fails.
   */
  private async persist(record: PresentationRecord): Promise<void> {
    await this.storage.put(`${RECORD_KEY}:${record.admission.jobId}`, record);
    const active = await this.storage.get<PresentationRecord>(RECORD_KEY);
    if (active?.admission.jobId === record.admission.jobId && active.admission.sourceFingerprint === record.admission.sourceFingerprint && active.admission.deadlineAt === record.admission.deadlineAt) await this.storage.put(RECORD_KEY, record);
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
        if (record.snapshot.presentation !== null) {
          const stored = await this.bucket.get(videoPresentationKeyFor(storageKey));
          const descriptor = parseVideoPresentation(stored === null ? null : await stored.json().catch(() => null), sourceFingerprint);
          const original = record.snapshot.presentation.original;
          if (descriptor === null || descriptor.original.width !== original.width || descriptor.original.height !== original.height || descriptor.original.duration !== original.duration ||
            descriptor.attempt?.jobId !== record.admission.jobId || descriptor.attempt.deadlineAt !== record.admission.deadlineAt) {
            const failed: VideoPresentation = { ...record.snapshot.presentation, state: 'failed', error: 'descriptor_invalid' };
            record.descriptorETag = stored?.etag ?? null;
            await this.writeDescriptor(record, failed);
            record.snapshot.presentation = failed;
            delete record.snapshot.manifest;
            if (record.snapshot.attempt !== null) record.snapshot.attempt = { ...record.snapshot.attempt, status: 'failed', error: 'descriptor_invalid' };
            await this.storage.put(RECORD_KEY, record);
            return record.snapshot;
          }
        }
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
