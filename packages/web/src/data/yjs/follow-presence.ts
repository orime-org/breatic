// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The awareness fields that let one member follow another (#920).
 *
 * The project's meta awareness carries `view`, the Space a browser tab has in
 * front, and `following`, whom that tab follows, which only collab reads to
 * keep the meta document's following table; each Space's awareness carries where that Space's
 * viewport is: `camera` on a canvas, `topBlockId` in a document, `camera3d` in
 * a 3D Space and `timelineView` on a timeline. Every `at` is wall-clock milliseconds
 * (`Date.now()`), the only clock two browsers share. Awareness carries
 * whatever a peer put there, so every value is read through its schema and a
 * value that fails it counts as absent.
 */

import type { Awareness } from 'y-protocols/awareness';
import { z } from 'zod';

import { readUserId } from '@web/data/yjs/awareness-user';

/** A wall-clock instant in milliseconds. */
const instant = z.number();

/** A frame index on the timeline. */
const frameIndex = z.number().int().nonnegative();

/** A point or direction in the 3D scene. */
const vector3 = z.tuple([z.number(), z.number(), z.number()]);

const SCHEMAS = {
  view: z.object({
    spaceId: z.string().min(1).nullable(),
    at: instant,
    focused: z.boolean(),
  }),
  // Apart from `view` because a hidden tab withdraws its view but still follows.
  following: z.object({ id: z.string().min(1), at: instant }),
  camera: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), at: instant }),
  topBlockId: z.object({ id: z.string().min(1), at: instant }),
  camera3d: z.object({ position: vector3, target: vector3, fov: z.number().positive(), at: instant }),
  timelineView: z
    .object({
      startFrame: z.number().nonnegative(),
      endFrame: z.number(),
      trackScrollTop: z.number().nonnegative(),
      frame: frameIndex,
      intent: z.enum(['play', 'pause']),
      anchor: z.object({ frame: frameIndex, at: instant }).nullable(),
      at: instant,
    })
    .refine((v) => v.endFrame > v.startFrame),
} as const;

/** The name of one follow field. */
export type FollowField = keyof typeof SCHEMAS;

/** The value one follow field holds once it has passed its schema. */
export type FollowFieldValue<F extends FollowField> = z.infer<(typeof SCHEMAS)[F]>;

/**
 * Read one follow field from one awareness entry.
 * @param state - One client's awareness state.
 * @param field - The field to read.
 * @returns The value, or null when it is missing or malformed.
 */
export function readFollowField<F extends FollowField>(
  state: Record<string, unknown>,
  field: F,
): FollowFieldValue<F> | null {
  const parsed = SCHEMAS[field].safeParse(state[field]);
  return parsed.success ? (parsed.data as FollowFieldValue<F>) : null;
}

/** One member's Space in front and whom they follow. */
export interface MemberView {
  spaceId: string | null;
  following: string | null;
}

/**
 * Whether a candidate `view` beats the one picked so far: the focused tab
 * first, then the latest written (as tldraw dedupes by activity).
 * @param view - The candidate.
 * @param best - The view picked so far.
 * @returns True when the candidate wins.
 */
function beatsView(view: FollowFieldValue<'view'>, best: FollowFieldValue<'view'>): boolean {
  return (view.focused && !best.focused) || (view.focused === best.focused && view.at > best.at);
}

/**
 * Each other member's view: the Space from the picked `view` across their
 * browser tabs, and whom they follow from the server's following table
 * (#920). A tab's awareness `following` is only its declaration to the
 * server and is not read here: awareness drops a hidden tab on the browser's
 * throttled timers while its connection is still alive
 * (packages/collab/AGENTS.md#liveness-follows-the-transport). A member in the
 * table with no `view` is listed with no Space.
 * @param states - The project's meta awareness states by client id.
 * @param selfClientId - This client's id, never listed.
 * @param following - Whom each member follows, user id to user id, from the table.
 * @returns The views by user id; a member with neither is absent.
 */
export function pickMemberViews(
  states: ReadonlyMap<number, Record<string, unknown>>,
  selfClientId: number,
  following: ReadonlyMap<string, string>,
): Map<string, MemberView> {
  const views = new Map<string, FollowFieldValue<'view'>>();
  for (const [clientId, state] of states) {
    const userId = clientId === selfClientId ? null : readUserId(state);
    if (userId === null) continue;
    const view = readFollowField(state, 'view');
    if (view === null) continue;
    const best = views.get(userId);
    if (best === undefined || beatsView(view, best)) views.set(userId, view);
  }
  const out = new Map<string, MemberView>();
  for (const [userId, view] of views) out.set(userId, { spaceId: view.spaceId, following: following.get(userId) ?? null });
  for (const [userId, target] of following) {
    if (!out.has(userId)) out.set(userId, { spaceId: null, following: target });
  }
  return out;
}

/**
 * The latest value of one Space field among the leader's other clients.
 * @param awareness - The Space's awareness.
 * @param leaderId - The followed member's user id.
 * @param field - The field to read.
 * @returns The value with the latest `at`, or null when there is none.
 */
export function pickLeaderField<F extends FollowField>(
  awareness: Awareness,
  leaderId: string,
  field: F,
): FollowFieldValue<F> | null {
  const states = awareness.getStates() as ReadonlyMap<number, Record<string, unknown>>;
  let best: FollowFieldValue<F> | null = null;
  for (const [clientId, state] of states) {
    if (clientId === awareness.clientID || readUserId(state) !== leaderId) continue;
    const value = readFollowField(state, field);
    if (value !== null && (best === null || value.at > best.at)) best = value;
  }
  return best;
}
