// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from 'zod';

/** A complete position or camera coordinate in metres, using Y-up. */
export const SceneVectorSchema = z.tuple([
  z.number().finite(), z.number().finite(), z.number().finite(),
]);

/** A complete, normalized XYZW rotation; tolerance covers float round-off. */
export const SceneRotationSchema = z.tuple([
  z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite(),
]).refine((value) => Math.abs(Math.hypot(...value) - 1) <= 0.0001,
  'Rotation must be normalized');

/** Positive per-axis scales; reflected and degenerate transforms are unsupported. */
export const SceneScaleSchema = z.tuple([
  z.number().finite().positive(), z.number().finite().positive(), z.number().finite().positive(),
]);

/** Stable model identity; storage addresses are resolved from registered assets. */
export const SceneModelSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), id: z.enum(['figure', 'box']) }).strict(),
  z.object({ kind: z.literal('asset'), assetId: z.string().uuid() }).strict(),
]);

/** The longest name a scene object holds. */
export const SCENE_OBJECT_NAME_MAX = 256;

/** Every pose entry is its own key on the object record, behind this prefix (inner#1692). */
export const SCENE_POSE_KEY_PREFIX = 'pose.';

/** The most bones one object's pose may hold. */
const SCENE_POSE_MAX_KEYS = 256;

/** The longest pose key, counted without {@link SCENE_POSE_KEY_PREFIX}. */
export const SCENE_POSE_KEY_MAX_LENGTH = 128;

/** The hips translation key; the only pose entry that is a vector. */
export const SCENE_POSE_HIPS_KEY = 't:hips';

/** A humanoid bone (`h:`) or a node of another rig (`n:`), each carrying a rotation. */
const ROTATION_KEY = /^[hn]:.+$/su;

/**
 * Bones changed from rest, keyed `h:<VRM bone>` or `n:<node name>` to a normalized
 * rotation, plus `t:hips` to the hips translation in hip heights.
 */
export type ScenePose = Readonly<Record<string, readonly number[]>>;

/**
 * Check one pose entry against the shape its key names.
 * @param key - The pose key without the record prefix.
 * @param value - The stored value.
 * @returns Whether the entry is well formed.
 */
function isPoseEntry(key: string, value: unknown): boolean {
  if (key === SCENE_POSE_HIPS_KEY) return SceneVectorSchema.safeParse(value).success;
  return key.length <= SCENE_POSE_KEY_MAX_LENGTH && ROTATION_KEY.test(key) && SceneRotationSchema.safeParse(value).success;
}

/**
 * Check a whole pose; own keys are read as given, so `__proto__` is judged like any other key.
 * @param value - The candidate pose.
 * @returns Whether it is a pose of at most {@link SCENE_POSE_MAX_KEYS} well-formed entries.
 */
function isScenePose(value: unknown): value is ScenePose {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= SCENE_POSE_MAX_KEYS && entries.every(([key, entry]) => isPoseEntry(key, entry));
}

/** A pose as one value: the projection and commands carry it, the record stores it flat. */
export const ScenePoseSchema = z.custom<ScenePose>(isScenePose, 'Invalid scene pose');

/**
 * Collect a record's flat pose keys into one `pose` value.
 * @param record - A stored object record's plain values.
 * @returns A copy without the flat keys, carrying `pose` only when the record had any.
 */
export function gatherScenePose(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const pose: Record<string, unknown> = {};
  let posed = false;
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith(SCENE_POSE_KEY_PREFIX)) {
      pose[key.slice(SCENE_POSE_KEY_PREFIX.length)] = value;
      posed = true;
    } else values[key] = value;
  }
  if (posed) values.pose = pose;
  return values;
}

/**
 * Spread a pose into the flat record keys it is stored under.
 * @param pose - The pose to store.
 * @returns One prefixed key per entry.
 */
export function expandScenePose(pose: ScenePose): Record<string, unknown> {
  return Object.fromEntries(Object.entries(pose).map(([key, value]) => [`${SCENE_POSE_KEY_PREFIX}${key}`, value]));
}

/** Plain scene values shared by the collaboration projection and renderer. */
export const SceneObjectValuesSchema = z.object({
  name: z.string().trim().min(1).max(SCENE_OBJECT_NAME_MAX),
  model: SceneModelSchema,
  position: SceneVectorSchema,
  rotation: SceneRotationSchema,
  scale: SceneScaleSchema,
  locked: z.boolean(),
  pose: ScenePoseSchema.optional(),
}).strict();

/** A projected object combines its stable document key with plain values. */
export const SceneObjectSchema = SceneObjectValuesSchema.extend({ id: z.string().uuid() });

export type SceneVector = z.infer<typeof SceneVectorSchema>;
export type SceneRotation = z.infer<typeof SceneRotationSchema>;
export type SceneModel = z.infer<typeof SceneModelSchema>;
export type SceneObjectValues = z.infer<typeof SceneObjectValuesSchema>;
export type SceneObject = z.infer<typeof SceneObjectSchema>;

/** Record keys that commands overwrite after creation; `model` is fixed at creation. */
export type SceneEditableField = Exclude<keyof SceneObjectValues, 'model'>;

/** Configured import budgets carried by the readable Project API. */
export interface SceneImportLimits {
  maxInputBytes: number;
  maxExpandedBytes: number;
  maxArtifactBytes: number;
  maxFiles: number;
  maxEntryJsonBytes: number;
  decoderWorkerLimit: number;
  maxTextureEdge: number;
  maxTextureBytes: number;
}

/** Configured scene controls and import budgets, served through the readable Project API. */
export interface SceneControlsConfig {
  scaleSensitivity: number;
  import: SceneImportLimits;
  /** Shortest gap between two upload-progress updates shared with the Space's members. */
  progressPublishMs: number;
}

/**
 * Identify the registered containers that carry a complete scene model.
 * @param value - A reduced MIME essence from an upload or the asset ledger.
 * @returns Whether the container is a GLB or a versioned model ZIP.
 * @throws {never} Never.
 */
export function isSceneModelMediaType(value: string): boolean {
  return value === 'model/gltf-binary' || value === 'application/zip';
}
