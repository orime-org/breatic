// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

const preloadMatched = vi.fn();

vi.mock('@web/app/lazy-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/app/lazy-route')>()),
  preloadMatched,
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...real,
    createBrowserRouter: (...args: Parameters<typeof real.createBrowserRouter>) => {
      const router = real.createBrowserRouter(...args);
      return { ...router, subscribe: vi.fn(router.subscribe.bind(router)) };
    },
  };
});

describe('route table wiring', () => {
  beforeEach(() => {
    preloadMatched.mockClear();
    vi.resetModules();
  });

  it('asks for the matched branch as soon as the table is built', async () => {
    // The whole win of asking here is that it happens before `/auth/me`
    // answers. `preloadMatched` has cases of its own; this pins the one call
    // that delivers them, which is otherwise removable without a red test.
    const { router } = await import('@web/app/routes');

    expect(preloadMatched).toHaveBeenCalledWith(router.state.matches, false);
  });

  it('asks again once a redirect has settled on a destination', async () => {
    // `/` and any unknown address match a `<Navigate>`, which carries no page,
    // so the call above finds nothing to start. Typing the bare domain is the
    // commonest cold entry there is, and without a second ask it pays the auth
    // ping and the page chunk one after the other.
    //
    // The subscriber is driven directly rather than by navigating: a
    // data-router navigation builds a `Request` from a jsdom `AbortSignal`,
    // which undici rejects, so no navigation completes under vitest. The
    // on-screen half is smoke.
    const { router } = await import('@web/app/routes');
    const subscriber = vi.mocked(router.subscribe).mock.calls[0]?.[0];
    expect(subscriber).toBeTypeOf('function');
    preloadMatched.mockClear();

    const arrived = { matches: [{ route: { path: '/login' } }] };
    // The router hands its subscriber a second argument the subscriber here
    // does not read, so only the state is supplied.
    const ask = subscriber as unknown as (state: typeof arrived) => void;
    ask(arrived);

    expect(preloadMatched).toHaveBeenCalledWith(arrived.matches, false);
  });
});
