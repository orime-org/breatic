// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What each member last had on screen in a Project (breatic#1488 §6, §8.2,
 * §11.4): selected nodes, pointer, visible canvas rectangle, document caret,
 * and the Space they were in. The external agent's reads, its placements and
 * its screenshots need it while the member is in a terminal talking to the
 * agent, which is exactly when a browser stops refreshing awareness: a tab in
 * the background past five minutes runs its timers about once a minute, and
 * awareness drops a state not refreshed for 30 seconds.
 *
 * So the server keeps its own copy in Redis DB 3, written from each awareness
 * frame a member's connection sends and kept alive by that socket's signs of
 * life (the pong, which the browser's network stack answers whatever its
 * timers do). One key per member per Project, holding the last frame's view,
 * and one sorted set per Project naming the members whose key is live, scored
 * by when it expires, so a read never scans the keyspace.
 */

import type { Redis } from "@breatic/core";
import { z } from "zod";

/** A point on the canvas. */
const pointSchema = z.object({ x: z.number(), y: z.number() });

/** The canvas rectangle a viewport shows. */
const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });

/** A y-prosemirror caret: two relative positions, read when a document is. */
const cursorSchema = z.object({ anchor: z.record(z.string(), z.unknown()), head: z.record(z.string(), z.unknown()) });

/** What one member had on screen, as their browser published it. */
export interface ViewFields {
  activeNodeIds: string[] | null;
  pointer: { x: number; y: number } | null;
  camera: { x: number; y: number; width: number; height: number } | null;
  cursor: { anchor: Record<string, unknown>; head: Record<string, unknown> } | null;
}

/** One member's last view in a Project. */
export interface LastView extends ViewFields {
  userId: string;
  /** The Space the view is of. */
  spaceId: string;
  /** When it was written, epoch ms. */
  at: number;
}

/**
 * Read a field, or null when it is missing or malformed.
 * @param schema - The field's shape.
 * @param value - What the browser sent.
 * @returns The field.
 */
function fieldOf<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The view one awareness state publishes. A browser's state is untrusted:
 * each field is taken only in the shape our own client writes.
 * @param state - One awareness state.
 * @returns The view, or null when the state publishes none.
 */
export function viewOfAwareness(state: unknown): ViewFields | null {
  if (state === null || typeof state !== "object") return null;
  const raw = state as Record<string, unknown>;
  if (!["activeNodeIds", "pointer", "camera", "cursor"].some((key) => key in raw)) return null;
  return {
    activeNodeIds: fieldOf(z.array(z.string()), raw.activeNodeIds),
    pointer: fieldOf(pointSchema, raw.pointer),
    camera: fieldOf(rectSchema.transform(({ x, y, width, height }) => ({ x, y, width, height })), raw.camera),
    cursor: fieldOf(cursorSchema, raw.cursor),
  };
}

/**
 * A member's key.
 * @param prefix - `REDIS_KEY_PREFIX`.
 * @param projectId - The Project.
 * @param userId - The member.
 * @returns The key.
 */
function viewKey(prefix: string, projectId: string, userId: string): string {
  return `${prefix}:collab:last-view:${projectId}:${userId}`;
}

/**
 * A Project's index of live keys.
 * @param prefix - `REDIS_KEY_PREFIX`.
 * @param projectId - The Project.
 * @returns The key.
 */
function indexKey(prefix: string, projectId: string): string {
  return `${prefix}:collab:last-view-index:${projectId}`;
}

/** One member in one Project. */
export interface ProjectMember {
  projectId: string;
  userId: string;
}

/**
 * Write a member's view.
 * @param redis - Redis DB 3.
 * @param prefix - `REDIS_KEY_PREFIX`.
 * @param entry - Whose view, of which Space.
 * @param ttlMs - How long it lives without a sign of life: the presence expiry.
 * @param now - The clock.
 * @throws {Error} When Redis refuses the write.
 */
export async function recordLastView(
  redis: Redis,
  prefix: string,
  entry: ProjectMember & { spaceId: string; view: ViewFields },
  ttlMs: number,
  now: number,
): Promise<void> {
  const value: LastView = { ...entry.view, userId: entry.userId, spaceId: entry.spaceId, at: now };
  const index = indexKey(prefix, entry.projectId);
  await redis
    .multi()
    .set(viewKey(prefix, entry.projectId, entry.userId), JSON.stringify(value), "PX", ttlMs)
    .zadd(index, now + ttlMs, entry.userId)
    .zremrangebyscore(index, "-inf", now)
    .pexpire(index, ttlMs)
    .exec();
}

/**
 * Keep the views of members whose socket showed a sign of life.
 * @param redis - Redis DB 3.
 * @param prefix - `REDIS_KEY_PREFIX`.
 * @param members - Who, in which Project.
 * @param ttlMs - The presence expiry.
 * @param now - The clock.
 * @throws {Error} When Redis refuses the write.
 */
export async function renewLastViews(redis: Redis, prefix: string, members: readonly ProjectMember[], ttlMs: number, now: number): Promise<void> {
  if (members.length === 0) return;
  const batch = redis.multi();
  for (const { projectId, userId } of members) {
    const index = indexKey(prefix, projectId);
    batch.pexpire(viewKey(prefix, projectId, userId), ttlMs);
    // XX: a member who never published a view is not added.
    batch.zadd(index, "XX", now + ttlMs, userId);
    batch.pexpire(index, ttlMs, "GT");
  }
  await batch.exec();
}

/**
 * Every live member view of a Project.
 * @param redis - Redis DB 3.
 * @param prefix - `REDIS_KEY_PREFIX`.
 * @param projectId - The Project.
 * @param now - The clock.
 * @returns The views.
 * @throws {Error} When Redis refuses the read.
 */
export async function readLastViews(redis: Redis, prefix: string, projectId: string, now: number): Promise<LastView[]> {
  const userIds = await redis.zrangebyscore(indexKey(prefix, projectId), now, "+inf");
  if (userIds.length === 0) return [];
  const raws = await redis.mget(userIds.map((userId) => viewKey(prefix, projectId, userId)));
  return raws.flatMap((raw) => (raw === null ? [] : [JSON.parse(raw) as LastView]));
}
