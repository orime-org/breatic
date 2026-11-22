// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PT-5 (#1580 test spec §4, invariant I8): under any order of time passing, the tab hiding and showing, answers
 * that succeed with any interval, fail or come back slowly, and the page going away, the Studio page poll keeps at
 * most one request out, starts none while the tab is hidden or after the page went, and asks at once when a hidden
 * tab is shown again.
 */

import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type * as StudioPageModule from '@web/data/api/studio-page';

vi.mock('@web/data/api/studio-page', async (importOriginal) => {
  const actual = await importOriginal<typeof StudioPageModule>();
  return { ...actual, studioPageApi: { ...actual.studioPageApi, poll: vi.fn() } };
});

import { studioPageApi } from '@web/data/api/studio-page';
import { useStudioPagePoll } from '@web/pages/studio/shell/use-studio-page-poll';

type Step =
  | { kind: 'pass'; ms: number }
  | { kind: 'hide' }
  | { kind: 'show' }
  | { kind: 'answer'; ok: boolean; nextPollMs: number }
  | { kind: 'leave' };

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('pass' as const), ms: fc.integer({ min: 0, max: 6000 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('hide' as const) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('show' as const) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('answer' as const), ok: fc.boolean(), nextPollMs: fc.integer({ min: 500, max: 5000 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('leave' as const) }) },
);

describe('PT-5 the Studio page poll under any interleaving', () => {
  it('keeps one request out at most, and sends none while hidden or after leaving', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 30 }), async (steps) => {
        vi.useFakeTimers();
        let visibility: DocumentVisibilityState = 'visible';
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
        const out: { settle: (ok: boolean, nextPollMs: number) => void }[] = [];
        let maxOut = 0;
        let sentWhileStopped = 0;
        let left = false;
        vi.mocked(studioPageApi.poll).mockReset().mockImplementation(() => {
          if (left || visibility === 'hidden') sentWhileStopped += 1;
          return new Promise((resolve, reject) => {
            const entry = {
              settle: (ok: boolean, nextPollMs: number): void => {
                out.splice(out.indexOf(entry), 1);
                if (ok) resolve({ notifications: { unread: 0, latestAt: null }, transfer: null, uploads: [], nextPollMs });
                else reject(new Error('network'));
              },
            };
            out.push(entry);
            maxOut = Math.max(maxOut, out.length);
          });
        });
        const client = new QueryClient();
        const view = renderHook(() => useStudioPagePoll('acme'), {
          wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
        });
        try {
          for (const s of steps) {
            if (s.kind === 'pass') {
              await act(async () => {
                await vi.advanceTimersByTimeAsync(s.ms);
              });
            } else if (s.kind === 'hide' || s.kind === 'show') {
              const wasHidden = visibility === 'hidden';
              const before = vi.mocked(studioPageApi.poll).mock.calls.length;
              visibility = s.kind === 'hide' ? 'hidden' : 'visible';
              act(() => {
                document.dispatchEvent(new Event('visibilitychange'));
              });
              await act(async () => {
                await vi.advanceTimersByTimeAsync(0);
              });
              if (s.kind === 'show' && wasHidden && !left && out.length === 0) {
                expect(vi.mocked(studioPageApi.poll).mock.calls.length).toBe(before + 1);
              }
            } else if (s.kind === 'answer') {
              out[0]?.settle(s.ok, s.nextPollMs);
              await act(async () => {
                await vi.advanceTimersByTimeAsync(0);
              });
            } else if (!left) {
              left = true;
              view.unmount();
            }
          }
          expect(maxOut).toBeLessThanOrEqual(1);
          expect(sentWhileStopped).toBe(0);
        } finally {
          if (!left) view.unmount();
          vi.useRealTimers();
        }
      }),
      { numRuns: 100 },
    );
  });
});
