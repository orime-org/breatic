// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The 3D and Motion settings read (`GET /projects/:id/three-d/config`) has one hook: it waits until the signed-in user
 * is known, and every caller for the same Project and user shares one cached read.
 */

import * as React from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiGet } from '@web/data/api/request';
import type * as RequestModule from '@web/data/api/request';
import { useSceneControls } from '@web/data/api/use-scene-controls';

vi.mock('@web/data/api/request', async (importOriginal) => ({ ...await importOriginal<typeof RequestModule>(), apiGet: vi.fn() }));

const CONTROLS = { scaleSensitivity: 1 };

afterEach(() => {
  cleanup();
  vi.mocked(apiGet).mockReset();
});

/**
 * A wrapper with a fresh query client.
 * @returns The wrapper.
 */
function wrapper(): React.FC<{ children: React.ReactNode }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useSceneControls', () => {
  it('reads nothing until the user is known', async () => {
    vi.mocked(apiGet).mockResolvedValue(CONTROLS);
    const { result } = renderHook(() => useSceneControls('p1', undefined), { wrapper: wrapper() });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(apiGet).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(true);
  });

  it('reads the Project\'s settings once for every caller of the same Project and user', async () => {
    vi.mocked(apiGet).mockResolvedValue(CONTROLS);
    const { result } = renderHook(() => [useSceneControls('p1', 'u1'), useSceneControls('p1', 'u1')] as const, { wrapper: wrapper() });
    await waitFor(() => expect(result.current[1].data).toEqual(CONTROLS));
    expect(result.current[0].data).toEqual(CONTROLS);
    expect(apiGet).toHaveBeenCalledOnce();
    expect(vi.mocked(apiGet).mock.calls[0]?.[0]).toBe('/projects/p1/three-d/config');
  });
});
