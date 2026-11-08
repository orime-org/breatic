// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { VideoPresentation, VideoPresentationRect, VideoPresentationProcessLimits } from '@shared/upload/video-presentation-types.js';

/** One synchronous container request remains active through cleanup and reporting. */
export const ALPHA_RUN_PATH = '/alpha';
/** Fixed source identity and resource limits, with no backend addresses or credentials. */
export interface AlphaRunBody {
  jobId: string;
  sourceFingerprint: string;
  deadlineAt: number;
  token: string;
  sourceURL: string;
  outputURL: string;
  reportURL: string;
  ledgerOnly?: boolean;
  sourceLedgerOutputURL?: string;
  limits: VideoPresentationProcessLimits;
  vcpu: number;
}
/** Curated provenance is stored in our format instead of a vendor configuration. */
export interface AlphaProbeEvidence {
  codecName: string;
  pixelFormat: string;
  pixelAlpha: 0 | 1;
  alphaMode: string | null;
  formatName: string;
  videoStreamIndex: number;
}
/** Trusted source and actual encoding facts, reported under the accepted identity. */
export type AlphaPresentationReport = {
  jobId: string; sourceFingerprint: string; deadlineAt: number; token: string;
} & (
  | { kind: 'probe'; classification: 'confirmed_alpha' | 'confirmed_opaque'; original: VideoPresentation['original']; evidence: AlphaProbeEvidence }
  | { kind: 'encoded'; packedWidth: number; packedHeight: number; colorRect: VideoPresentationRect; alphaRect: VideoPresentationRect }
  | { kind: 'finished'; usage: { wallMs: number; cpuUsec: number | null }; error?: string }
  | { kind: 'source_ledger_failed'; error: string }
);
/** The HTTP result acknowledges work; storage readiness comes from its durable owner. */
export interface AlphaRunResult { ok: boolean; error?: string }
