// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project activity feed contract (ADR 2026-07-04 project-activity-feed).
 *
 * One unified append-only feed for every project-level operation:
 * asset uploads/deletes, generation outcomes (canvas tasks, mini-tools
 * backend AND frontend-executed, understand), space lifecycle and
 * member changes. Stored in the PG `project_activities` table
 * (replaces the retired meta-doc `projectMessages` Y.Array), read via
 * keyset-paginated REST, delivered live by an `activity:new` stateless
 * signal on the project meta doc.
 */

import { z } from "zod";

import type { ProjectRole } from "@shared/types/role.js";

/** Every event type the feed can carry (SQL CHECK mirrors this list). */
export const PROJECT_ACTIVITY_TYPES = [
  "asset:uploaded",
  "asset:deleted",
  "generation:succeeded",
  "generation:failed",
  "space:created",
  "space:deleted",
  "space:restored",
  "space:locked",
  "space:unlocked",
  "space:renamed",
  "member:joined",
  "member:removed",
  "member:role-changed",
  "member:ownership-transferred",
] as const;

export type ProjectActivityType = (typeof PROJECT_ACTIVITY_TYPES)[number];

/** Asset payloads - uploaded rows are head()-verified server-side. */
export const AssetActivityPayloadSchema = z.object({
  fileUrl: z.string().min(1),
  /** Storage kind bucket (image / video / audio / file). */
  kind: z.string().min(1),
  /**
   * Server-derived cover thumbnail of an uploaded VIDEO (#1824) — the feed
   * renders it as the video-upload row's thumbnail. image / audio / file
   * uploads omit it (mirrors the generation payload's `thumbnailUrl`).
   */
  thumbnailUrl: z.string().min(1).optional(),
});

/**
 * Generation payloads. `source` distinguishes canvas tasks from
 * mini-tools; `executedOn: 'frontend'` marks browser-executed
 * mini-tools (capability rule: pure media transforms run client-side
 * and report through the upload handshake - they carry no taskId).
 */
export const GenerationActivityPayloadSchema = z.object({
  source: z.enum(["task", "mini_tool", "understand"]),
  toolName: z.string().optional(),
  model: z.string().optional(),
  outputCount: z.number().int().positive().optional(),
  executedOn: z.enum(["backend", "frontend"]).optional(),
  errorMessage: z.string().optional(),
  // #1622 activity-feed playable preview + credits display. All optional:
  // a non-media generation (understand) and every legacy row omit them.
  /**
   * Media modality of the primary output — drives the row thumbnail +
   * playable hover preview. Only the three renderable modalities; a
   * non-media taskType (understand / 3d) omits this.
   */
  kind: z.enum(["image", "video", "audio"]).optional(),
  /** Primary output URL (permanent public URL) — the preview src. */
  fileUrl: z.string().min(1).optional(),
  /** Video cover (image/audio omit it). */
  thumbnailUrl: z.string().min(1).optional(),
  /**
   * Credits consumed — a FLOAT (video models bill fractional credits),
   * mirroring the doublePrecision billing columns. Never `.int()`.
   */
  credits: z.number().nonnegative().optional(),
});

/**
 * Space payloads. `spaceSnapshot` (space:deleted only) is the frozen
 * meta directory entry (id/type/name/order/locked/createdAt/createdBy)
 * consumed by space:restore to rebuild the entry - the canvas CONTENT
 * doc is soft-deleted/undeleted in PG separately and never snapshotted.
 */
export const SpaceActivityPayloadSchema = z.object({
  spaceName: z.string().optional(),
  oldSpaceName: z.string().optional(),
  spaceSnapshot: z.record(z.string(), z.unknown()).optional(),
});

export const MemberActivityPayloadSchema = z.object({
  role: z.custom<ProjectRole>().optional(),
  previousRole: z.custom<ProjectRole>().optional(),
  /** Affected user when the actor acts on someone else (remove etc.). */
  targetUserId: z.string().optional(),
});

/**
 * One activity feed entry as served by
 * `GET /projects/:id/activities`. `actorName` is resolved server-side
 * by a users join at read time (pointer model - renames propagate
 * retroactively); null for system rows.
 */
export const ProjectActivityEntrySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  type: z.enum(PROJECT_ACTIVITY_TYPES),
  spaceId: z.string().nullable(),
  nodeId: z.string().nullable(),
  taskId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  /** space:deleted only - snapshot already consumed by a restore. */
  restored: z.boolean(),
  /** Epoch milliseconds. */
  createdAt: z.number(),
});

export type ProjectActivityEntry = z.infer<typeof ProjectActivityEntrySchema>;

/**
 * Keyset cursor - opaque to clients, encodes (createdAt, id) of the
 * last row of the previous page.
 */
export const ProjectActivityPageSchema = z.object({
  items: z.array(ProjectActivityEntrySchema),
  /** Pass back as ?cursor= to fetch the next (older) page; null = end. */
  nextCursor: z.string().nullable(),
});

export type ProjectActivityPage = z.infer<typeof ProjectActivityPageSchema>;

/**
 * Stateless WS signal broadcast on the project meta doc whenever a new
 * activity row lands - clients react by refetching the first feed page.
 */
export const ACTIVITY_NEW_SIGNAL = "activity:new" as const;

export const ActivityNewSignalSchema = z.object({
  t: z.literal(ACTIVITY_NEW_SIGNAL),
  projectId: z.string(),
});

export type ActivityNewSignal = z.infer<typeof ActivityNewSignalSchema>;
