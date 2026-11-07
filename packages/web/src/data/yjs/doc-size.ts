// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How full each Space document is, as collab last pushed it (inner#1790).
 *
 * A document is `unknown` until a push arrives, and again while the
 * deployment sets no limit (`limit` 0); then every write goes through. After
 * collab refuses an update the document is rebuilt and stays `resyncing`
 * until the new provider has synced, when it takes the latest push it has
 * received. The phase is collab's; web never estimates a size.
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
}

/** One document's size facts. */
interface SizeEntry {
  /** The push in effect. */
  shown: DocSizeStatus | null;
  /** The latest push received, which a rebuild takes once synced. */
  latest: DocSizeStatus | null;
  resyncing: boolean;
  snapshot: DocSizeState;
}

const UNKNOWN: DocSizeState = Object.freeze({
  phase: 'unknown', shownPhase: 'unknown', overCeiling: false, bytes: null, limit: null, ceiling: null,
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
  // No push yet, or a deployment with no limit: everything goes through.
  if (push === null || push.limit === 0) return entry.resyncing ? { ...UNKNOWN, phase: 'resyncing' } : UNKNOWN;
  return {
    phase: entry.resyncing ? 'resyncing' : push.phase,
    shownPhase: push.phase,
    overCeiling: push.bytes >= push.ceiling,
    bytes: push.bytes,
    limit: push.limit,
    ceiling: push.ceiling,
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
    entry = { shown: null, latest: null, resyncing: false, snapshot: UNKNOWN };
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
 * Call back whenever a document's size changes, outside React (the document
 * upload controller rescans its bodies when a Space leaves `full`).
 * @param name - Canonical document name.
 * @param listener - Called on every change.
 * @returns What stops listening.
 */
export function subscribeDocSize(name: string, listener: () => void): () => void {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  const held = set;
  held.add(listener);
  return (): void => {
    held.delete(listener);
    if (held.size === 0 && listeners.get(name) === held) listeners.delete(name);
  };
}

/**
 * Follow a document's size.
 * @param name - Canonical document name.
 * @returns The state, updated on every change.
 */
export function useDocSize(name: string): DocSizeState {
  const subscribe = React.useCallback((listener: () => void): (() => void) => subscribeDocSize(name, listener), [name]);
  const read = React.useCallback((): DocSizeState => readDocSize(name), [name]);
  return React.useSyncExternalStore(subscribe, read);
}

/**
 * Take a `doc:size` push, the only writer of a document's size.
 * @param name - Canonical document name.
 * @param status - The push.
 */
export function setDocSize(name: string, status: DocSizeStatus): void {
  if (!isSpaceContentDoc(name)) return;
  const entry = entryOf(name);
  entry.latest = status;
  if (!entry.resyncing) entry.shown = status;
  changed(name, entry);
}

/**
 * Take one stateless payload; anything but a valid `doc:size` push is ignored.
 * @param name - Canonical document name.
 * @param payload - The serialized message.
 */
export function receiveDocSizePayload(name: string, payload: string): void {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    // Not every stateless message is JSON this module reads.
    return;
  }
  const parsed = DocSizeStatusSchema.safeParse(value);
  if (parsed.success) setDocSize(name, parsed.data);
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
 * Collab refused an update: hold every write until the rebuilt document has
 * synced.
 * @param name - Canonical document name.
 */
export function startDocResync(name: string): void {
  const entry = entryOf(name);
  entry.resyncing = true;
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
