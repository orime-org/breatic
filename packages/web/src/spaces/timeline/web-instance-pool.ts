// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web preview instance pool (inner#1711 design §7.4): which loaded page shows which web copy. A copy visible at
 * the current frame gets an instance that the playback drives; a copy first visible within the premount lead gets one
 * that loads hidden and stops at that frame; an instance no copy uses stays loaded, idle, up to a cap. Keys are
 * `sourceVersionId:n`, with n counting up per source version for the life of the pool and never reused.
 */

import type { TimelineDocumentV1, TimelineWebAnimationClip } from '@breatic/shared';
import { nextTimelinePlaybackBoundary, visibleTimelineClipsAt } from '@web/data/yjs/timeline-layers';

/** What an instance does: drives a visible copy, loads hidden ahead of one, or waits unused. */
export type WebInstanceRole = 'visible' | 'premount' | 'idle';

/** One instance the pool holds and the copy it serves. */
export interface WebInstanceAssignment {
  key: string;
  sourceVersionId: string;
  role: WebInstanceRole;
  /** The copy it serves; null while idle. */
  clipId: string | null;
  /** A premounted copy's first visible frame; null otherwise. */
  targetFrame: number | null;
}

/** The pool after an allocation. */
export interface WebInstancePool {
  /** Every instance held, visible ones bottom-up first, then premounted ones, then idle ones earliest first. */
  assignments: readonly WebInstanceAssignment[];
  /** The copy each instance last served, so an idle instance keeps showing its last copy's page. */
  lastClips: Readonly<Record<string, TimelineWebAnimationClip>>;
  /** The next ordinal per source version. */
  ordinals: Readonly<Record<string, number>>;
}

/** What one allocation reads. */
export interface WebInstanceAllocationInput {
  document: TimelineDocumentV1;
  readyClipIds: ReadonlySet<string>;
  frame: number;
  /** The premount lead in Timeline frames; 0 premounts nothing. */
  premountFrames: number;
  /** How many idle instances are kept before the earliest idled is unloaded. */
  idleInstancesMax: number;
  /** A copy's resolved source version; null for a placeholder, which gets no instance. */
  sourceOf: (clip: TimelineWebAnimationClip) => string | null;
  /** The instances the host failed; they are unloaded rather than idled once their copy leaves. */
  failedKeys: ReadonlySet<string>;
}

/** The pool of a freshly opened Timeline. */
export const EMPTY_WEB_INSTANCE_POOL: WebInstancePool = { assignments: [], lastClips: {}, ordinals: {} };

/** A copy that wants an instance in this allocation. */
interface Want { clip: TimelineWebAnimationClip; source: string; role: 'visible' | 'premount'; targetFrame: number | null }

/**
 * The resolved web copies visible at a frame, bottom-up.
 * @param input - The allocation input.
 * @param frame - The frame.
 * @returns The copies with their sources.
 * @throws {never} Never.
 */
function webCopiesAt(input: WebInstanceAllocationInput, frame: number): Array<{ clip: TimelineWebAnimationClip; source: string }> {
  return visibleTimelineClipsAt(input.document, input.readyClipIds, frame).flatMap((clip) => {
    if (clip.kind !== 'web-animation') return [];
    const source = input.sourceOf(clip);
    return source === null ? [] : [{ clip, source }];
  });
}

/**
 * The copies wanting an instance: visible ones bottom-up, then those first visible within the lead, walking the
 * playback boundaries so each copy is found at the frame it starts showing.
 * @param input - The allocation input.
 * @returns The wants in allocation order.
 * @throws {never} Never.
 */
function wantsOf(input: WebInstanceAllocationInput): Want[] {
  const wants: Want[] = webCopiesAt(input, input.frame).map(({ clip, source }) => ({ clip, source, role: 'visible', targetFrame: null }));
  const seen = new Set(wants.map((want) => want.clip.id));
  const end = input.frame + input.premountFrames + 1;
  let at = input.frame;
  while (input.premountFrames > 0) {
    const next = nextTimelinePlaybackBoundary(input.document, input.readyClipIds, at, end);
    if (next >= end || next <= at) break;
    for (const { clip, source } of webCopiesAt(input, next)) {
      if (seen.has(clip.id)) continue;
      seen.add(clip.id);
      wants.push({ clip, source, role: 'premount', targetFrame: next });
    }
    at = next;
  }
  return wants;
}

/**
 * Whether two assignment lists are the same.
 * @param a - One list.
 * @param b - The other.
 * @returns True when every assignment matches in order.
 * @throws {never} Never.
 */
function sameAssignments(a: readonly WebInstanceAssignment[], b: readonly WebInstanceAssignment[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index];
    return other !== undefined && item.key === other.key && item.role === other.role && item.clipId === other.clipId && item.targetFrame === other.targetFrame;
  });
}

/**
 * Allocate instances to the copies at the current frame (inner#1711 design §7.4 rules): a copy keeps the instance it
 * last had; one without claims an idle instance of its source, else a new one; visible copies bottom-up go before
 * premounted ones; an instance no copy takes goes idle, unless it failed, in which case it is unloaded; idle instances
 * beyond the cap are unloaded earliest first. An unchanged result returns the previous pool itself.
 * @param previous - The pool before.
 * @param input - The document, frame and limits now.
 * @returns The pool after.
 * @throws {never} Never.
 */
export function allocateWebInstances(previous: WebInstancePool, input: WebInstanceAllocationInput): WebInstancePool {
  const wants = wantsOf(input);
  const held = previous.assignments;
  const taken = new Map<string, string>();
  const keyOf = new Map<string, string>();
  // Keep: a copy goes on with the instance it last had, idle or failed included.
  for (const want of wants) {
    const kept = held.find((item) => !taken.has(item.key) && item.sourceVersionId === want.source && previous.lastClips[item.key]?.id === want.clip.id);
    if (kept === undefined) continue;
    taken.set(kept.key, want.clip.id);
    keyOf.set(want.clip.id, kept.key);
  }
  // What no copy keeps is free to claim, earliest idled first; a failed instance is unloaded instead.
  const free = [...held.filter((item) => item.role === 'idle'), ...held.filter((item) => item.role !== 'idle')]
    .filter((item) => !taken.has(item.key) && !input.failedKeys.has(item.key));
  const ordinals: Record<string, number> = { ...previous.ordinals };
  for (const want of wants) {
    if (keyOf.has(want.clip.id)) continue;
    const claimed = free.find((item) => !taken.has(item.key) && item.sourceVersionId === want.source);
    let key: string;
    if (claimed === undefined) {
      const ordinal = ordinals[want.source] ?? 0;
      ordinals[want.source] = ordinal + 1;
      key = `${want.source}:${ordinal}`;
    } else {
      key = claimed.key;
    }
    taken.set(key, want.clip.id);
    keyOf.set(want.clip.id, key);
  }
  const lastClips: Record<string, TimelineWebAnimationClip> = {};
  const assignments: WebInstanceAssignment[] = wants.map((want) => {
    const key = keyOf.get(want.clip.id) ?? '';
    lastClips[key] = want.clip;
    return { key, sourceVersionId: want.source, role: want.role, clipId: want.clip.id, targetFrame: want.targetFrame };
  });
  const idle = free.filter((item) => !taken.has(item.key));
  for (const item of idle.slice(Math.max(0, idle.length - input.idleInstancesMax))) {
    const last = previous.lastClips[item.key];
    if (last !== undefined) lastClips[item.key] = last;
    assignments.push({ key: item.key, sourceVersionId: item.sourceVersionId, role: 'idle', clipId: null, targetFrame: null });
  }
  if (sameAssignments(assignments, previous.assignments) && wants.every((want) => previous.lastClips[keyOf.get(want.clip.id) ?? ''] === want.clip)) return previous;
  return { assignments, lastClips, ordinals };
}
