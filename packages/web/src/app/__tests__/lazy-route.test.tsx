// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Replace `window.location.reload` with a spy for one test.
 * @returns The spy, which records each reload the code under test asks for.
 */
function watchReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    ...window.location,
    reload,
  } as unknown as Location);
  return reload;
}

/** A chunk that is no longer on the server. */
function missingChunk(): () => Promise<never> {
  return () =>
    Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
}

interface LazyRouteModule {
  /** Fetches one chunk, reloading the page once when it cannot be had. */
  fetchRouteChunk: <T>(load: () => Promise<T>) => Promise<T>;
  /** Wraps a page import in a lazy component carrying that recovery. */
  lazyRoute: (
    load: () => Promise<{ default: React.ComponentType<unknown> }>,
  ) => React.LazyExoticComponent<React.ComponentType<unknown>>;
}

/**
 * Load the module the way a freshly loaded document does.
 *
 * `vi.resetModules()` clears the registry, so anything the module kept in a
 * variable is gone — which is what a reload does to it. Every case that spans
 * a reload goes through here, because a guard that only holds inside one
 * document does not guard the loop worth stopping.
 * @returns The module's exports, freshly evaluated.
 */
async function freshDocument(): Promise<LazyRouteModule> {
  vi.resetModules();
  return (await import('@web/app/lazy-route')) as unknown as LazyRouteModule;
}

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-17T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fetchRouteChunk', () => {
  it('hands back the module when it arrives', async () => {
    const reload = watchReload();
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(() => Promise.resolve({ default: 'page' }))).resolves.toEqual({
      default: 'page',
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when a chunk cannot be fetched', async () => {
    const reload = watchReload();
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow(
      'Failed to fetch dynamically imported module',
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('stands down for the rest of the window, across the reload', async () => {
    // The reload replaces the document, so the record has to survive it. A
    // build that is genuinely broken fails again on the new document; reloading
    // for that one too is a loop the reader cannot leave or even see.
    const reload = watchReload();

    const before = await freshDocument();
    await expect(before.fetchRouteChunk(missingChunk())).rejects.toThrow();

    vi.advanceTimersByTime(1_000);
    const after = await freshDocument();
    await expect(after.fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('allows another reload once the window has passed', async () => {
    // A chunk that failed on a flaky connection must not cost the reader the
    // recovery for a deploy that happens later in the same tab.
    const reload = watchReload();

    const flaky = await freshDocument();
    await expect(flaky.fetchRouteChunk(missingChunk())).rejects.toThrow();

    vi.advanceTimersByTime(30_000);
    const deployed = await freshDocument();
    await expect(deployed.fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload at all when the session store is unreachable', async () => {
    // With nowhere to record the reload, nothing can stop the next document
    // from reloading again. The error reaches the reader instead, and a
    // refresh is theirs to make.
    const reload = watchReload();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when the record cannot be written', async () => {
    const reload = watchReload();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).not.toHaveBeenCalled();
  });

  it('treats an unreadable record as no record', async () => {
    const reload = watchReload();
    sessionStorage.setItem('breatic.chunkReload', 'not-a-time');
    const { fetchRouteChunk } = await freshDocument();

    await expect(fetchRouteChunk(missingChunk())).rejects.toThrow();

    expect(reload).toHaveBeenCalledTimes(1);
  });
});

interface BoundaryProps {
  /** The tree to render, and to replace with nothing when it throws. */
  children: React.ReactNode;
}

/** Catches the render error a failed chunk produces, so the test can assert on the reload. */
class Boundary extends React.Component<BoundaryProps, { failed: boolean }> {
  /**
   * @param props - The component props.
   */
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  /**
   * @returns The state that records the failure.
   */
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  /**
   * @returns The children, or the failure marker once one of them threw.
   */
  override render(): React.ReactNode {
    return this.state.failed
      ? React.createElement('div', { 'data-testid': 'boundary' })
      : this.props.children;
  }
}

describe('lazyRoute', () => {
  it('carries the recovery into the component it returns', async () => {
    // `lazyRoute` is what the route table calls, and a version of it that
    // skipped `fetchRouteChunk` would look identical there. This drives the
    // component itself rather than the helper behind it.
    vi.useRealTimers();
    const reload = watchReload();
    const { lazyRoute } = await freshDocument();
    const Page = lazyRoute(missingChunk());

    render(
      React.createElement(
        Boundary,
        null,
        React.createElement(React.Suspense, { fallback: null }, React.createElement(Page)),
      ),
    );

    expect(await screen.findByTestId('boundary')).toBeInTheDocument();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
