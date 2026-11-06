// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a page carries across the reload Update starts, and only that reload.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'breatic.reloadDrafts';

/**
 * A fresh copy of the module, as a new page would load it.
 * @returns The module.
 */
async function freshModule(): Promise<typeof import('@web/stores/reload-for-update')> {
  vi.resetModules();
  return import('@web/stores/reload-for-update');
}

/** Unload the page the way a reload does. */
function unload(): void {
  window.dispatchEvent(new Event('pagehide'));
}

beforeEach(() => {
  sessionStorage.clear();
  // jsdom has no navigation; reloading only reports that.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('saving across an update', () => {
  it('writes what every part holds when the page unloads after Update', async () => {
    const { keepAcrossUpdate, reloadForUpdate } = await freshModule();
    keepAcrossUpdate('a', () => ({ x: 1 }));
    keepAcrossUpdate('b', () => ['y']);
    reloadForUpdate();
    unload();
    expect(JSON.parse(sessionStorage.getItem(KEY) ?? 'null')).toEqual({ a: { x: 1 }, b: ['y'] });
  });

  it('writes nothing for an unload Update did not start', async () => {
    const { keepAcrossUpdate } = await freshModule();
    keepAcrossUpdate('a', () => ({ x: 1 }));
    unload();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    ['a key press', (): Event => new KeyboardEvent('keydown', { key: 'F5' })],
    ['a click', (): Event => new Event('pointerdown')],
  ])('forgets Update after %s, so a reload the user starts saves nothing', async (_name, input) => {
    const { keepAcrossUpdate, reloadForUpdate } = await freshModule();
    keepAcrossUpdate('a', () => ({ x: 1 }));
    reloadForUpdate();
    window.dispatchEvent(input());
    unload();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('arms again on a second Update', async () => {
    const { keepAcrossUpdate, reloadForUpdate } = await freshModule();
    keepAcrossUpdate('a', () => 1);
    reloadForUpdate();
    window.dispatchEvent(new Event('pointerdown'));
    reloadForUpdate();
    unload();
    expect(JSON.parse(sessionStorage.getItem(KEY) ?? 'null')).toEqual({ a: 1 });
  });
});

// inner#1729: Update shows it is working until the page goes. A press after
// it means the page stayed (the leave prompt was cancelled), so it stops.
describe('the pending update', () => {
  it('is pending from Update until the next press', async () => {
    const { isUpdatePending, reloadForUpdate } = await freshModule();
    expect(isUpdatePending()).toBe(false);
    reloadForUpdate();
    expect(isUpdatePending()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isUpdatePending()).toBe(false);
  });

  it('tells its subscribers each time it changes', async () => {
    const { reloadForUpdate, subscribeUpdatePending } = await freshModule();
    const heard = vi.fn();
    const stop = subscribeUpdatePending(heard);
    reloadForUpdate();
    window.dispatchEvent(new Event('pointerdown'));
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    reloadForUpdate();
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe('restoring after the update', () => {
  it('hands each part its own value once, and clears the stored copy', async () => {
    sessionStorage.setItem(KEY, JSON.stringify({ a: { x: 1 }, b: ['y'] }));
    const { keepAcrossUpdate } = await freshModule();
    expect(keepAcrossUpdate('a', () => null)).toEqual({ x: 1 });
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(keepAcrossUpdate('b', () => null)).toEqual(['y']);
  });

  it('hands nothing back when nothing was saved or it is not ours', async () => {
    sessionStorage.setItem(KEY, 'not json');
    const { keepAcrossUpdate } = await freshModule();
    expect(keepAcrossUpdate('a', () => null)).toBeUndefined();
  });
});
