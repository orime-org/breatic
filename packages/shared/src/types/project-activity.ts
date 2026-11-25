// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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

import type { UploadStatus } from "@shared/upload/upload-status.js";
import { z } from "zod";

import type { SceneLookPictureSettlement } from "@shared/scene.js";
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
  /** A 3D model upload names the model as the user called it (inner#1690). */
  model: z.object({ name: z.string().min(1) }).optional(),
});

/**
 * Which lane opened a run.
 *
 * Named on its own because the value travels three processes — the route
 * writes it onto the task row and into the job, the worker carries it, the
 * crash net hands it back to the feed — and each of those held a free string
 * until this type reached them. Every one of those hops now takes the type,
 * so a lane outside this list cannot be written at any of them.
 *
 * `executedOn: 'frontend'` is a different axis: it marks the mini-tools a
 * browser runs itself, which report through the upload handshake and carry
 * no taskId.
 */
export const GENERATION_SOURCES = ["task", "mini_tool", "understand"] as const;

/** One of the lanes above. */
export type GenerationSource = (typeof GENERATION_SOURCES)[number];

export const GenerationActivityPayloadSchema = z.object({
  source: z.enum(GENERATION_SOURCES),
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
  /**
   * Set while the task waits on its upstream's bill (inner#1743): `credits` is
   * what is known so far, and the final amount replaces it once billed.
   */
  billing: z.literal("pending").optional(),
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
  /**
   * The member the event is about (remove, role change). Equal to the actor
   * when a member leaves on their own, which is how the feed tells a leave
   * from a removal.
   */
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
 * Whether a feed entry is a member leaving of their own accord: a removal
 * whose actor removed themselves. The activity panel and the Agent's activity
 * tool both tell a leave this way (inner#1469).
 * @param entry - The feed entry.
 * @returns True for a leave.
 * @throws {never} Never.
 */
export function isMemberLeave(entry: ProjectActivityEntry): boolean {
  return entry.type === "member:removed" && entry.actorUserId !== null && entry.payload["targetUserId"] === entry.actorUserId;
}

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

export interface ActivityNewSignal {
  t: typeof ACTIVITY_NEW_SIGNAL;
  projectId: string;
}

/**
 * Stateless WS signal on the project meta doc when the credits of the
 * project's Studio changed (#1580): collab sends it to every live project of
 * the Studio, and clients read the credits again.
 */
export const CREDITS_CHANGED_SIGNAL = "credits:changed" as const;

export interface CreditsChangedSignal {
  t: typeof CREDITS_CHANGED_SIGNAL;
  projectId: string;
}

/**
 * Stateless WS signal on the project meta doc when an audio asset's peaks were written (#1580); a cut band waiting
 * for that audio's waveform reads its peaks again. The page knows its audio by address, so the signal carries it.
 */
export const ASSET_PEAKS_READY_SIGNAL = "asset-peaks:ready" as const;

/**
 * Stateless WS signal to one person's meta connections when their bell changed (#1580); it carries no
 * `projectId`, as the bell is the person's, not the project's.
 */
export const NOTIFICATIONS_CHANGED_SIGNAL = "notifications:changed" as const;

export interface NotificationsChangedSignal {
  t: typeof NOTIFICATIONS_CHANGED_SIGNAL;
}

/** Stateless WS signal on the project meta doc when the project's transfer changed (#1580). */
export const PROJECT_TRANSFER_CHANGED_SIGNAL = "project-transfer:changed" as const;

export interface ProjectTransferChangedSignal {
  t: typeof PROJECT_TRANSFER_CHANGED_SIGNAL;
  projectId: string;
}

/**
 * Stateless WS signal to the uploader's meta connections when one of their uploads ended (#1580), carrying the status
 * the status read answers, so the page that waits for it reads nothing more.
 */
export const UPLOAD_ENDED_SIGNAL = "upload:ended" as const;

export interface UploadEndedSignal {
  t: typeof UPLOAD_ENDED_SIGNAL;
  key: string;
  status: UploadStatus;
}

export interface AssetPeaksReadySignal {
  t: typeof ASSET_PEAKS_READY_SIGNAL;
  projectId: string;
  assetId: string;
  url: string;
}

/**
 * Stateless WS signal to the uploader's meta connections when collab settled an
 * uploaded 3D part picture (inner#1693 design 6.3); their page ends that part's
 * upload and, when it was not written, tells them why.
 */
export const SCENE_LOOK_SETTLED_SIGNAL = "scene-look:settled" as const;

export interface SceneLookSettledSignal {
  t: typeof SCENE_LOOK_SETTLED_SIGNAL;
  projectId: string;
  spaceId: string;
  objectId: string;
  part: string;
  picture: string;
  userId: string;
  outcome: SceneLookPictureSettlement;
}
