// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';
import { openAccountRecord, type AccountEntry } from '@web/lib/account-record';
import { STORAGE_KEYS } from '@web/lib/storage-keys';

const pointSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const viewSchema = z.object({ position: pointSchema, target: pointSchema }).refine(
  (view) => view.position.some((value, index) => value !== view.target[index]),
);

/** A personal observation camera, independent of shared scene content. */
export interface SceneView {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

/**
 * Read an object-shaped account or project slot without trusting stored JSON.
 * @param value - The decoded account or Project slot whose object shape must be checked.
 * @returns The object-shaped slot, or an empty slot for absent, null or array-shaped data.
 */
function objectSlot(value: unknown): AccountEntry {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as AccountEntry
    : {};
}

/**
 * Read only this account's view; invalid or unavailable storage reads as absent.
 * @param userId - The signed-in account owning the personal view; undefined selects no account.
 * @param projectId - The Project containing the requested Space.
 * @param spaceId - The Space whose personal observation camera should be restored.
 * @returns The validated camera position and target, or null when identity, storage or geometry is invalid.
 */
export function readSceneView(
  userId: string | undefined,
  projectId: string,
  spaceId: string,
): SceneView | null {
  if (projectId === '' || spaceId === '') return null;
  const account = openAccountRecord(STORAGE_KEYS.sceneViews, userId);
  if (account === null) return null;
  const project = objectSlot(account.entry?.[projectId]);
  const parsed = viewSchema.safeParse(project[spaceId]);
  return parsed.success ? parsed.data : null;
}

/**
 * Record one validated view, preserving other accounts, Projects and Spaces.
 * @param userId - The signed-in account owning the personal view; undefined prevents writing.
 * @param projectId - The Project containing the Space whose view is being saved.
 * @param spaceId - The Space whose personal observation camera should be replaced.
 * @param view - The camera position and distinct target to validate and record locally.
 * @returns True only when the identities and geometry are valid and localStorage accepts the write.
 */
export function writeSceneView(
  userId: string | undefined,
  projectId: string,
  spaceId: string,
  view: SceneView,
): boolean {
  if (projectId === '' || spaceId === '') return false;
  const parsed = viewSchema.safeParse(view);
  if (!parsed.success) return false;
  const account = openAccountRecord(STORAGE_KEYS.sceneViews, userId);
  if (account === null) return false;
  const entry = account.entry ?? {};
  const project = objectSlot(entry[projectId]);
  return account.write({ ...entry, [projectId]: { ...project, [spaceId]: parsed.data } });
}
