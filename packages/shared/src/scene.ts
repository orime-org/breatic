// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

/** Plain scene values shared by the collaboration projection and renderer. */
export const SceneObjectValuesSchema = z.object({
  name: z.string().trim().min(1).max(256),
  model: SceneModelSchema,
  position: SceneVectorSchema,
  rotation: SceneRotationSchema,
  scale: SceneScaleSchema,
  locked: z.boolean(),
  exists: z.boolean(),
}).strict();

/** A projected object combines its stable document key with plain values. */
export const SceneObjectSchema = SceneObjectValuesSchema.extend({ id: z.string().uuid() });

export type SceneVector = z.infer<typeof SceneVectorSchema>;
export type SceneRotation = z.infer<typeof SceneRotationSchema>;
export type SceneModel = z.infer<typeof SceneModelSchema>;
export type SceneObjectValues = z.infer<typeof SceneObjectValuesSchema>;
export type SceneObject = z.infer<typeof SceneObjectSchema>;

/** The existing arrays created together with every stable object record. */
export const SCENE_EDITABLE_FIELDS = ['name', 'position', 'rotation', 'scale', 'locked', 'exists'] as const;
export type SceneEditableField = typeof SCENE_EDITABLE_FIELDS[number];
