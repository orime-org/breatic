// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How full each Space document is, as collab last pushed it (inner#1790).
 *
 * A document is `unknown` until a push arrives, and again while the
 * deployment sets no limit (`limit` 0); then every write goes through. After
 * collab refuses an update the document is rebuilt and stays `resyncing`
 * until the new provider has synced, when it takes the latest push it has
 * received. Reservations hold room for writes whose size is known before they
 * land: each one is released once a push arrives after collab confirmed the
 * write that carried it, since that push already counts the write.
 */

import * as React from 'react';

import { DocSizeStatusSchema, parseDocName, type DocSizeStatus } from '@breatic/shared';

/** What a document's size allows. */
export type DocSizePhase = 'unknown' | 'normal' | 'warning' | 'full' | 'resyncing';

/** A document's size, as `readDocSize` returns it. */
export interface DocSizeState {
  phase: DocSizePhase;
  /** The phase of the push in effect, which a rebuild leaves on screen. */
  shownPhase: Exclude<DocSizePhase, 'resyncing'>;
  /** The document is above the hard ceiling. */
  overCeiling: boolean;
  bytes: number | null;
  limit: number | null;
  ceiling: number | null;
  room: number | null;
  overwriteRoom: number | null;
}

/** Room held for a write, released by `release()` or by the push that counts the write. */
export interface SpaceReservation {
  release: () => void;
}

/** One reservation as the document keeps it. */
interface HeldReservation extends SpaceReservation {
  bytes: number;
  /** The document's local version after the write that carried it. */
  version: number | undefined;
}

/** One document's size facts. */
interface SizeEntry {
  /** The push in effect. */
  shown: DocSizeStatus | null;
  /** The latest push received, which a rebuild takes once synced. */
  latest: DocSizeStatus | null;
  resyncing: boolean;
  reservations: Set<HeldReservation>;
  snapshot: DocSizeState;
}

const UNKNOWN: DocSizeState = Object.freeze({
  phase: 'unknown', shownPhase: 'unknown', overCeiling: false, bytes: null, limit: null, ceiling: null, room: null, overwriteRoom: null,
});

const entries = new Map<string, SizeEntry>();
const listeners = new Map<string, Set<() => void>>();
const generations = new Map<string, number>();
const generationListeners = new Map<string, Set<() => void>>();

/**
 * Whether a document name is a Space content document.
 * @param name - Canonical document name.
 * @returns True for canvas, document, timeline and 3D documents.
 */
export function isSpaceContentDoc(name: string): boolean {
  const parsed = parseDocName(name);
  return parsed !== null && parsed.kind !== 'meta';
}

/**
 * The state a document's facts describe.
 * @param entry - The facts.
 * @returns The state.
 */
function describe(entry: SizeEntry): DocSizeState {
  const push = entry.shown;
  const known = push !== null && push.limit > 0;
  const shownPhase = known ? push.phase : 'unknown';
  if (push === null) return entry.resyncing ? { ...UNKNOWN, phase: 'resyncing' } : UNKNOWN;
  return {
    phase: entry.resyncing ? 'resyncing' : shownPhase,
    shownPhase,
    overCeiling: known && push.bytes > push.ceiling,
    bytes: push.bytes,
    limit: push.limit,
    ceiling: push.ceiling,
    room: push.room,
    overwriteRoom: push.overwriteRoom,
  };
}

/**
 * Publish a document's changed facts.
 * @param name - Canonical document name.
 * @param entry - Its facts.
 */
function changed(name: string, entry: SizeEntry): void {
  entry.snapshot = describe(entry);
  listeners.get(name)?.forEach((listener) => listener());
}

/**
 * A document's facts, created on first use.
 * @param name - Canonical document name.
 * @returns The facts.
 */
function entryOf(name: string): SizeEntry {
  let entry = entries.get(name);
  if (!entry) {
    entry = { shown: null, latest: null, resyncing: false, reservations: new Set(), snapshot: UNKNOWN };
    entries.set(name, entry);
  }
  return entry;
}

/**
 * A document's size.
 * @param name - Canonical document name.
 * @returns The state; `unknown` with null numbers before any push.
 */
export function readDocSize(name: string): DocSizeState {
  return entries.get(name)?.snapshot ?? UNKNOWN;
}

/**
 * Follow a document's size.
 * @param name - Canonical document name.
 * @returns The state, updated on every change.
 */
export function useDocSize(name: string): DocSizeState {
  const subscribe = React.useCallback((listener: () => void): (() => void) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(listener);
    return (): void => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(name);
    };
  }, [name]);
  const read = React.useCallback((): DocSizeState => readDocSize(name), [name]);
  return React.useSyncExternalStore(subscribe, read);
}

/**
 * Take one stateless payload; anything but a valid `doc:size` push is ignored.
 * @param name - Canonical document name.
 * @param payload - The serialized message.
 * @param confirmedVersion - The document's confirmed local version, which
 *   releases the reservations of the writes it covers.
 */
export function receiveDocSizePayload(name: string, payload: string, confirmedVersion: number): void {
  if (!isSpaceContentDoc(name)) return;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    // Not every stateless message is JSON this module reads.
    return;
  }
  const parsed = DocSizeStatusSchema.safeParse(value);
  if (!parsed.success) return;
  const push = parsed.data;
  const entry = entryOf(name);
  entry.latest = push;
  if (!entry.resyncing) entry.shown = push;
  for (const reservation of entry.reservations) {
    if (push.limit === 0 || (reservation.version !== undefined && reservation.version <= confirmedVersion)) {
      entry.reservations.delete(reservation);
    }
  }
  changed(name, entry);
}

/**
 * A rebuilt document's new provider has synced: the latest push takes effect.
 * @param name - Canonical document name.
 */
export function docSizeSynced(name: string): void {
  const entry = entries.get(name);
  if (!entry?.resyncing) return;
  entry.resyncing = false;
  entry.shown = entry.latest;
  changed(name, entry);
}

/**
 * Collab refused an update: drop the document's reservations and hold every
 * write until the rebuilt document has synced.
 * @param name - Canonical document name.
 */
export function startDocResync(name: string): void {
  const entry = entryOf(name);
  entry.resyncing = true;
  entry.reservations.clear();
  changed(name, entry);
  generations.set(name, (generations.get(name) ?? 0) + 1);
  generationListeners.get(name)?.forEach((listener) => listener());
}

/**
 * Forget a closed Space document's size.
 * @param name - Canonical document name.
 */
export function clearDocSize(name: string): void {
  const entry = entries.get(name);
  if (!entry) return;
  entries.delete(name);
  listeners.get(name)?.forEach((listener) => listener());
}

/**
 * Forget every document's size, when the account's transport is torn down.
 */
export function clearAllDocSizes(): void {
  for (const name of [...entries.keys()]) clearDocSize(name);
}

/**
 * How many times a document has been rebuilt, the key its Space subtree mounts under.
 * @param name - Canonical document name.
 * @returns The count.
 */
function readDocGeneration(name: string): number {
  return generations.get(name) ?? 0;
}

/**
 * Follow a document's rebuild count.
 * @param name - Canonical document name.
 * @returns The count, updated on every rebuild.
 */
export function useDocGeneration(name: string): number {
  const subscribe = React.useCallback((listener: () => void): (() => void) => {
    let set = generationListeners.get(name);
    if (!set) {
      set = new Set();
      generationListeners.set(name, set);
    }
    set.add(listener);
    return (): void => {
      set.delete(listener);
      if (set.size === 0) generationListeners.delete(name);
    };
  }, [name]);
  const read = React.useCallback((): number => readDocGeneration(name), [name]);
  return React.useSyncExternalStore(subscribe, read);
}

/**
 * Room left for new writes: the pushed room less what reservations hold.
 * @param name - Canonical document name.
 * @returns Bytes, at least 0; null while the size is unknown.
 */
export function availableRoom(name: string): number | null {
  const entry = entries.get(name);
  const state = readDocSize(name);
  if (!entry || state.room === null || state.shownPhase === 'unknown') return null;
  let held = 0;
  for (const reservation of entry.reservations) held += reservation.bytes;
  return Math.max(0, state.room - held);
}

/**
 * A reservation that holds nothing, for a document whose size is unknown.
 * @returns The handle.
 */
export function freeReservation(): SpaceReservation {
  return { release: (): void => undefined };
}

/**
 * Hold room for a write that lands later.
 * @param name - Canonical document name.
 * @param bytes - Bytes to hold.
 * @returns The reservation.
 */
export function holdRoom(name: string, bytes: number): SpaceReservation {
  const entry = entryOf(name);
  const held: HeldReservation = {
    bytes,
    version: undefined,
    release: (): void => {
      if (held.version !== undefined || !entry.reservations.has(held)) return;
      entry.reservations.delete(held);
      changed(name, entry);
    },
  };
  entry.reservations.add(held);
  changed(name, entry);
  return held;
}

/**
 * The bytes a reservation still holds for a write, or null when it holds
 * nothing any more (released, used by a write, or dropped by a rebuild).
 * @param name - Canonical document name.
 * @param reservation - The handle a caller passed.
 * @returns Its bytes, or null.
 */
export function heldBytes(name: string, reservation: SpaceReservation | undefined): number | null {
  const entry = entries.get(name);
  if (!entry || reservation === undefined || !entry.reservations.has(reservation as HeldReservation)) return null;
  const held = reservation as HeldReservation;
  return held.version === undefined ? held.bytes : null;
}

/**
 * Tie room to a write: the reservation it carried, grown to the write's
 * estimate, or a new one for the estimate. With `version` null the write has
 * not landed yet; no push releases the room until the returned callback
 * gives the version the write landed at.
 * @param name - Canonical document name.
 * @param bytes - The write's estimate.
 * @param version - The document's local version after the write, or null.
 * @param reservation - The reservation the write carried, if it still held room.
 * @returns Sets the version once the write has landed.
 */
export function bindWrite(
  name: string,
  bytes: number,
  version: number | null,
  reservation: SpaceReservation | undefined,
): (landed: number) => void {
  const entry = entryOf(name);
  let held = reservation !== undefined && heldBytes(name, reservation) !== null ? (reservation as HeldReservation) : undefined;
  if (held) {
    held.bytes = Math.max(held.bytes, bytes);
  } else {
    held = { bytes, version: undefined, release: (): void => undefined };
    entry.reservations.add(held);
  }
  const bound = held;
  bound.version = version ?? Number.POSITIVE_INFINITY;
  changed(name, entry);
  return (landed: number): void => {
    bound.version = landed;
  };
}
