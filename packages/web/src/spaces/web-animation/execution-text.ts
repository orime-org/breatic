// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How a web-animation execution is told, shared by the Motion Space's list and details and the Timeline's copies: the
 * sentence a failure reason reads as, the steps a run goes through, and where a run stands on each.
 */

import type { TimelineExecutionStatus } from '@breatic/shared';
import type { WebAnimationRowView } from '@breatic/shared/space-content';

/** The engines a user picks from, with their display names. */
export const WEB_ANIMATION_ENGINE_NAMES = { deepseek: 'DeepSeek' } as const satisfies Readonly<Record<string, string>>;

/** An engine a user picks. */
export type WebAnimationEngine = keyof typeof WEB_ANIMATION_ENGINE_NAMES;

/** The engine a new dialog starts on. */
export const DEFAULT_WEB_ANIMATION_ENGINE: WebAnimationEngine = 'deepseek';

/**
 * Whether a picked value names an engine.
 * @param value - The value.
 * @returns True for an engine.
 * @throws {never} Never.
 */
export function isWebAnimationEngine(value: string): value is WebAnimationEngine {
  return Object.hasOwn(WEB_ANIMATION_ENGINE_NAMES, value);
}

/** The phases a create or modify reports, in order. */
const CREATION_PHASES = ['writing', 'validating', 'saving'] as const;
/** The phases an export reports, in order. */
const EXPORT_PHASES = ['rendering', 'saving'] as const;

// The sentence each failure reason is told with; a reason not listed reads as a general failure.
const FAILURE_SENTENCE: Readonly<Record<string, 'feature_disabled' | 'check' | 'stopped' | 'render' | 'frameMismatch' | 'saveVideo'>> = {
  feature_disabled: 'feature_disabled',
  validation_failed: 'check', font_not_in_set: 'check', manifest_invalid: 'check', package_too_large: 'check', output_missing: 'check',
  viewport_mismatch: 'check', fps_mismatch: 'check', duration_mismatch: 'check', font_set_mismatch: 'check',
  harness_failed: 'stopped', container_failed: 'stopped', internal: 'stopped', base_unavailable: 'stopped',
  // Only an export reports these three (design §6.5).
  render_failed: 'render', frame_mismatch: 'frameMismatch', save_failed: 'saveVideo',
};

/**
 * The message a failure reason is told with.
 * @param reason - The stored reason, or null.
 * @returns The catalog key.
 * @throws {never} Never.
 */
export function failureSentenceKey(reason: string | null): string {
  return `timeline.webAnimation.failure.${(reason !== null && FAILURE_SENTENCE[reason]) || 'unknown'}`;
}

/**
 * The message an ended run that did not succeed is told with: its failure reason when it failed, otherwise its status
 * (cancelled, expired).
 * @param status - The run's status.
 * @param reason - Its stored failure reason, or null.
 * @returns The catalog key.
 * @throws {never} Never.
 */
export function endedSentenceKey(status: TimelineExecutionStatus, reason: string | null): string {
  return status === 'failed' ? failureSentenceKey(reason) : `timeline.webAnimation.status.${status}`;
}

/**
 * The catalog keys of a run's steps: saving the request, then the phases of its kind.
 * @param kind - The execution's kind.
 * @returns The keys, in order.
 * @throws {never} Never.
 */
export function executionStepKeys(kind: WebAnimationRowView['kind']): string[] {
  const phases = kind === 'web_animation_export' ? EXPORT_PHASES : CREATION_PHASES;
  return ['timeline.webAnimation.step.landing', ...phases.map((phase) => phaseKey(kind, phase))];
}

/**
 * The catalog key a reported phase is told with: an export saves its video, a creation its source.
 * @param kind - The execution's kind.
 * @param phase - The phase.
 * @returns The key.
 * @throws {never} Never.
 */
export function phaseKey(kind: WebAnimationRowView['kind'], phase: NonNullable<WebAnimationRowView['phase']>): string {
  return kind === 'web_animation_export' && phase === 'saving' ? 'timeline.webAnimation.step.savingVideo' : `timeline.webAnimation.phase.${phase}`;
}

/**
 * Where a step stands: done, running now, where a run that did not succeed stopped, or not reached. A running row that
 * has reported no phase yet is on its first phase.
 * @param row - The execution.
 * @param index - The step: 0 is saving the request, then the phases.
 * @returns Its mark.
 * @throws {never} Never.
 */
export function stepMark(row: Pick<WebAnimationRowView, 'kind' | 'status' | 'phase'>, index: number): 'done' | 'current' | 'stopped' | 'pending' {
  if (row.status === 'succeeded') return 'done';
  if (index === 0) return row.status === 'awaiting_landing' ? 'current' : 'done';
  const phases: readonly string[] = row.kind === 'web_animation_export' ? EXPORT_PHASES : CREATION_PHASES;
  const stopped = row.status === 'failed' || row.status === 'cancelled' || row.status === 'expired';
  const reached = row.phase === null ? (row.status === 'running' || stopped ? 0 : -1) : phases.indexOf(row.phase);
  if (index - 1 < reached) return 'done';
  if (index - 1 > reached) return 'pending';
  return row.status === 'running' ? 'current' : stopped ? 'stopped' : 'pending';
}

/**
 * The run-once intent of cancelling one execution, which its button reads.
 * @param executionId - The execution.
 * @returns The intent.
 * @throws {never} Never.
 */
export function cancelIntent(executionId: string): string {
  return `web-animation-cancel:${executionId}`;
}

/**
 * The run-once intent of exporting one source version from one Motion Space, which Export and Re-export read; a
 * second press while it waits joins the first.
 * @param spaceId - The Motion Space.
 * @param sourceVersionId - The source version rendered.
 * @returns The intent.
 * @throws {never} Never.
 */
export function exportIntent(spaceId: string, sourceVersionId: string): string {
  return `web-animation-export:${spaceId}:${sourceVersionId}`;
}
