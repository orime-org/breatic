// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Web-animation fixtures for the web Timeline tests (inner#1711 S8): copies bound to a source version or to an
 * execution, and the `TimelineWebResolution` that `GET /timeline/web-sources` answers for them (design §3.2).
 */

import type {
  TimelineEditCommand, TimelineEditPlacement,
} from '@web/data/yjs/timeline-edit';
import type { TimelineWebAnimationClip, TimelineWebAnimationContentBinding, TimelineWebResolution } from '@breatic/shared';

import { FPS } from '@web/data/yjs/__tests__/timeline-document-fixtures';

/** A succeeded source version, 48 frames at the document's 24 fps. */
export const SRC_A = '80000000-0000-4000-8000-000000000001';
/** The result of `EXEC_DONE`, 96 frames. */
export const SRC_B = '80000000-0000-4000-8000-000000000002';
/** A source version the resolution does not return. */
export const SRC_GONE = '80000000-0000-4000-8000-0000000000ff';

/** Running, accepted for 72 frames. */
export const EXEC_RUNNING = '90000000-0000-4000-8000-000000000001';
/** Succeeded with `SRC_B`. */
export const EXEC_DONE = '90000000-0000-4000-8000-000000000002';
/** Failed, accepted for 48 frames. */
export const EXEC_FAILED = '90000000-0000-4000-8000-000000000003';
/** Cancelled, accepted for 24 frames. */
export const EXEC_CANCELLED = '90000000-0000-4000-8000-000000000004';
/** Expired, accepted for 24 frames. */
export const EXEC_EXPIRED = '90000000-0000-4000-8000-000000000005';
/** An execution the resolution does not return. */
export const EXEC_GONE = '90000000-0000-4000-8000-0000000000ff';

/** The Motion Space the fixtures' executions were made in. */
export const MOTION_SPACE = 'a0000000-0000-4000-8000-0000000000aa';
/** Made `SRC_A`: a create. */
export const EXEC_A = '90000000-0000-4000-8000-0000000000a1';

/** What `GET /timeline/web-sources` answers for every reference above except the `_GONE` ones. */
export const RESOLUTION: TimelineWebResolution = {
  sources: {
    [SRC_A]: {
      durationFrames: 48, fps: FPS, viewport: { width: 1920, height: 1080 },
      executionId: EXEC_A, spaceId: MOTION_SPACE, origin: 'web_animation_space', kind: 'web_animation_create', request: 'Gold dot along an arc',
    },
    [SRC_B]: {
      durationFrames: 96, fps: FPS, viewport: { width: 1080, height: 1920 },
      executionId: EXEC_DONE, spaceId: MOTION_SPACE, origin: 'web_animation_space', kind: 'web_animation_modify', request: 'Slower',
      base: { executionId: EXEC_A, request: 'Gold dot along an arc' },
    },
  },
  executions: {
    [EXEC_RUNNING]: {
      status: 'running', resultSourceVersionId: null, acceptedDurationFrames: 72, fps: FPS,
      executionId: EXEC_RUNNING, spaceId: MOTION_SPACE, origin: 'web_animation_space', kind: 'web_animation_create', request: 'Brand name fades in', phase: 'writing', failureReason: null,
    },
    [EXEC_DONE]: {
      status: 'succeeded', resultSourceVersionId: SRC_B, acceptedDurationFrames: 96, fps: FPS,
      executionId: EXEC_DONE, spaceId: MOTION_SPACE, origin: 'web_animation_space', kind: 'web_animation_modify', request: 'Slower', phase: null, failureReason: null,
      base: { executionId: EXEC_A, request: 'Gold dot along an arc' },
    },
    [EXEC_FAILED]: {
      status: 'failed', resultSourceVersionId: null, acceptedDurationFrames: 48, fps: FPS,
      executionId: EXEC_FAILED, spaceId: MOTION_SPACE, origin: 'web_animation_space', kind: 'web_animation_create', request: 'A carousel of three products', phase: null, failureReason: 'harness_failed',
    },
    [EXEC_CANCELLED]: {
      status: 'cancelled', resultSourceVersionId: null, acceptedDurationFrames: 24, fps: FPS,
      executionId: EXEC_CANCELLED, spaceId: MOTION_SPACE, origin: 'web_animation_space', kind: 'web_animation_create', request: 'Cancelled request', phase: null, failureReason: null,
    },
    [EXEC_EXPIRED]: {
      status: 'expired', resultSourceVersionId: null, acceptedDurationFrames: 24, fps: FPS,
      executionId: EXEC_EXPIRED, spaceId: MOTION_SPACE, origin: 'web_animation_space', kind: 'web_animation_create', request: 'Expired request', phase: null, failureReason: null,
    },
  },
};

/** A resolution that knows nothing. */
export const EMPTY_RESOLUTION: TimelineWebResolution = { sources: {}, executions: {} };

/**
 * A binding to a succeeded source version.
 * @param sourceVersionId - The source version.
 * @returns The binding.
 * @throws {never} Never.
 */
export function boundTo(sourceVersionId: string): TimelineWebAnimationContentBinding {
  return { baseSourceResultId: sourceVersionId, operationId: null };
}

/**
 * A placeholder binding to an execution.
 * @param executionId - The execution.
 * @returns The binding.
 * @throws {never} Never.
 */
export function waitingFor(executionId: string): TimelineWebAnimationContentBinding {
  return { baseSourceResultId: null, operationId: executionId };
}

/**
 * A default web-animation copy.
 * @param id - The clip id.
 * @param trackId - Its visual track.
 * @param startFrame - Its timeline start.
 * @param durationFrames - Its length.
 * @param contentBinding - What it shows.
 * @param fields - Overrides such as `sourceInFrame` or `rate`.
 * @returns A schema-valid web-animation clip.
 * @throws {never} Never.
 */
export function webClip(
  id: string, trackId: string, startFrame: number, durationFrames: number,
  contentBinding: TimelineWebAnimationContentBinding = boundTo(SRC_A), fields: Partial<TimelineWebAnimationClip> = {},
): TimelineWebAnimationClip {
  return {
    id,
    trackId,
    kind: 'web-animation',
    contentBinding,
    startFrame,
    sourceInFrame: 0,
    durationFrames,
    rate: { num: 1, den: 1 },
    gain: 1,
    mute: false,
    transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    ...fields,
  };
}

/**
 * Add a succeeded result as a new copy.
 * @param clipId - The new copy's id.
 * @param sourceVersionId - The result.
 * @param startFrame - Where it starts.
 * @param newTrackId - The id a new top track would take.
 * @param placement - The editing user's switches.
 * @param durationFrames - The result's length, as the execution list row says.
 * @returns The command.
 * @throws {never} Never.
 */
export function addResult(
  clipId: string, sourceVersionId: string, startFrame: number, newTrackId: string, placement: TimelineEditPlacement, durationFrames = 48,
): TimelineEditCommand {
  return {
    operation: 'add_web_animation',
    parameters: { clipId, from: { sourceVersionId }, startFrame, newTrackId, extent: { durationFrames, fps: FPS } },
    placement,
  } as TimelineEditCommand;
}
