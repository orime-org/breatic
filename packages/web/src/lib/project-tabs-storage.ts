// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';

import { STORAGE_KEYS } from '@web/lib/storage-keys';

/**
 * Where the Space tab bar lives between visits.
 *
 * The record is addressed the way the product nests things — account, then
 * project, then Space (user 2026-09-16) — because two people share a browser
 * often enough to matter, and without the account on the outside the second
 * one opens a project onto the first one's tabs and camera.
 *
 * This module is the only place that key is read or written. Both callers
 * touch one slot each: `ProjectPage` owns the list, `CanvasSpace` owns one
 * tab's camera. Every write re-reads first, so a call naming one account and
 * project can only replace that slot — what another browser tab of the same
 * account wrote for the SAME project is overwritten, and that is the one
 * collision the design accepts (user 2026-09-16).
 *
 * Anything the browser hands back that does not parse is treated as though
 * that slot were absent, and only that slot: a neighbour's record survives a
 * broken one, and the write that follows does not carry the loss forward.
 */

/** Where the camera sits on one Space's canvas. */
export interface StoredViewport {
  x: number;
  y: number;
  zoom: number;
}

/** The tab bar as it was when the page was last left. */
export interface RestoredTabs {
  openIds: string[];
  activeId: string | null;
}

/**
 * The canvas pins its zoom to 10%–800% (`CanvasSpace`'s `minZoom` / `maxZoom`).
 * A value outside that, or one that is not a finite number, would leave the
 * user on a blank screen with nothing on it saying why, so the slot holding it
 * reads as absent instead.
 */
const viewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().min(0.1).max(8),
});

const slotSchema = z.object({
  tabs: z.array(
    z.object({
      spaceId: z.string().min(1),
      viewport: viewportSchema.nullable(),
    }),
  ),
  activeId: z.string().min(1).nullable(),
});

type Slot = z.infer<typeof slotSchema>;

/** Account id to project id to that project's strip. */
type Record_ = Record<string, Record<string, unknown>>;

/**
 * Read the whole key, with anything unreadable reported as an empty record.
 * @returns The parsed record; slots inside it are NOT validated here.
 */
function readRecord(): Record_ {
  let value: string | null = null;
  try {
    value = window.localStorage.getItem(STORAGE_KEYS.projectTabs);
  } catch {
    // Private mode and blocked site data both throw on access.
    return {};
  }
  if (value === null) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record_;
  } catch {
    return {};
  }
}

/**
 * Put the whole key back, silently giving up when the browser refuses.
 * @param record - The record to store.
 */
function writeRecord(record: Record_): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEYS.projectTabs,
      JSON.stringify(record),
    );
  } catch {
    // Quota and blocked site data both throw; the strip just stops persisting.
  }
}

/**
 * One account's projects, or null when that entry is absent or is not the
 * shape this module writes.
 *
 * The reader and the writer both come through here so they cannot answer
 * differently about the same entry: this is read during the project page's
 * first render, where anything thrown replaces the page with an error screen
 * that a reload cannot clear, since the reload meets the same record.
 * @param record - The whole record.
 * @param userId - The signed-in account.
 * @returns That account's projects, or null.
 */
function projectsFor(
  record: Record_,
  userId: string,
): Record<string, unknown> | null {
  const forUser: unknown = record[userId];
  if (forUser === null || typeof forUser !== 'object' || Array.isArray(forUser)) {
    return null;
  }
  return forUser as Record<string, unknown>;
}

/**
 * One account's slot for one project, or null when it is absent or unreadable.
 * @param record - The whole record.
 * @param userId - The signed-in account.
 * @param projectId - The project being read.
 * @returns The validated slot, or null.
 */
function readSlot(
  record: Record_,
  userId: string,
  projectId: string,
): Slot | null {
  const projects = projectsFor(record, userId);
  if (projects === null) return null;
  const parsed = slotSchema.safeParse(projects[projectId]);
  return parsed.success ? parsed.data : null;
}

/**
 * Replace one account's slot for one project, leaving every other slot as it
 * was found.
 * @param userId - The signed-in account.
 * @param projectId - The project being written.
 * @param next - The slot to store.
 */
function writeSlot(userId: string, projectId: string, next: Slot): void {
  const record = readRecord();
  const merged = { ...(projectsFor(record, userId) ?? {}) };
  merged[projectId] = next;
  writeRecord({ ...record, [userId]: merged });
}

/**
 * The tab bar this account left behind in this project.
 * @param userId - The signed-in account; nothing is read without one.
 * @param projectId - The project being opened.
 * @returns The stored strip, or null when this account has never left one
 *   here. An empty `openIds` means the account closed every tab, which is a
 *   different answer from null.
 */
export function readProjectTabs(
  userId: string | undefined,
  projectId: string,
): RestoredTabs | null {
  if (userId === undefined || userId === '') return null;
  const slot = readSlot(readRecord(), userId, projectId);
  if (slot === null) return null;
  return { openIds: slot.tabs.map((t) => t.spaceId), activeId: slot.activeId };
}

/**
 * Store the strip as it now stands, carrying each surviving tab's camera with
 * it and dropping the camera of every tab that left.
 * @param userId - The signed-in account; nothing is written without one.
 * @param projectId - The project the strip belongs to.
 * @param openIds - The tabs, in the order they are painted.
 * @param activeId - The tab whose Space is showing.
 */
export function writeOpenTabs(
  userId: string | undefined,
  projectId: string,
  openIds: ReadonlyArray<string>,
  activeId: string | null,
): void {
  if (userId === undefined || userId === '') return;
  const previous = readSlot(readRecord(), userId, projectId);
  const cameras = new Map(
    (previous?.tabs ?? []).map((t) => [t.spaceId, t.viewport] as const),
  );
  writeSlot(userId, projectId, {
    tabs: openIds.map((spaceId) => ({
      spaceId,
      viewport: cameras.get(spaceId) ?? null,
    })),
    activeId,
  });
}

/**
 * Where this account last put the camera on one Space.
 * @param userId - The signed-in account; nothing is read without one.
 * @param projectId - The project the Space belongs to.
 * @param spaceId - The Space being opened.
 * @returns The stored camera, or null when the account has never moved it.
 */
export function readSpaceViewport(
  userId: string | undefined,
  projectId: string,
  spaceId: string,
): StoredViewport | null {
  if (userId === undefined || userId === '') return null;
  const slot = readSlot(readRecord(), userId, projectId);
  return slot?.tabs.find((t) => t.spaceId === spaceId)?.viewport ?? null;
}

/**
 * Store where the camera now sits on one Space, leaving its neighbours alone.
 *
 * A Space that is not an open tab has nowhere to be stored — the strip is what
 * bounds this record — so the call does nothing.
 * @param userId - The signed-in account; nothing is written without one.
 * @param projectId - The project the Space belongs to.
 * @param spaceId - The Space whose camera moved.
 * @param viewport - Where the camera now sits.
 */
export function writeSpaceViewport(
  userId: string | undefined,
  projectId: string,
  spaceId: string,
  viewport: StoredViewport,
): void {
  if (userId === undefined || userId === '') return;
  const slot = readSlot(readRecord(), userId, projectId);
  if (slot === null) return;
  if (!slot.tabs.some((t) => t.spaceId === spaceId)) return;
  writeSlot(userId, projectId, {
    ...slot,
    tabs: slot.tabs.map((t) => (t.spaceId === spaceId ? { ...t, viewport } : t)),
  });
}
