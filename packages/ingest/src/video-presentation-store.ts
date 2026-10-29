// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { alphaManifestKeyFor, alphaManifestMatchesPresentation, alphaManifestSchema, alphaPackedKeyFor, parseVideoPresentation, videoPresentationKeyFor,
  type AlphaManifest, type VideoPresentation, type VideoPresentationIngestSnapshot, type VideoPresentationPricing, type VideoPresentationProcessLimits } from '@breatic/shared';
import { advanceVideoPresentation, type AcceptedVideoPresentationAttempt } from '@ingest/video-presentation-state.js';
import type { AlphaPresentationReport, AlphaProbeEvidence } from '@ingest/alpha-run-contract.js';
import type { VideoPresentationRegisteredMetadata } from '@shared/upload/video-presentation-types.js';
import { videoDurationsMatch } from '@shared/upload/video-duration.js';
import { classifyVideoSourceLedgerFailure, videoSourceLedgerKeyFor, videoSourceLedgerReceiptV2Schema, videoSourceLedgerTableKeyFor,
  type VideoSourceLedgerReceiptV2, type VideoSourceLedgerStateV2 } from '@breatic/shared';
import { hashStoredObject } from '@ingest/stored-object.js';

/** Source facts as this store keeps them: it writes only version 2 ledger states. */
export type PresentationSnapshot = Omit<VideoPresentationIngestSnapshot, 'sourceLedger'> & { sourceLedger?: VideoSourceLedgerStateV2 | null };

/** Backend-authorized admission of one canonical source's auxiliary work. */
export interface VideoPresentationAdmission extends AcceptedVideoPresentationAttempt {
  storageKey: string;
  contentType: string;
  original: VideoPresentation['original'] | null;
  registeredMetadata?: VideoPresentationRegisteredMetadata;
  knownAlpha?: boolean;
  repair?: boolean;
  limits?: VideoPresentationProcessLimits;
  pricing?: VideoPresentationPricing;
  actorUserId?: string;
  projectId?: string | null;
  packedURL?: string;
  manifestURL?: string;
  sourceLedgerURL?: string;
  sourceLedgerTableURL?: string;
  ledgerOnly?: boolean;
}

/** Private durable state remains valid even while original metadata is unknown. */
interface PresentationRecord {
  admission: VideoPresentationAdmission;
  snapshot: PresentationSnapshot;
  descriptorETag: string | null;
  token: string;
  evidence?: AlphaProbeEvidence;
  measuredOriginal?: VideoPresentation['original'];
  encoded?: Extract<AlphaPresentationReport, { kind: 'encoded' }>;
  packedReceipt?: { etag: string; size: number; sha256: string };
  writeOwner?: string;
  sourceLedgerIntent?: { claim: SourceLedgerWriteClaim; declaration: SourceLedgerDeclaration; active: boolean; tableETag?: string };
  finalized?: boolean;
}
/** The physical container receives only the currently accepted admission. */
export interface PreparedAlphaAdmission { admission: VideoPresentationAdmission | null; token: string | null; snapshot: PresentationSnapshot }
/** A private accepted capability accompanies bytes without changing public schema. */
export interface AlphaPackedIdentity extends AcceptedVideoPresentationAttempt { token: string }
/** The durable pre-write claim supplies the actual previously observed R2 version. */
export interface AlphaPackedWriteClaim { owner: string; key: string; etag: string | null; byteLength: number }
/** Facts measured from the complete stored bytes, never from an HTTP caller. */
export interface AlphaPackedReceipt { etag: string; size: number; sha256: string }
/** The producer's declaration of its one write: the full ledger and the compact table written before it. */
export interface SourceLedgerDeclaration { producerVersion: 2; byteLength: number; table: { byteLength: number; frameCount: number } }
/** Durable authorization for one write of both objects, each under its own observed version. */
export interface SourceLedgerWriteClaim {
  owner: string; key: string; priorETag: string | null; byteLength: number;
  table: { key: string; priorETag: string | null; byteLength: number };
}
/** Facts measured from both stored objects, never from an HTTP caller. */
export interface SourceLedgerMeasurement extends AlphaPackedReceipt { table: AlphaPackedReceipt }
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
   * Reserve one source-ledger writer before bytes reach R2.
   * @param identity - The original accepted private capability.
   * @param declaration - Complete original producer byte/count facts.
   * @returns One persisted claim or a refusal.
   * @throws {Error} When durable storage or R2 cannot be read.
   */
  claimSourceLedger(identity: AlphaPackedIdentity, declaration: SourceLedgerDeclaration): Promise<SourceLedgerWriteClaim | null> {
    return this.gate(async () => {
      const record = await this.storage.get<PresentationRecord>(RECORD_KEY);
      const limits = record?.admission.limits?.sourceLedger;
      const within = (value: unknown, ceiling: number): boolean => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= ceiling;
      if (record === undefined || !this.owns(record, identity) || limits === undefined || record.admission.sourceLedgerURL === undefined ||
        record.admission.sourceLedgerTableURL === undefined || identity.deadlineAt <= Date.now() || record.snapshot.sourceLedger?.state !== 'pending' ||
        record.sourceLedgerIntent !== undefined || declaration.producerVersion !== 2 || !within(declaration.byteLength, limits.maxBytes) ||
        !within(declaration.table?.byteLength, limits.maxBytes) || !within(declaration.table.frameCount, Number.MAX_SAFE_INTEGER)) return null;
      const key = videoSourceLedgerKeyFor(record.admission.storageKey);
      const tableKey = videoSourceLedgerTableKeyFor(record.admission.storageKey);
      const [head, tableHead] = await Promise.all([this.bucket.head(key), this.bucket.head(tableKey)]);
      const claim = { owner: crypto.randomUUID(), key, priorETag: head?.etag ?? null, byteLength: declaration.byteLength,
        table: { key: tableKey, priorETag: tableHead?.etag ?? null, byteLength: declaration.table.byteLength } };
      record.sourceLedgerIntent = { claim, declaration: { producerVersion: 2, byteLength: declaration.byteLength,
        table: { byteLength: declaration.table.byteLength, frameCount: declaration.table.frameCount } }, active: true };
      await this.persist(record);
      return claim;
    });
  }

  /**
   * Retain the measured receipt of both stored objects under their original, still active write intent.
   * @param identity - The original accepted private capability.
   * @param owner - The original durable write nonce.
   * @param measured - Actual stored byte facts of the ledger and its table.
   * @returns Whether that original receipt was accepted.
   * @throws {Error} When durable storage or physical verification fails.
   */
  completeSourceLedger(identity: AlphaPackedIdentity, owner: string, measured: SourceLedgerMeasurement): Promise<boolean> {
    return this.gate(async () => {
      const record = await this.originalRecord(identity);
      // A released claim's writer gave up; its late objects are not this job's result.
      if (record === undefined || !this.owns(record, identity) || record.sourceLedgerIntent?.claim.owner !== owner || !record.sourceLedgerIntent.active) return false;
      const [object, table] = await this.ledgerObjects(record.admission.storageKey);
      if (!this.ledgerObjectsMatch(record, object, table) || object!.etag !== measured.etag || object!.size !== measured.size ||
        table!.etag !== measured.table?.etag || table!.size !== measured.table.size) return false;
      return this.commitLedger(record, measured);
    });
  }

  /**
   * Release active ownership while preserving the original write intent.
   * @param identity - The original accepted private capability.
   * @param owner - The matching original durable writer.
   * @returns Nothing after release.
   * @throws {Error} When durable persistence fails.
   */
  releaseSourceLedger(identity: AlphaPackedIdentity, owner: string): Promise<void> {
    return this.gate(async () => {
      const record = await this.originalRecord(identity);
      if (record === undefined || !this.owns(record, identity) || record.sourceLedgerIntent?.claim.owner !== owner) return;
      record.sourceLedgerIntent.active = false;
      await this.persist(record);
    });
  }

  /**
   * Reserve this accepted identity before a packed byte reaches R2.
   * @param identity - Original accepted private capability.
   * @param byteLength - Complete stream length to enforce at storage.
   * @returns One exclusive physical write claim, or a refusal.
   * @throws {Error} When durable storage or R2 cannot be read.
   */
  async claimPacked(identity: AlphaPackedIdentity, byteLength: number): Promise<AlphaPackedWriteClaim | null> {
    return this.gate(async () => {
      const record = await this.storage.get<PresentationRecord>(RECORD_KEY);
      if (record === undefined || record.token !== identity.token || record.admission.jobId !== identity.jobId ||
        record.admission.sourceFingerprint !== identity.sourceFingerprint || record.admission.deadlineAt !== identity.deadlineAt ||
        identity.deadlineAt <= Date.now() || record.snapshot.presentation?.state !== 'alpha_pending' || record.encoded === undefined || record.writeOwner !== undefined ||
        !Number.isSafeInteger(byteLength) || byteLength <= 0 || record.admission.limits === undefined || byteLength > record.admission.limits.maxPackedBytes) return null;
      const key = alphaPackedKeyFor(record.admission.storageKey);
      const head = await this.bucket.head(key);
      const owner = crypto.randomUUID();
      record.writeOwner = owner;
      await this.persist(record);
      return { owner, key, etag: head?.etag ?? null, byteLength };
    });
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
    let proposed: VideoPresentation | null = null;
    const accepted = await this.gate(async () => {
      const record = await this.storage.get<PresentationRecord>(RECORD_KEY);
      if (record === undefined || record.token !== identity.token || record.admission.jobId !== identity.jobId ||
        record.admission.sourceFingerprint !== identity.sourceFingerprint || record.admission.deadlineAt !== identity.deadlineAt || record.writeOwner !== owner ||
        record.encoded === undefined || record.snapshot.presentation === null || record.admission.limits === undefined || record.admission.manifestURL === undefined ||
        record.snapshot.presentation.state === 'native' || record.snapshot.presentation.state === 'alpha_ready' || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return false;
      const packed = await this.bucket.head(alphaPackedKeyFor(record.admission.storageKey));
      if (packed === null || packed.etag !== receipt.etag || packed.size !== receipt.size || receipt.size <= 0 || receipt.size > record.admission.limits.maxPackedBytes || packed.httpMetadata?.contentType !== 'video/mp4') return false;
      const manifest = alphaManifestSchema.safeParse({ schemaVersion: 1, sourceFingerprint: identity.sourceFingerprint, packedURL: record.admission.packedURL,
        packedWidth: record.encoded.packedWidth, packedHeight: record.encoded.packedHeight, colorRect: record.encoded.colorRect, alphaRect: record.encoded.alphaRect });
      if (!manifest.success || !alphaManifestMatchesPresentation(manifest.data, record.snapshot.presentation)) return false;
      const key = alphaManifestKeyFor(record.admission.storageKey);
      const prior = await this.bucket.head(key);
      const written = await this.bucket.put(key, JSON.stringify(manifest.data), {
        onlyIf: prior === null ? { etagDoesNotMatch: '*' } : { etagMatches: prior.etag }, httpMetadata: { contentType: 'application/json' },
      });
      if (written === null) return false;
      record.packedReceipt = receipt;
      delete record.writeOwner;
      await this.persist(record);
      proposed = { ...record.snapshot.presentation, state: 'alpha_ready', alpha: { manifestURL: record.admission.manifestURL } };
      delete proposed.error;
      return true;
    });
    if (!accepted || proposed === null) return false;
    const snapshot = await this.advance(identity, proposed);
    return snapshot.attempt?.jobId === identity.jobId && snapshot.presentation?.state === 'alpha_ready';
  }

  /**
   * Release only the failed physical write's own claim.
   * @param identity - Original accepted private capability.
   * @param owner - Failed physical writer.
   * @returns Nothing after the exact owner is released.
   * @throws {Error} When durable storage cannot be updated.
   */
  async releasePacked(identity: AlphaPackedIdentity, owner: string): Promise<void> {
    await this.gate(async () => {
      const current = await this.storage.get<PresentationRecord>(RECORD_KEY);
      const record = current?.admission.jobId === identity.jobId ? current : await this.storage.get<PresentationRecord>(`${RECORD_KEY}:${identity.jobId}`);
      if (record === undefined || record.token !== identity.token || record.admission.sourceFingerprint !== identity.sourceFingerprint || record.admission.deadlineAt !== identity.deadlineAt || record.writeOwner !== owner) return;
      delete record.writeOwner;
      await this.persist(record);
    });
  }

  /**
   * Persist the first accepted identity or replay the current one.
   * @param input - The registered source and requested work identity.
   * @returns The durable accepted identity and any measured descriptor.
   * @throws {Error} When durable admission or R2 persistence fails.
   */
  async accept(input: VideoPresentationAdmission): Promise<PresentationSnapshot> {
    return this.gate(async () => {
      const current = await this.storage.get<PresentationRecord>(RECORD_KEY);
      const requestedLedger = input.limits?.sourceLedger !== undefined;
      const sameSource = current?.admission.sourceFingerprint === input.sourceFingerprint;
      // A ready ledger or a content failure is settled: producing it again from the same bytes gives the same result.
      let settledLedger: VideoSourceLedgerStateV2 | null | undefined;
      if (sameSource) {
        const status = current.snapshot.attempt?.status;
        if (status === 'accepted' || status === 'running') return current.snapshot;
        await this.refreshLedger(current);
        const ledger = current.snapshot.sourceLedger;
        if (ledger?.state === 'ready' || (ledger?.state === 'failed' && classifyVideoSourceLedgerFailure(ledger.errorCode) === 'content')) settledLedger = ledger;
        // A transient failure, or no ledger yet, is produced again; this admission is the one entry for that, retries included.
        const produceLedger = requestedLedger && settledLedger === undefined;
        const presentation = current.snapshot.presentation;
        const presentationReady = presentation?.state === 'native' ||
          (presentation?.state === 'alpha_ready' && await this.manifest(current.admission, presentation, current.packedReceipt) !== null);
        if (!produceLedger && (input.repair !== true || presentationReady)) return current.snapshot;
      }
      if (current !== undefined) await this.storage.put(`${RECORD_KEY}:${current.admission.jobId}`, current);
      const stored = current === undefined ? await this.bucket.get(videoPresentationKeyFor(input.storageKey)) : null;
      const previous = sameSource ? current.snapshot.presentation : stored === null ? null : parseVideoPresentation(await stored.json().catch(() => null), input.sourceFingerprint);
      const previousManifest = previous?.state === 'alpha_ready' ? await this.manifest(sameSource ? current.admission : input, previous, sameSource ? current.packedReceipt : undefined) : null;
      const readyPresentation = previous?.state === 'native' || previous?.state === 'alpha_ready' && previousManifest !== null;
      const ledgerOnly = requestedLedger && settledLedger === undefined && readyPresentation;
      const admission = { ...input };
      delete admission.ledgerOnly;
      if (ledgerOnly) admission.ledgerOnly = true;
      // This attempt receives a write capability only for a ledger it must produce.
      // A settled ledger keeps its actual producer and URLs.
      if (settledLedger !== undefined) { delete admission.sourceLedgerURL; delete admission.sourceLedgerTableURL; }
      const original = input.original;
      const presentation: VideoPresentation | null = ledgerOnly ? previous : original === null ? null : {
        schemaVersion: 1, sourceFingerprint: input.sourceFingerprint, original,
        state: input.knownAlpha === true ? 'alpha_pending' : 'classifying', attempt: { jobId: input.jobId, deadlineAt: input.deadlineAt },
      };
      const snapshot: PresentationSnapshot = { presentation, attempt: {
        jobId: input.jobId, deadlineAt: input.deadlineAt, status: 'accepted', usage: null,
      }, ...(ledgerOnly && previousManifest !== null ? { manifest: previousManifest } : {}),
      ...(settledLedger !== undefined ? { sourceLedger: settledLedger } : requestedLedger ? {
        sourceLedger: { state: 'pending', schemaVersion: 2, sourceFingerprint: input.sourceFingerprint, producerVersion: 2,
          attempt: { jobId: input.jobId, deadlineAt: input.deadlineAt } },
      } : {}) };
      const head = await this.bucket.head(videoPresentationKeyFor(input.storageKey));
      const record: PresentationRecord = { admission, snapshot, descriptorETag: head?.etag ?? null, token: crypto.randomUUID(),
        ...(ledgerOnly && sameSource && current.packedReceipt !== undefined ? { packedReceipt: current.packedReceipt } : {}) };
      await this.storage.put(RECORD_KEY, record);
      if (presentation !== null && !ledgerOnly) await this.writeDescriptor(record, presentation);
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
    let rejectedProbe = false;
    const accepted = await this.gate(async () => {
      const active = await this.storage.get<PresentationRecord>(RECORD_KEY);
      const record = active?.admission.jobId === fact.jobId ? active : await this.storage.get<PresentationRecord>(`${RECORD_KEY}:${fact.jobId}`);
      if (record === undefined || record.token !== fact.token || record.admission.sourceFingerprint !== fact.sourceFingerprint || record.admission.deadlineAt !== fact.deadlineAt) return false;
      const isActive = active?.admission.jobId === fact.jobId;
      if (fact.kind !== 'finished' && !isActive) return false;
      if (fact.kind === 'source_ledger_failed') {
        if (record.admission.limits?.sourceLedger === undefined || !/^[a-z][a-z0-9_]*$/.test(fact.error)) return false;
        this.failLedger(record, fact.error);
      } else if (fact.kind === 'probe') {
        if (record.snapshot.presentation?.state === 'native' || record.snapshot.presentation?.state === 'alpha_ready') return true;
        const original = record.snapshot.presentation?.original ?? record.admission.original;
        const known = record.admission.registeredMetadata ?? original;
        if (known !== null && ((known.width !== null && known.width !== fact.original.width) || (known.height !== null && known.height !== fact.original.height) ||
          (known.duration !== null && !videoDurationsMatch(known.duration, fact.original.duration)))) {
          rejectedProbe = true;
          if (record.snapshot.attempt !== null) { record.snapshot.attempt.status = 'failed'; record.snapshot.attempt.error = 'metadata_mismatch'; }
          this.endPendingLedger(record);
          if (original !== null) proposed = { schemaVersion: 1, sourceFingerprint: fact.sourceFingerprint, original, state: 'failed',
            attempt: { jobId: fact.jobId, deadlineAt: fact.deadlineAt }, error: 'metadata_mismatch' };
        } else {
          const publishedOriginal = original ?? fact.original;
          record.admission.original = publishedOriginal;
          record.measuredOriginal = fact.original;
          record.evidence = fact.evidence;
          const base: VideoPresentation = { schemaVersion: 1, sourceFingerprint: fact.sourceFingerprint, original: publishedOriginal,
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
        record.finalized = true;
        if (record.admission.pricing !== undefined && record.admission.actorUserId !== undefined) {
          record.snapshot.usageFact = { jobId: fact.jobId, actorUserId: record.admission.actorUserId, projectId: record.admission.projectId ?? null,
            usage: fact.usage, pricing: record.admission.pricing };
        }
        if (fact.error !== undefined && record.snapshot.presentation?.state !== 'native' && record.snapshot.presentation?.state !== 'alpha_ready') {
          const error = attempt.error ?? fact.error;
          attempt.status = 'failed'; attempt.error = error;
          if (record.snapshot.presentation !== null) {
            record.snapshot.presentation = { ...record.snapshot.presentation, state: 'failed', error };
            if (isActive) proposed = record.snapshot.presentation;
          }
          this.endPendingLedger(record);
        }
      }
      this.finalizeWork(record);
      await this.persist(record);
      return true;
    });
    if (accepted && proposed !== null) {
      const snapshot = await this.advance(fact, proposed);
      return fact.kind === 'finished' || (snapshot.attempt?.jobId === fact.jobId && snapshot.presentation?.state !== 'failed');
    }
    return accepted && !rejectedProbe;
  }

  /**
   * Mark a failed execution without inventing missing original metadata.
   * @param identity - Accepted source and original deadline.
   * @param error - Stable failure code.
   * @returns Current source facts, ignoring superseded attempts.
   * @throws {Error} When persistence fails.
   */
  async fail(identity: AcceptedVideoPresentationAttempt, error: string): Promise<PresentationSnapshot> {
    let proposed: VideoPresentation | null = null;
    const snapshot = await this.gate(async () => {
      const record = await this.originalRecord(identity);
      if (record === undefined) return { presentation: null, attempt: null };
      if (record.snapshot.attempt?.status === 'completed' || record.snapshot.attempt?.status === 'failed') return record.snapshot;
      const ready = record.snapshot.presentation?.state === 'native' || record.snapshot.presentation?.state === 'alpha_ready';
      if (ready && record.admission.limits?.sourceLedger === undefined) return record.snapshot;
      if (record.snapshot.attempt !== null) { record.snapshot.attempt.status = 'failed'; record.snapshot.attempt.error = error; }
      // Before the presentation is ready the error is the presentation's own; the ledger never started and stays retryable.
      this.failLedger(record, ready || error === 'expired' ? error : 'presentation_failed');
      if (record.snapshot.presentation !== null && !ready) proposed = { ...record.snapshot.presentation, state: 'failed', error };
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
  async acknowledgeUsage(identity: AcceptedVideoPresentationAttempt): Promise<PresentationSnapshot> {
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
  async snapshotFor(identity: AcceptedVideoPresentationAttempt): Promise<PresentationSnapshot> {
    return this.gate(async () => {
      const active = await this.storage.get<PresentationRecord>(RECORD_KEY);
      const record = active?.admission.jobId === identity.jobId ? active : await this.storage.get<PresentationRecord>(`${RECORD_KEY}:${identity.jobId}`);
      return record?.admission.sourceFingerprint === identity.sourceFingerprint && record.admission.deadlineAt === identity.deadlineAt ? record.snapshot : { presentation: null, attempt: null };
    });
  }

  /**
   * Match the original private capability without granting a new lifetime.
   * @param record - One current or archived original admission.
   * @param identity - The private caller's fixed capability.
   * @returns Whether every original identity component agrees.
   * @throws {never} No IO or coercion is performed.
   */
  private owns(record: PresentationRecord, identity: AlphaPackedIdentity): boolean {
    return record.token === identity.token && record.admission.jobId === identity.jobId &&
      record.admission.sourceFingerprint === identity.sourceFingerprint && record.admission.deadlineAt === identity.deadlineAt;
  }

  /**
   * Locate original facts directly, without making an archive current again.
   * @param identity - The original accepted source, job and deadline.
   * @returns Its matching current or archived record, otherwise none.
   * @throws {Error} When durable storage cannot be read.
   */
  private async originalRecord(identity: AcceptedVideoPresentationAttempt): Promise<PresentationRecord | undefined> {
    const active = await this.storage.get<PresentationRecord>(RECORD_KEY);
    const record = active?.admission.jobId === identity.jobId ? active : await this.storage.get<PresentationRecord>(`${RECORD_KEY}:${identity.jobId}`);
    return record?.admission.sourceFingerprint === identity.sourceFingerprint && record.admission.deadlineAt === identity.deadlineAt ? record : undefined;
  }

  /**
   * Read the current headers of the ledger and its compact table.
   * @param storageKey - The registered canonical key both objects are derived from.
   * @returns The ledger and table headers, each null when absent.
   * @throws {Error} When R2 cannot be read.
   */
  private ledgerObjects(storageKey: string): Promise<[R2Object | null, R2Object | null]> {
    return Promise.all([this.bucket.head(videoSourceLedgerKeyFor(storageKey)), this.bucket.head(videoSourceLedgerTableKeyFor(storageKey))]);
  }

  /**
   * Bind the actual headers of both objects to one retained original write intent.
   * @param record - The actual producer's admission and retained intent.
   * @param object - Actual complete ledger headers, never caller metadata.
   * @param table - Actual complete table headers, never caller metadata.
   * @returns Whether both physical objects belong to that exact declared write.
   * @throws {never} Only measured headers and retained scalar facts are compared.
   */
  private ledgerObjectsMatch(record: PresentationRecord, object: R2Object | null, table: R2Object | null): boolean {
    const intent = record.sourceLedgerIntent;
    const limits = record.admission.limits?.sourceLedger;
    const owned = (stored: R2Object | null, byteLength: number): boolean => stored !== null && limits !== undefined && stored.size === byteLength &&
      stored.size > 0 && stored.size <= limits.maxBytes && stored.httpMetadata?.contentType === 'application/json' &&
      stored.customMetadata?.sourceLedgerJobId === record.admission.jobId && stored.customMetadata.sourceLedgerClaimOwner === intent?.claim.owner;
    // A version 1 intent has no table claim; its objects are never a version 2 ledger.
    return intent !== undefined && intent.declaration.producerVersion === 2 && record.admission.sourceLedgerURL !== undefined &&
      record.admission.sourceLedgerTableURL !== undefined && intent.claim.key === videoSourceLedgerKeyFor(record.admission.storageKey) &&
      intent.claim.table.key === videoSourceLedgerTableKeyFor(record.admission.storageKey) &&
      owned(object, intent.claim.byteLength) && owned(table, intent.claim.table.byteLength);
  }

  /**
   * Assemble the receipt of both objects from the original admission and actual stored measurements.
   * @param record - The original producer, retaining its fixed public addresses and declaration.
   * @param measured - Actual complete stored bytes of both objects.
   * @returns A validated original receipt, otherwise none.
   * @throws {never} Invalid scalar facts do not become ready receipts.
   */
  private ledgerReceipt(record: PresentationRecord, measured: SourceLedgerMeasurement): VideoSourceLedgerReceiptV2 | null {
    const declaration = record.sourceLedgerIntent?.declaration;
    if (declaration === undefined) return null;
    const parsed = videoSourceLedgerReceiptV2Schema.safeParse({
      schemaVersion: 2, sourceFingerprint: record.admission.sourceFingerprint, producerVersion: 2,
      attempt: { jobId: record.admission.jobId, deadlineAt: record.admission.deadlineAt }, url: record.admission.sourceLedgerURL,
      etag: measured.etag, size: measured.size, sha256: measured.sha256, contentType: 'application/json',
      table: { url: record.admission.sourceLedgerTableURL, sha256: measured.table.sha256, size: measured.table.size, frameCount: declaration.table.frameCount },
    });
    return parsed.success ? parsed.data : null;
  }

  /**
   * The one writer of a ready ledger: retain the measured receipt under its original producer.
   * @param producer - The original producer whose write intent the objects match.
   * @param measured - Actual complete stored bytes of both objects.
   * @returns Whether the receipt was retained; a different receipt never replaces a ready one.
   * @throws {Error} When durable persistence fails.
   */
  private async commitLedger(producer: PresentationRecord, measured: SourceLedgerMeasurement): Promise<boolean> {
    const receipt = this.ledgerReceipt(producer, measured);
    if (receipt === null) return false;
    const prior = producer.snapshot.sourceLedger;
    if (prior?.state === 'ready' && (prior.receipt.etag !== receipt.etag || prior.receipt.sha256 !== receipt.sha256 ||
      prior.receipt.size !== receipt.size || prior.receipt.table.sha256 !== receipt.table.sha256 || prior.receipt.table.size !== receipt.table.size)) return false;
    producer.snapshot.sourceLedger = { state: 'ready', receipt };
    producer.sourceLedgerIntent!.active = false;
    producer.sourceLedgerIntent!.tableETag = measured.table.etag;
    this.finalizeWork(producer);
    await this.persist(producer);
    return true;
  }

  /**
   * Retain a capability failure without changing a completed independent capability.
   * @param record - Original capability and its independent presentation/work facts.
   * @param errorCode - Stable owned failure code.
   * @param physical - Whether an already-ready object's physical proof failed.
   * @returns Nothing after only the ledger sibling is changed.
   * @throws {never} No IO is performed.
   */
  private failLedger(record: PresentationRecord, errorCode: string, physical = false): void {
    const current = record.snapshot.sourceLedger;
    if (current?.state === 'pending') record.snapshot.sourceLedger = { ...current, state: 'failed', errorCode };
    else if (current?.state === 'ready' && physical) {
      const receipt = current.receipt;
      record.snapshot.sourceLedger = { state: 'failed', schemaVersion: 2, sourceFingerprint: receipt.sourceFingerprint,
        producerVersion: 2, attempt: receipt.attempt, errorCode };
    }
  }

  /**
   * End a still pending ledger once its attempt has failed: nothing will produce it under this job.
   * @param record - Original capability whose attempt may have just become terminal.
   * @returns Nothing; the presentation's own error code never becomes the ledger's.
   * @throws {never} No IO is performed.
   */
  private endPendingLedger(record: PresentationRecord): void {
    const attempt = record.snapshot.attempt;
    if (attempt?.status === 'failed') this.failLedger(record, attempt.error === 'expired' ? 'expired' : 'presentation_failed');
  }

  /**
   * Complete newly combined work only after actual finalization and terminal capabilities.
   * @param record - Original accepted work with independently retained usage and capabilities.
   * @returns Nothing; previous terminal states remain terminal.
   * @throws {never} No missing measurement or expense is synthesized.
   */
  private finalizeWork(record: PresentationRecord): void {
    const attempt = record.snapshot.attempt;
    if (record.admission.limits?.sourceLedger === undefined || attempt === null || record.finalized !== true || attempt.status === 'completed' || attempt.status === 'failed') return;
    const presentation = record.snapshot.presentation;
    const ledger = record.snapshot.sourceLedger;
    // A content failure settled by an earlier job is kept, not this job's failure.
    const ownFailure = ledger?.state === 'failed' && ledger.attempt.jobId === record.admission.jobId;
    if (presentation?.state === 'failed' || ownFailure) {
      attempt.status = 'failed';
      attempt.error = presentation?.state === 'failed' ? presentation.error : ledger?.state === 'failed' ? ledger.errorCode : 'presentation_failed';
    } else if ((presentation?.state === 'native' || presentation?.state === 'alpha_ready') && (ledger?.state === 'ready' || ledger?.state === 'failed')) {
      attempt.status = 'completed';
    }
  }

  /**
   * Verify a ready receipt against both stored objects, and recover objects a producer stored but never committed.
   * @param record - Current source facts held under the canonical storage gate.
   * @returns Nothing after verified original receipt recovery and any eligible sibling reuse.
   * @throws {Error} When actual R2 bytes or durable facts cannot be read.
   */
  private async refreshLedger(record: PresentationRecord): Promise<void> {
    const storageKey = record.admission.storageKey;
    const [object, table] = await this.ledgerObjects(storageKey);
    const prior = record.snapshot.sourceLedger;
    if (prior?.state === 'ready') {
      const receipt = prior.receipt;
      const producer = await this.originalRecord({ sourceFingerprint: receipt.sourceFingerprint, ...receipt.attempt });
      if (producer !== undefined && receipt.sourceFingerprint === record.admission.sourceFingerprint &&
        this.ledgerObjectsMatch(producer, object, table) && receipt.etag === object!.etag && receipt.size === object!.size &&
        producer.sourceLedgerIntent!.tableETag === table!.etag) return;
      this.failLedger(record, object === null || table === null ? 'source_ledger_missing' : 'source_ledger_invalid', true);
      await this.persist(record);
    }
    const jobId = object?.customMetadata?.sourceLedgerJobId;
    if (jobId === undefined) return;
    const own = jobId === record.admission.jobId;
    const terminal = record.snapshot.attempt?.status === 'completed' || record.snapshot.attempt?.status === 'failed';
    if (!own && (!terminal || record.sourceLedgerIntent?.active === true)) return;
    const producer = own ? record : await this.storage.get<PresentationRecord>(`${RECORD_KEY}:${jobId}`);
    if (producer === undefined || producer.admission.sourceFingerprint !== record.admission.sourceFingerprint || producer.admission.storageKey !== storageKey ||
      !this.ledgerObjectsMatch(producer, object, table)) return;
    const measured: SourceLedgerMeasurement = { etag: object!.etag, size: object!.size, sha256: await hashStoredObject(this.bucket, videoSourceLedgerKeyFor(storageKey)),
      table: { etag: table!.etag, size: table!.size, sha256: await hashStoredObject(this.bucket, videoSourceLedgerTableKeyFor(storageKey)) } };
    const [fresh, freshTable] = await this.ledgerObjects(storageKey);
    if (!this.ledgerObjectsMatch(producer, fresh, freshTable) || fresh!.etag !== measured.etag || fresh!.size !== measured.size ||
      freshTable!.etag !== measured.table.etag || freshTable!.size !== measured.table.size) return;
    if (!await this.commitLedger(producer, measured) || own) return;
    record.snapshot.sourceLedger = producer.snapshot.sourceLedger;
    await this.persist(record);
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
  async advance(identity: AcceptedVideoPresentationAttempt, proposed: VideoPresentation): Promise<PresentationSnapshot> {
    return this.gate(async () => {
      const current = await this.storage.get<PresentationRecord>(RECORD_KEY);
      if (current === undefined) return { presentation: null, attempt: null };
      const accepted = current.admission;
      if (identity.sourceFingerprint !== accepted.sourceFingerprint || identity.jobId !== accepted.jobId || identity.deadlineAt !== accepted.deadlineAt) return current.snapshot;
      const next = advanceVideoPresentation(current.snapshot.presentation, accepted, proposed);
      if (next === null || next === current.snapshot.presentation) return current.snapshot;
      if (accepted.original !== null && (accepted.original.width !== next.original.width || accepted.original.height !== next.original.height || accepted.original.duration !== next.original.duration)) return current.snapshot;
      const manifest = next.state === 'alpha_ready' ? await this.manifest(accepted, next, current.packedReceipt) : null;
      if (next.state === 'alpha_ready' && manifest === null) return current.snapshot;
      const previousAttempt = current.snapshot.attempt;
      const terminal = previousAttempt?.status === 'completed' || previousAttempt?.status === 'failed';
      const status = terminal ? previousAttempt.status : next.state === 'failed' ? 'failed' :
        accepted.limits?.sourceLedger === undefined && (next.state === 'native' || next.state === 'alpha_ready') ? 'completed' : 'running';
      const snapshot: PresentationSnapshot = { ...current.snapshot, presentation: next,
        ...(manifest === null ? {} : { manifest }), attempt: { jobId: accepted.jobId, deadlineAt: accepted.deadlineAt,
          ...previousAttempt, status, usage: previousAttempt?.usage ?? null, ...(next.state === 'failed' ? { error: next.error } : {}) },
      };
      if (!await this.writeDescriptor(current, next)) return current.snapshot;
      current.snapshot = snapshot;
      this.endPendingLedger(current);
      this.finalizeWork(current);
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
  async read(storageKey: string, sourceFingerprint: string): Promise<PresentationSnapshot> {
    return this.gate(async () => {
      const record = await this.storage.get<PresentationRecord>(RECORD_KEY);
      if (record?.admission.sourceFingerprint === sourceFingerprint) {
        if (record.snapshot.presentation !== null) {
          const stored = await this.bucket.get(videoPresentationKeyFor(storageKey));
          const descriptor = parseVideoPresentation(stored === null ? null : await stored.json().catch(() => null), sourceFingerprint);
          const original = record.snapshot.presentation.original;
          const presentationAttempt = record.snapshot.presentation.attempt;
          if (descriptor === null || descriptor.original.width !== original.width || descriptor.original.height !== original.height || descriptor.original.duration !== original.duration ||
            descriptor.attempt?.jobId !== presentationAttempt?.jobId || descriptor.attempt?.deadlineAt !== presentationAttempt?.deadlineAt) {
            const failed: VideoPresentation = { ...record.snapshot.presentation, state: 'failed', error: 'descriptor_invalid' };
            record.descriptorETag = stored?.etag ?? null;
            await this.writeDescriptor(record, failed);
            record.snapshot.presentation = failed;
            delete record.snapshot.manifest;
            if (record.snapshot.attempt !== null) record.snapshot.attempt = { ...record.snapshot.attempt, status: 'failed', error: 'descriptor_invalid' };
            this.endPendingLedger(record);
            await this.storage.put(RECORD_KEY, record);
            await this.refreshLedger(record);
            return record.snapshot;
          }
        }
        if (record.snapshot.presentation?.state === 'alpha_ready' && await this.manifest(record.admission, record.snapshot.presentation, record.packedReceipt) === null) {
          const failed: VideoPresentation = { ...record.snapshot.presentation, state: 'failed', error: 'presentation_missing' };
          await this.writeDescriptor(record, failed);
          record.snapshot = { ...record.snapshot, presentation: failed, attempt: record.snapshot.attempt === null ? null : {
            ...record.snapshot.attempt, status: 'failed', error: 'presentation_missing',
          } };
          delete record.snapshot.manifest;
          this.endPendingLedger(record);
          await this.storage.put(RECORD_KEY, record);
        }
        await this.refreshLedger(record);
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
   * @param receipt - The complete physical object actually published by this owner.
   * @returns Its validated manifest, or none when physical facts disagree.
   * @throws {Error} When R2 cannot be read.
   */
  private async manifest(admission: VideoPresentationAdmission, presentation: VideoPresentation, receipt?: AlphaPackedReceipt): Promise<AlphaManifest | null> {
    const object = await this.bucket.get(alphaManifestKeyFor(admission.storageKey));
    const packed = await this.bucket.head(alphaPackedKeyFor(admission.storageKey));
    if (object === null || packed === null || packed.size === 0 || packed.httpMetadata?.contentType !== 'video/mp4') return null;
    if (receipt !== undefined && (packed.etag !== receipt.etag || packed.size !== receipt.size)) return null;
    const parsed = alphaManifestSchema.safeParse(await object.json().catch(() => null));
    if (!parsed.success || !alphaManifestMatchesPresentation(parsed.data, presentation)) return null;
    if (admission.packedURL !== undefined && parsed.data.packedURL !== admission.packedURL) return null;
    if (admission.manifestURL !== undefined && presentation.alpha?.manifestURL !== admission.manifestURL) return null;
    return parsed.data;
  }
}
