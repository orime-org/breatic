// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire fixtures of the presentation read (frames-split design §3.5 web→server row, §7.12; inner#1306 test plan §95):
 * the response carries the selected bundle, the target policy's preparation and the selected version's ledger, and a
 * repair answers the same response. Every builder returns a value `videoPresentationResponseSchema` admits.
 */
import type { QueryClient } from '@tanstack/react-query';
import { videoPresentationAwaitsServer, type VideoPresentationResponse } from '@breatic/shared';
import type { VideoPresentationTable } from '@breatic/shared/mini-tools';
import { sourceLedgerQuery } from '@web/spaces/canvas/video-presentation/source-ledger-query';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';

type Bundle = NonNullable<VideoPresentationResponse['presentation']>;
type Preparation = NonNullable<VideoPresentationResponse['preparation']>;
type Ledger = NonNullable<VideoPresentationResponse['ledger']>;

/** The fixed identities one source's fixtures share. */
export const PRESENTED = {
  assetId: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', fingerprint: 'a'.repeat(64), toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64),
  versionId: 'e'.repeat(64), jobId: 'video-presentation:fixture', deadlineAt: 1900000000000,
} as const;

/**
 * The registered source binding.
 * @param canonicalURL - The source URL.
 * @param mediaInfo - Its registered measurement; unknown fields are null.
 * @param fingerprint - Its content hash.
 * @returns The binding.
 * @throws {never} Never.
 */
export function presentedBinding(canonicalURL: string, mediaInfo: VideoPresentationResponse['sourceBinding']['mediaInfo'] = { width: null, height: null, duration: null, mimeType: 'video/webm' },
  fingerprint: string = PRESENTED.fingerprint): VideoPresentationResponse['sourceBinding'] {
  return { assetId: PRESENTED.assetId, contentHash: fingerprint, canonicalURL, kind: 'video', mediaInfo };
}

/**
 * A selected native bundle whose carrier is the source itself, one frame per 1/25 s.
 * @param canonicalURL - The source URL, also the carrier.
 * @param fields - Fields to replace (fingerprint, toolInputId, versionId, original, display).
 * @returns The bundle.
 * @throws {never} Never.
 */
export function presentedBundle(canonicalURL: string, fields: Partial<Bundle> = {}): Bundle {
  const display = fields.display ?? { width: 96, height: 64, duration: { numerator: '3', denominator: '1' } };
  const frames = Number(display.duration.numerator) * 25 / Number(display.duration.denominator);
  return {
    schemaVersion: 1, sourceFingerprint: PRESENTED.fingerprint, versionId: PRESENTED.versionId, toolInputId: PRESENTED.toolInputId, planSha256: PRESENTED.planSha256,
    policyVersion: 1, producerVersion: 2, profileVersion: 1, original: { width: display.width, height: display.height, duration: frames / 25 }, display,
    playback: { kind: 'native', carrier: { storageKey: new URL(canonicalURL).pathname.slice(1), url: canonicalURL, etag: '"carrier"', size: 4096, sha256: PRESENTED.fingerprint, contentType: 'video/mp4' }, displayRect: null },
    playbackClock: { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: frames, step: 1, duration: 1 }] },
    ...fields,
  };
}

/**
 * The target policy's preparation.
 * @param failure - Its failure code, null while it has not failed.
 * @param stage - Its real stage.
 * @returns The preparation.
 * @throws {never} Never.
 */
export function presentedPreparation(failure: string | null, stage: Preparation['stage'] = failure === null ? 'plan' : null): Preparation {
  return { targetPolicyVersion: 1, jobId: PRESENTED.jobId, stage, failure };
}

/**
 * A ready ledger for a bundle, its compact table beside the full ledger.
 * @param bundle - The selected bundle.
 * @param frameCount - The compact table's frames.
 * @returns The ledger.
 * @throws {never} Never.
 */
export function readyLedger(bundle: Bundle, frameCount = 75): Ledger {
  const base = bundle.playback.carrier.url;
  return { state: 'ready', failure: null, receipt: {
    schemaVersion: 2, sourceFingerprint: bundle.sourceFingerprint, toolInputId: bundle.toolInputId, planSha256: bundle.planSha256, producerVersion: 2,
    attempt: { jobId: PRESENTED.jobId, deadlineAt: PRESENTED.deadlineAt }, url: `${base}.full.json`, etag: '"full"', size: 1000, sha256: 'b'.repeat(64),
    contentType: 'application/json', table: { url: `${base}.compact.json`, sha256: 'c'.repeat(64), size: 100, contentType: 'application/json', frameCount },
  } };
}

/**
 * A complete presentation response; `pollAfterMs` follows the shared rule (`videoPresentationAwaitsServer`).
 * @param sourceBinding - The binding.
 * @param fields - The selected bundle, the preparation and the ledger, each null when absent.
 * @param pollAfterMs - The interval while the reader waits on server work.
 * @returns The response.
 * @throws {never} Never.
 */
export function presentedResponse(sourceBinding: VideoPresentationResponse['sourceBinding'],
  fields: Partial<Pick<VideoPresentationResponse, 'presentation' | 'preparation' | 'ledger' | 'sourceLedgerReadLimits'>> = {}, pollAfterMs = 5000): VideoPresentationResponse {
  const value = { presentation: null, preparation: null, ledger: null, ...fields };
  return { sourceBinding, ...value, pollAfterMs: videoPresentationAwaitsServer(value) ? pollAfterMs : null };
}

/**
 * Puts a usable source in a query cache: a read with a selected bundle and a ready ledger, and its compact table read.
 * @param client - The cache.
 * @param projectId - The Project.
 * @param canonicalURL - The source URL.
 * @param fields - Bundle fields to replace (toolInputId, planSha256).
 * @returns The seeded read.
 * @throws {never} Never.
 */
export function seedUsablePresentation(client: QueryClient, projectId: string, canonicalURL: string, fields: Partial<Bundle> = {}): VideoPresentationResponse {
  const bundle = presentedBundle(canonicalURL, fields);
  const response = presentedResponse(presentedBinding(canonicalURL), { presentation: bundle, ledger: readyLedger(bundle), sourceLedgerReadLimits: { maxBytes: 16777216 } });
  const table: VideoPresentationTable = { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 75, step: 1, duration: 1 }] };
  client.setQueryData(videoPresentationQuery({ projectId, canonicalURL, active: true }).queryKey, response);
  client.setQueryData(sourceLedgerQuery({ projectId, response, active: true }).queryKey, table);
  return response;
}
