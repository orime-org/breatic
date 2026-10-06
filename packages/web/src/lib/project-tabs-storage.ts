// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';

import { openAccountRecord, type AccountRecord } from '@web/lib/account-record';
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from '@web/lib/canvas-zoom';
import { STORAGE_KEYS } from '@web/lib/storage-keys';

/**
 * Where the Space tab bar lives between visits.
 *
 * The record is addressed the way the product nests things — account, then
 * project, then Space (user 2026-09-16) — because two people share a browser
 * often enough to matter, and without the account on the outside the second
 * one opens a project onto the first one's tabs and camera.
 *
 * This module is the only place that key is read or written. Each caller
 * touches one part of a slot: `ProjectPage` owns the list, `CanvasSpace` owns
 * one tab's camera, `useUIStore` owns whether the Agent panel is open, and
 * every writer carries the other parts over. Every write re-reads first, so a call naming one account and
 * project can only replace that slot — what another browser tab of the same
 * account wrote for the SAME project is overwritten, and that is the one
 * collision the design accepts (user 2026-09-16).
 *
 * Anything the browser hands back that does not parse is treated as though
 * that slot were absent. Containment runs one and two levels down: a broken
 * account entry leaves every other account's alone, and a broken slot leaves
 * its neighbouring projects alone. The whole key is the exception — a string
 * that is not JSON is already absent for everybody, and the next write from
 * any account replaces it with that account's record alone. A camera is
 * finer-grained still — a value the canvas would refuse costs that Space its camera and leaves the strip standing — and the
 * next write puts that `null` on disk, which is the value the reader now has:
 * the Space opens framed, the way one with no stored camera does.
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
 * A camera the canvas would refuse — a zoom outside what it allows, or a
 * number that is not finite — would leave the reader on a blank screen with
 * nothing on it saying why.
 *
 * It costs that Space its camera and nothing else: the Space opens framed, the
 * way one with no stored camera does, while the strip it sat on and the tab
 * that was showing are still what the account left. One unusable number is a
 * reason to drop one camera, not the reader's tabs.
 */
const viewportSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().min(CANVAS_MIN_ZOOM).max(CANVAS_MAX_ZOOM),
  })
  .nullable()
  .catch(null);

/**
 * One account's slot for one project. `tabs` is absent while the only thing
 * stored here is whether the Agent panel is open; the strip is first stored
 * by `writeOpenTabs`. A panel value that does not parse costs that value and
 * nothing else, so it can never take the reader's tabs with it.
 */
const slotSchema = z.object({
  tabs: z
    .array(
      z.object({
        spaceId: z.string().min(1),
        viewport: viewportSchema,
      }),
    )
    .optional(),
  activeId: z.string().min(1).nullable().optional(),
  agentPanelOpen: z.boolean().optional().catch(undefined),
});

type Slot = z.infer<typeof slotSchema>;

/**
 * One account's slot for one project, or null when it is absent or unreadable.
 * @param account - That account's view of the key.
 * @param projectId - The project being read.
 * @returns The validated slot, or null.
 */
function readSlot(account: AccountRecord, projectId: string): Slot | null {
  const parsed = slotSchema.safeParse(account.entry?.[projectId]);
  return parsed.success ? parsed.data : null;
}

/**
 * Replace one account's slot for one project, leaving every other slot as it
 * was found.
 * @param account - That account's view of the key, read once by the caller.
 * @param projectId - The project being written.
 * @param next - The slot to store.
 */
function writeSlot(account: AccountRecord, projectId: string, next: Slot): void {
  account.write({ ...account.entry, [projectId]: next });
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
  const account = openAccountRecord(STORAGE_KEYS.projectTabs, userId);
  const slot = account === null ? null : readSlot(account, projectId);
  if (slot?.tabs === undefined) return null;
  return { openIds: slot.tabs.map((t) => t.spaceId), activeId: slot.activeId ?? null };
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
  const account = openAccountRecord(STORAGE_KEYS.projectTabs, userId);
  if (account === null) return;
  const previous = readSlot(account, projectId);
  const cameras = new Map(
    (previous?.tabs ?? []).map((t) => [t.spaceId, t.viewport] as const),
  );
  writeSlot(account, projectId, {
    ...previous,
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
 * @returns The stored camera, or null. Null is also the answer for a Space
 *   that is not an open tab, for one whose tab left the strip and came back
 *   (`writeOpenTabs` drops the camera of every tab that leaves), and for a
 *   stored camera the canvas would refuse.
 */
export function readSpaceViewport(
  userId: string | undefined,
  projectId: string,
  spaceId: string,
): StoredViewport | null {
  const account = openAccountRecord(STORAGE_KEYS.projectTabs, userId);
  const slot = account === null ? null : readSlot(account, projectId);
  return slot?.tabs?.find((t) => t.spaceId === spaceId)?.viewport ?? null;
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
  const account = openAccountRecord(STORAGE_KEYS.projectTabs, userId);
  if (account === null) return;
  const slot = readSlot(account, projectId);
  if (slot?.tabs?.some((t) => t.spaceId === spaceId) !== true) return;
  writeSlot(account, projectId, {
    ...slot,
    tabs: slot.tabs.map((t) => (t.spaceId === spaceId ? { ...t, viewport } : t)),
  });
}

/**
 * Whether this account left the Agent panel open in this project.
 * @param userId - The signed-in account; nothing is read without one.
 * @param projectId - The project being opened.
 * @returns The stored value, or undefined when the panel was never toggled
 *   here or the stored value is unusable.
 */
export function readAgentPanelOpen(
  userId: string | undefined,
  projectId: string,
): boolean | undefined {
  const account = openAccountRecord(STORAGE_KEYS.projectTabs, userId);
  return account === null ? undefined : readSlot(account, projectId)?.agentPanelOpen;
}

/**
 * Store whether the Agent panel is open, keeping the strip and cameras as they
 * were.
 * @param userId - The signed-in account; nothing is written without one.
 * @param projectId - The project the panel belongs to.
 * @param open - Whether the panel is open.
 */
export function writeAgentPanelOpen(
  userId: string | undefined,
  projectId: string,
  open: boolean,
): void {
  const account = openAccountRecord(STORAGE_KEYS.projectTabs, userId);
  if (account === null) return;
  writeSlot(account, projectId, { ...readSlot(account, projectId), agentPanelOpen: open });
}
