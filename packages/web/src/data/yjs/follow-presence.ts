// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The awareness fields that let one member follow another (#920).
 *
 * The project's meta awareness carries `view`, the Space a browser tab has in
 * front and whom it follows; each Space's awareness carries where that Space's
 * viewport is: `camera` on a canvas, `topBlockId` in a document, `camera3d` in
 * a 3D Space and `timelineView` on a timeline. Every `at` is wall-clock milliseconds
 * (`Date.now()`), the only clock two browsers share. Awareness carries
 * whatever a peer put there, so every value is read through its schema and a
 * value that fails it counts as absent.
 */

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
    // Whom this tab follows; a view written without it (an older client) follows nobody.
    following: z.string().min(1).nullable().default(null),
  }),
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

/**
 * Every well-formed value of one field among the leader's other clients.
 * @param states - The awareness states by client id.
 * @param leaderId - The followed member's user id.
 * @param field - The field to read.
 * @param selfClientId - This client's id, never a candidate.
 * @returns The values, in the states' order.
 */
function leaderValues<F extends FollowField>(
  states: ReadonlyMap<number, Record<string, unknown>>,
  leaderId: string,
  field: F,
  selfClientId: number,
): FollowFieldValue<F>[] {
  const out: FollowFieldValue<F>[] = [];
  for (const [clientId, state] of states) {
    if (clientId === selfClientId || readUserId(state) !== leaderId) continue;
    const value = readFollowField(state, field);
    if (value !== null) out.push(value);
  }
  return out;
}

/**
 * The `view` the follower goes by when the leader has several browser tabs:
 * the focused one, then the latest written (as tldraw dedupes by activity).
 * @param states - The project's meta awareness states by client id.
 * @param leaderId - The followed member's user id.
 * @param selfClientId - This client's id, never a candidate.
 * @returns The view, or null when the leader publishes none.
 */
export function pickLeaderView(
  states: ReadonlyMap<number, Record<string, unknown>>,
  leaderId: string,
  selfClientId: number,
): FollowFieldValue<'view'> | null {
  let best: FollowFieldValue<'view'> | null = null;
  for (const view of leaderValues(states, leaderId, 'view', selfClientId)) {
    if (best === null || (view.focused && !best.focused) || (view.focused === best.focused && view.at > best.at)) best = view;
  }
  return best;
}

/**
 * The latest value of one Space field among the leader's clients.
 * @param states - The Space's awareness states by client id.
 * @param leaderId - The followed member's user id.
 * @param field - The field to read.
 * @param selfClientId - This client's id, never a candidate.
 * @returns The value with the latest `at`, or null when there is none.
 */
export function pickLeaderField<F extends FollowField>(
  states: ReadonlyMap<number, Record<string, unknown>>,
  leaderId: string,
  field: F,
  selfClientId: number,
): FollowFieldValue<F> | null {
  let best: FollowFieldValue<F> | null = null;
  for (const value of leaderValues(states, leaderId, field, selfClientId)) {
    if (best === null || value.at > best.at) best = value;
  }
  return best;
}
