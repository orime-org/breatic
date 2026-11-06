// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A registered source's selected presentation version as ingest answers it after
 * S6c and E3 (inner#1306 test plan §90 E3b): the S6c snapshot, the selected
 * bundle, and the full ledger (with its §3.2 item 7 encode facts) and compact
 * stored at the receipt's URLs. Every value is deterministic for a given source
 * hash and key, so golden plans that embed the receipt can be hashed
 * independently. 1011 frames of 1/200 s give a display duration of exactly
 * 5.055 s, the registered duration of the removal fixtures.
 */

import { createHash } from "node:crypto";
import * as shared from "@breatic/shared";

/** One input's tool-input reference (§7.13). */
export interface ToolInputRef { toolInputId: string; planSha256: string }
/** The selected version's stored objects and the snapshot that names them. */
export interface PresentedSource {
  presentationRef: { source: ToolInputRef };
  versionId: string;
  receipt: Record<string, unknown> & { url: string; size: number; table: Record<string, unknown> & { url: string; size: number } };
  full: Record<string, unknown>;
  compact: Record<string, unknown>;
  bundle: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  /** Stored bodies by public URL. */
  bodies: Map<string, string>;
}

const rational = (numerator: number, denominator = 1): { numerator: string; denominator: string } => ({ numerator: String(numerator), denominator: String(denominator) });

export const REMOVAL_TABLE = { schemaVersion: 1, timescale: 200, runs: [{ start: 0, count: 1011, step: 1, duration: 1 }] };
export const REMOVAL_PLAN = {
  display: { width: 960, height: 540, duration: rational(1011, 200) }, colorMatrix: "bt601", source: { transfer: null, bitDepth: 8 },
  output: { toneMap: "none", framePngBitDepth: 8 }, policy: { singleFrameDurationMs: 5000, emptyFill: "black" }, presentation: REMOVAL_TABLE,
  originMapping: { timeBase: rational(1, 1000), origin: rational(0), entries: [{ kind: "source", start: 0, count: 1011, step: 5 }],
    firstSource: { supportStart: rational(0), lead: null }, lastSource: { support: "declared", supportEnd: rational(1011, 200), hold: null } },
  videoSpans: null, audioSpans: null, segmentDuration: null,
};
// §93 D6-1 (design §3.2 item 7): every source keyframe's pts and dts and the first packet dts; the removal source has no
// B-frames, so dts equals pts (frame k is at k/200 s) and nothing is shifted.
export const REMOVAL_ENCODING = { keyframeOrdinals: [0, 250, 500, 750, 1000], codedWidth: 960, codedHeight: 540,
  sourceKeyframes: [rational(0), rational(5, 4), rational(5, 2), rational(15, 4), rational(5)].map((time) => ({ pts: time, dts: time })), firstPacketDts: rational(0) };
export const REMOVAL_VERSION_ID = "e".repeat(64);
export const REMOVAL_ATTEMPT = { jobId: "video-presentation:removal-source", deadlineAt: 1900000000000 };

/**
 * The full and compact ledger keys of one toolInputId (S6e E4-7: stored per toolInputId, design §5.1 step 5).
 * @param sourceKey - The registered storage key.
 * @param toolInputId - The ledger instance.
 * @returns Both keys.
 * @throws {never} Never.
 */
export function ledgerKeys(sourceKey: string, toolInputId: string): { full: string; table: string } {
  return { full: shared.videoSourceLedgerKeyFor(sourceKey, toolInputId), table: shared.videoSourceLedgerTableKeyFor(sourceKey, toolInputId) };
}

/**
 * Lowercase SHA-256 of a string's UTF-8 bytes.
 * @param text - The text.
 * @returns The digest.
 */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The selected version of one registered source.
 * @param hash - The registered content hash.
 * @param sourceKey - The registered storage key.
 * @param publicUrl - The storage's public URL function.
 * @param presented - The selected plan and its encode facts; the removal source's by default.
 * @param presented.plan - The plan.
 * @param presented.encoding - Its encode facts.
 * @returns Its stored objects and snapshot.
 * @throws {Error} When the shared identity functions are missing.
 */
export async function presentedSource(hash: string, sourceKey: string, publicUrl: (key: string) => string,
  presented: { plan: typeof REMOVAL_PLAN; encoding: typeof REMOVAL_ENCODING } = { plan: REMOVAL_PLAN, encoding: REMOVAL_ENCODING }): Promise<PresentedSource> {
  const { plan, encoding } = presented;
  const api = shared as unknown as Record<string, (value: unknown) => Promise<string>>;
  const planSha256 = await api.videoPresentationPlanSha256!(plan);
  const toolInputId = await api.videoPresentationToolInputId!({ sourceFingerprint: hash, planSha256 });
  const full = { schemaVersion: 2, sourceFingerprint: hash, toolInputId, planSha256, attempt: REMOVAL_ATTEMPT, plan, encoding };
  const compact = { sourceFingerprint: hash, toolInputId, planSha256, presentation: REMOVAL_TABLE };
  const fullJSON = JSON.stringify(full); const compactJSON = JSON.stringify(compact);
  const receipt: PresentedSource["receipt"] = { schemaVersion: 2, sourceFingerprint: hash, toolInputId, planSha256, producerVersion: 2, attempt: REMOVAL_ATTEMPT,
    url: publicUrl(ledgerKeys(sourceKey, toolInputId).full), etag: "full-etag", size: Buffer.byteLength(fullJSON), sha256: sha256(fullJSON), contentType: "application/json",
    table: { url: publicUrl(ledgerKeys(sourceKey, toolInputId).table), sha256: sha256(compactJSON), size: Buffer.byteLength(compactJSON), contentType: "application/json", frameCount: 1011 } };
  const bundle = { schemaVersion: 1, sourceFingerprint: hash, versionId: REMOVAL_VERSION_ID, toolInputId, planSha256, policyVersion: 1, producerVersion: 2, profileVersion: 1,
    original: { width: plan.display.width, height: plan.display.height, duration: 5.055 }, display: plan.display,
    playback: { kind: "native", carrier: { storageKey: sourceKey, url: publicUrl(sourceKey), etag: "source-etag", size: 4096, sha256: hash, contentType: "video/mp4" }, displayRect: null },
    playbackClock: REMOVAL_TABLE };
  const snapshot = { sourceBinding: { storageKey: sourceKey, sourceFingerprint: hash }, presentation: bundle, preparation: null, ledger: { state: "ready", receipt, failure: null }, readmit: false };
  return { presentationRef: { source: { toolInputId, planSha256 } }, versionId: REMOVAL_VERSION_ID, receipt, full, compact, bundle, snapshot,
    bodies: new Map([[receipt.url, fullJSON], [receipt.table.url, compactJSON]]) };
}
