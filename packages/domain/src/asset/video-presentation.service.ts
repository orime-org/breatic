// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { VideoPresentationAttempt, VideoPresentationResponse } from '@breatic/shared';

/** An authorized read of a canonical registered video. */
export interface ResolveVideoPresentationInput { projectId: string; userId: string; canonicalURL: string }
/** An explicit repair retains the press identity across delivery retries. */
export interface RepairVideoPresentationInput extends ResolveVideoPresentationInput { sourceFingerprint: string; requestId: string }
/** An automatic registration or first-read metadata preparation. */
export interface EnsureVideoPresentationInput { assetId: string; parentDeadlineAt?: number; knownAlpha?: boolean }
/** Repair answers the current canonical identity and the fixed accepted work. */
export interface VideoPresentationRepairResponse extends VideoPresentationResponse { attempt: VideoPresentationAttempt | null }

/**
 * Resolve project-authorized registry and presentation truth.
 * @param input - Current project member and selected canonical address.
 * @returns Registered identity with nullable trusted presentation.
 * @throws {Error} Until the independently specified implementation replaces this RED stub.
 */
export async function resolveVideoPresentation(input: ResolveVideoPresentationInput): Promise<VideoPresentationResponse> {
  void input;
  throw new Error('Video presentation resolver is not implemented');
}

/**
 * Repair an unchanged registered source under read permission.
 * @param input - Member, canonical identity and idempotent press identity.
 * @returns Current source and accepted repair identity.
 * @throws {Error} Until the independently specified implementation replaces this RED stub.
 */
export async function repairVideoPresentation(input: RepairVideoPresentationInput): Promise<VideoPresentationRepairResponse> {
  void input;
  throw new Error('Video presentation repair is not implemented');
}

/**
 * Arrange platform-funded presentation work after registration.
 * @param input - Registered winner and any parent run's original deadline.
 * @returns The accepted work, or none for a gone or non-video asset.
 * @throws {Error} Until the independently specified implementation replaces this RED stub.
 */
export async function ensureVideoPresentation(input: EnsureVideoPresentationInput): Promise<VideoPresentationAttempt | null> {
  void input;
  throw new Error('Video presentation preparation is not implemented');
}
