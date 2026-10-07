// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One value per key object, with listeners, shaped for `useSyncExternalStore`:
 * the value read is the same reference until a write replaces it.
 */

/** The store. */
export interface KeyedStore<K extends object, T> {
  /** The value for a key; the initial one until something is written. */
  get(key: K): T;
  /** Replaces the value and tells the key's listeners, unless it is the same. */
  set(key: K, next: T): void;
  /** Hears every change to a key's value; returns the function that stops it. */
  subscribe(key: K, listener: () => void): () => void;
}

/**
 * Makes a store. Entries are held weakly, so a dropped key takes its value
 * and listeners with it.
 * @param initial - The value a key starts with.
 * @param same - Whether a write changes nothing.
 * @returns The store.
 */
export function keyedStore<K extends object, T>(
  initial: () => T,
  same: (a: T, b: T) => boolean = Object.is,
): KeyedStore<K, T> {
  const entries = new WeakMap<K, { value: T; listeners: Set<() => void> }>();
  /**
   * A key's entry, made on first use.
   * @param key - The key.
   * @returns Its entry.
   */
  const entryOf = (key: K): { value: T; listeners: Set<() => void> } => {
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { value: initial(), listeners: new Set() };
      entries.set(key, entry);
    }
    return entry;
  };
  return {
    get: (key) => entryOf(key).value,
    set: (key, next) => {
      const entry = entryOf(key);
      if (same(entry.value, next)) return;
      entry.value = next;
      entry.listeners.forEach((listener) => {
        listener();
      });
    },
    subscribe: (key, listener) => {
      const { listeners } = entryOf(key);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
