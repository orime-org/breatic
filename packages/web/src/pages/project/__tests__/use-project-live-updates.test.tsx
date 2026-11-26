// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What the Project page does with each live update collab relays on its meta document (#1580, test spec area I):
 * the bell and the transfer are read again, an upload's ending goes to whoever waits for that key with the status the
 * message carries, and a ready waveform's address goes to the waveform readers. Nothing here asks the server on a
 * timer; the only requests are the reads the messages ask for.
 */

import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadStatus } from '@breatic/shared';
import type * as AssetsModule from '@web/data/api/assets';

vi.mock('@web/data/api/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof AssetsModule>();
  return {
    ...actual,
    assetsApi: {
      ...actual.assetsApi,
      fetchUploadConfig: vi.fn(() => new Promise(() => {})),
    },
  };
});

import { assetsApi } from '@web/data/api/assets';
import { waitForUploadEnding } from '@web/data/upload/upload-status';
import { onAudioPeaksReady } from '@web/spaces/canvas/mini-tool/audio-peaks-ready';
import { useProjectLiveUpdates } from '@web/pages/project/use-project-live-updates';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
/** The signal debounce of `use-project-signal.ts` (spec §0 `C`). */
const C = 250;

type Listener = (d: { payload: string }) => void;

/** A meta-doc provider double that hands its listeners to the test. */
function providerDouble(): {
  provider: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
  send: (payload: unknown) => void;
  sendRaw: (payload: string) => void;
  listeners: Set<Listener>;
  } {
  const listeners = new Set<Listener>();
  return {
    provider: {
      on: vi.fn((_event: string, f: Listener) => {
        listeners.add(f);
      }),
      off: vi.fn((_event: string, f: Listener) => {
        listeners.delete(f);
      }),
    },
    send: (payload) => {
      for (const listener of listeners) listener({ payload: JSON.stringify(payload) });
    },
    sendRaw: (payload) => {
      for (const listener of listeners) listener({ payload });
    },
    listeners,
  };
}

let client = new QueryClient();
let invalidate = vi.spyOn(client, 'invalidateQueries');

/**
 * The hook under a query client.
 * @param provider - The meta-doc provider, or null.
 * @returns The render result.
 */
function mount(provider: ReturnType<typeof providerDouble>['provider'] | null) {
  return renderHook(({ p }) => useProjectLiveUpdates(P1, p as never), {
    initialProps: { p: provider },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/**
 * The calls that invalidated exactly this key.
 * @param queryKey - The key.
 * @returns How many.
 */
function invalidations(queryKey: readonly unknown[]): number {
  return invalidate.mock.calls.filter(([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey)).length;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  client = new QueryClient();
  invalidate = vi.spyOn(client, 'invalidateQueries');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a bell change', () => {
  it('I-01 reads the unread notifications again', () => {
    const double = providerDouble();
    const view = mount(double.provider);
    double.send({ t: 'notifications:changed' });
    vi.advanceTimersByTime(C);
    expect(invalidations(['notifications', 'unread'])).toBe(1);
    view.unmount();
  });

  it('I-02 reads them once for a burst inside the debounce', () => {
    const double = providerDouble();
    const view = mount(double.provider);
    for (let i = 0; i < 5; i += 1) {
      double.send({ t: 'notifications:changed' });
      vi.advanceTimersByTime(C / 5 - 1);
    }
    vi.advanceTimersByTime(C);
    expect(invalidations(['notifications', 'unread'])).toBe(1);
    view.unmount();
  });
});

describe('a transfer change', () => {
  it('I-04 reads this Project\'s live transfer again, and not for another Project\'s', () => {
    const double = providerDouble();
    const view = mount(double.provider);
    double.send({ t: 'project-transfer:changed', projectId: P1 });
    vi.advanceTimersByTime(C);
    expect(invalidations(['project-transfer', 'live', P1])).toBe(1);
    double.send({ t: 'project-transfer:changed', projectId: P2 });
    vi.advanceTimersByTime(C);
    expect(invalidations(['project-transfer', 'live', P2])).toBe(0);
    expect(invalidations(['project-transfer', 'live', P1])).toBe(1);
    view.unmount();
  });
});

describe('an upload\'s ending', () => {
  it('I-07 ends each waiting key with its own status, one by one and without debounce', async () => {
    const double = providerDouble();
    const view = mount(double.provider);
    const k1 = 'uploads/k1.png';
    const k2 = 'uploads/k2.png';
    const first = waitForUploadEnding(k1);
    const second = waitForUploadEnding(k2);
    const s1: UploadStatus = {
      key: k1,
      state: 'completed',
      result: { assetId: 'a-1', fileUrl: 'https://assets.example.test/k1.png', kind: 'image', width: 64, height: 48 },
    };
    const s2: UploadStatus = { key: k2, state: 'failed', reason: 'over_cap' };
    double.send({ t: 'upload:ended', key: k1, status: s1 });
    vi.advanceTimersByTime(5);
    double.send({ t: 'upload:ended', key: k2, status: s2 });
    await expect(first).resolves.toEqual(s1);
    await expect(second).resolves.toEqual(s2);
    expect(assetsApi.fetchUploadConfig).not.toHaveBeenCalled();
    view.unmount();
  });

  it('I-08 ignores an ending nobody waits for', () => {
    const double = providerDouble();
    const view = mount(double.provider);
    expect(() =>
      double.send({ t: 'upload:ended', key: 'uploads/k9.png', status: { key: 'uploads/k9.png', state: 'failed', reason: 'empty' } }),
    ).not.toThrow();
    view.unmount();
  });
});

describe('a waveform made ready', () => {
  it('hands the audio\'s address to the waveform readers (area G, the page side)', () => {
    const double = providerDouble();
    const view = mount(double.provider);
    const heard: string[] = [];
    const stop = onAudioPeaksReady((url: string) => {
      heard.push(url);
    });
    const url = 'https://assets.example.test/a.mp3';
    double.send({ t: 'asset-peaks:ready', projectId: P1, assetId: 'a-1', url });
    vi.advanceTimersByTime(C);
    expect(heard).toEqual([url]);
    stop();
    view.unmount();
  });
});

describe('a video presentation changed (frames-split §7.20)', () => {
  it('reads that video\'s presentation in this Project again, and not for another Project\'s', () => {
    const double = providerDouble();
    const view = mount(double.provider);
    const url = 'https://assets.example.test/v.mp4';
    double.send({ t: 'video-presentation:changed', projectId: P1, assetId: 'a-1', url });
    expect(invalidations(['video-presentation', 1, P1, url])).toBe(1);
    double.send({ t: 'video-presentation:changed', projectId: P2, assetId: 'a-1', url });
    expect(invalidations(['video-presentation', 1, P2, url])).toBe(0);
    expect(invalidations(['video-presentation', 1, P1, url])).toBe(1);
    view.unmount();
  });
});

describe('the meta provider', () => {
  it('I-09 is listened to only while there is one, and let go on unmount', () => {
    const double = providerDouble();
    const view = mount(null);
    expect(double.provider.on).not.toHaveBeenCalled();
    view.rerender({ p: double.provider });
    expect(double.provider.on).toHaveBeenCalledWith('stateless', expect.any(Function));
    expect(double.listeners.size).toBeGreaterThan(0);
    view.unmount();
    expect(double.provider.off).toHaveBeenCalledWith('stateless', expect.any(Function));
    expect(double.listeners.size).toBe(0);
  });

  it('I-10 ignores stateless traffic that is not JSON', () => {
    const double = providerDouble();
    const view = mount(double.provider);
    expect(() => double.sendRaw('rpc-answer:not json')).not.toThrow();
    vi.advanceTimersByTime(C);
    expect(invalidate).not.toHaveBeenCalled();
    view.unmount();
  });
});
