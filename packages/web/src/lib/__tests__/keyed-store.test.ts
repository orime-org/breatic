// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';

import { keyedStore } from '@web/lib/keyed-store';

describe('keyedStore', () => {
  it('keeps one value per key and tells only that key', () => {
    const store = keyedStore<object, number>(() => 0);
    const a = {};
    const b = {};
    const heardA = vi.fn();
    store.subscribe(a, heardA);

    store.set(b, 2);
    store.set(a, 1);

    expect(store.get(a)).toBe(1);
    expect(store.get(b)).toBe(2);
    expect(heardA).toHaveBeenCalledOnce();
  });

  it('tells nobody about a write that changes nothing, and stops on unsubscribe', () => {
    const store = keyedStore<object, { n: number }>(() => ({ n: 0 }), (x, y) => x.n === y.n);
    const key = {};
    const heard = vi.fn();
    const stop = store.subscribe(key, heard);
    const first = store.get(key);

    store.set(key, { n: 0 });
    expect(store.get(key)).toBe(first);
    expect(heard).not.toHaveBeenCalled();

    stop();
    store.set(key, { n: 1 });
    expect(heard).not.toHaveBeenCalled();
  });
});
