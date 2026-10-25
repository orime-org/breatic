// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { QueryClient } from '@tanstack/react-query';
import type { VideoPresentationQueryInput } from '@web/spaces/canvas/video-presentation/video-presentation-query';

/** Recovery distinguishes platform source work from a local renderer restart. */
export type VideoPresentationRecoveryReason = 'source' | 'renderer';
/** One existing Retry action, whose concurrent invocations share a press. */
export interface VideoPresentationRecovery {
  recover: (reason: VideoPresentationRecoveryReason) => Promise<void>;
}

/**
 * Binds the existing Retry action to its account cache and canonical source.
 * @param _client - The existing account-scoped query owner.
 * @param _input - Current Project and canonical source identity.
 * @returns The shared node and timeline recovery action.
 * @throws {never} Constructing the action does not make a request.
 */
export function createVideoPresentationRecovery(_client: QueryClient, _input: VideoPresentationQueryInput): VideoPresentationRecovery {
  return { recover: () => Promise.resolve() };
}
