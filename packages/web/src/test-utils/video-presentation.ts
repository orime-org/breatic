// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Wire fixtures of the presentation read (frames-split design §3.5 web→server row, §7.12; inner#1306 test plan §69): the
 * response carries the selected bundle with its grid and tool source, and the target policy's preparation; a repair answers
 * the same response. Every builder returns a value `videoPresentationResponseSchema` admits.
 */
import type { QueryClient } from '@tanstack/react-query';
import { videoPresentationAwaitsServer, type VideoPresentationResponse } from '@breatic/shared';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';

type Bundle = NonNullable<VideoPresentationResponse['presentation']>;
type Preparation = NonNullable<VideoPresentationResponse['preparation']>;

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
 * A grid display of the given size and frame count at 25 fps, every slot a real frame.
 * @param width - Display width.
 * @param height - Display height.
 * @param frameCount - Grid frames.
 * @returns The display.
 * @throws {never} Never.
 */
export function presentedDisplay(width = 96, height = 64, frameCount = 75): Bundle['display'] {
  return { width, height, fps: { numerator: 25, denominator: 1 }, frameCount, gridStart: { numerator: 0, denominator: 1 }, realFrameCount: frameCount, leadFrames: 0, holdFrames: 0 };
}

/**
 * A selected native bundle whose carrier is the source itself, on a 25 fps grid; tools read the original.
 * @param canonicalURL - The source URL, also the carrier.
 * @param fields - Fields to replace (fingerprint, toolInputId, versionId, original, display, playback).
 * @returns The bundle.
 * @throws {never} Never.
 */
export function presentedBundle(canonicalURL: string, fields: Partial<Bundle> = {}): Bundle {
  const display = fields.display ?? presentedDisplay();
  return {
    schemaVersion: 1, sourceFingerprint: PRESENTED.fingerprint, versionId: PRESENTED.versionId, toolInputId: PRESENTED.toolInputId, planSha256: PRESENTED.planSha256,
    policyVersion: 1, producerVersion: '2'.repeat(64), profileVersion: '1'.repeat(64),
    original: { width: display.width, height: display.height, duration: display.frameCount * display.fps.denominator / display.fps.numerator }, display,
    plan: { gridRulesVersion: 1, grid: { fps: display.fps, gridStart: display.gridStart, leadFrames: display.leadFrames, gridEnd: null, singleFrameDurationMs: 5000 },
      toolSource: 'original', audioTrack: null, display: { width: display.width, height: display.height }, color: { matrix: 'bt709', toneMap: 'none' }, framePngBitDepth: 8 },
    playback: { kind: 'native', carrier: { storageKey: new URL(canonicalURL).pathname.slice(1), url: canonicalURL, etag: '"carrier"', size: 4096, sha256: PRESENTED.fingerprint, contentType: 'video/mp4' }, displayRect: null },
    toolSource: { edit: null, keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 2, allKeyframes: false }, sourceDecodeKey: 'sdr_8bit' },
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
 * A complete presentation response; `pollAfterMs` follows the shared rule (`videoPresentationAwaitsServer`).
 * @param sourceBinding - The binding.
 * @param fields - The selected bundle and the preparation, each null when absent.
 * @param pollAfterMs - The interval while the reader waits on server work.
 * @returns The response.
 * @throws {never} Never.
 */
export function presentedResponse(sourceBinding: VideoPresentationResponse['sourceBinding'],
  fields: Partial<Pick<VideoPresentationResponse, 'presentation' | 'preparation' | 'coverURL'>> = {}, pollAfterMs = 5000): VideoPresentationResponse {
  const value = { presentation: null, preparation: null, coverURL: null, ...fields };
  return { sourceBinding, ...value, pollAfterMs: videoPresentationAwaitsServer(value) ? pollAfterMs : null };
}

/**
 * Puts a usable source in a query cache: a read with a selected bundle on its grid.
 * @param client - The cache.
 * @param projectId - The Project.
 * @param canonicalURL - The source URL.
 * @param fields - Bundle fields to replace (toolInputId, planSha256, display).
 * @returns The seeded read.
 * @throws {never} Never.
 */
export function seedUsablePresentation(client: QueryClient, projectId: string, canonicalURL: string, fields: Partial<Bundle> = {}): VideoPresentationResponse {
  const response = presentedResponse(presentedBinding(canonicalURL), { presentation: presentedBundle(canonicalURL, fields) });
  client.setQueryData(videoPresentationQuery({ projectId, canonicalURL, active: true }).queryKey, response);
  return response;
}
