// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));

const { uploadPicture } = vi.hoisted(() => ({ uploadPicture: vi.fn() }));
vi.mock('@web/pages/studio/shared/upload-picture', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  uploadPicture,
}));

const { setCover } = vi.hoisted(() => ({ setCover: vi.fn() }));
vi.mock('@web/data/api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/projects')>()),
  projectsApi: { setCover },
}));

import { studioProjectsListKey } from '@web/data/api/projects';
import { useProjectCover } from '@web/pages/studio/container/cards/use-project-cover';
import { UploadFailedError } from '@web/data/upload/media-upload';

let qc: QueryClient;

/**
 * Render the hook inside a query client.
 * @returns The hook's result handle.
 */
function setup(): ReturnType<typeof renderHook<ReturnType<typeof useProjectCover>, unknown>> {
  qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useProjectCover('p1'), { wrapper });
}

const LIVE = studioProjectsListKey('acme', { archived: false, sort: 'opened', locale: 'en' });
const ARCHIVED = studioProjectsListKey('acme', { archived: true, sort: 'archived', locale: 'en' });

/** One held studio list, as a case sees it. */
interface HeldList {
  read: () => Promise<string[]>;
  /** Answer the refetch that is out. */
  land: () => void;
  /** Whether a refetch is out. */
  started: () => boolean;
}

/**
 * A list read that answers its first read at once and holds every later one
 * until the case lands it.
 * @returns The read and its control.
 */
function heldList(): HeldList {
  let land: (() => void) | null = null;
  let reads = 0;
  return {
    read: (): Promise<string[]> => {
      reads += 1;
      return reads === 1
        ? Promise.resolve([])
        : new Promise((resolve) => {
          land = () => resolve([]);
        });
    },
    land: () => land?.(),
    started: () => land !== null,
  };
}

/**
 * Render the hook next to a mounted live list and archived list (an admin's
 * studio page), whose refetches the case lands by hand.
 * @returns The hook's result handle and the two lists.
 */
async function setupBesideHeldLists(): Promise<{
  result: { current: ReturnType<typeof useProjectCover> };
  live: HeldList;
  archived: HeldList;
}> {
  qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const live = heldList();
  const archived = heldList();
  /**
   * Keeps both lists mounted.
   * @returns Nothing visible.
   */
  function Lists(): React.JSX.Element {
    useQuery({ queryKey: LIVE, queryFn: live.read });
    useQuery({ queryKey: ARCHIVED, queryFn: archived.read });
    return <></>;
  }
  const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={qc}>
      <Lists />
      {children}
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useProjectCover('p1'), { wrapper });
  await waitFor(() => {
    expect(qc.getQueryState(LIVE)?.status).toBe('success');
    expect(qc.getQueryState(ARCHIVED)?.status).toBe('success');
  });
  return { result, live, archived };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useProjectCover', () => {
  it('uploads the crop as a cover, points the project at it, and refreshes every listing', async () => {
    uploadPicture.mockResolvedValue('asset-1');
    setCover.mockResolvedValue({ id: 'p1' });
    const { result } = setup();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const blob = new Blob(['x'], { type: 'image/jpeg' });

    await act(async () => {
      result.current.upload(blob);
    });

    await waitFor(() => expect(setCover).toHaveBeenCalledWith('p1', 'asset-1'));
    expect(uploadPicture).toHaveBeenCalledWith(blob, {
      projectId: 'p1',
      purpose: 'project_cover',
    });
    await waitFor(() => expect(result.current.done).toBe(true));
    const studioList = invalidate.mock.calls.find(([filters]) => filters?.predicate);
    expect(
      studioList?.[0]?.predicate?.({ queryKey: studioProjectsListKey('acme', { archived: false, sort: 'opened', locale: 'en' }) } as never),
    ).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['studios', 'recent'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project', 'p1'] });
    expect(result.current.error).toBeNull();
  });

  it('says the storage is full when the account has no room, and leaves the cover alone', async () => {
    uploadPicture.mockRejectedValue(new UploadFailedError('storage'));
    const { result } = setup();

    await act(async () => {
      result.current.upload(new Blob(['x'], { type: 'image/jpeg' }));
    });

    await waitFor(() =>
      expect(result.current.error).toBe('studio.container.cover.error.storage'),
    );
    expect(setCover).not.toHaveBeenCalled();
  });

  it('says the format is not taken when the edge refused the bytes', async () => {
    uploadPicture.mockRejectedValue(new UploadFailedError('unsupportedType'));
    const { result } = setup();

    await act(async () => {
      result.current.upload(new Blob(['x'], { type: 'image/jpeg' }));
    });

    await waitFor(() =>
      expect(result.current.error).toBe('studio.container.imageError.unsupported_type'),
    );
  });

  it('asks for a retry on any other failure, including pointing at the row', async () => {
    uploadPicture.mockResolvedValue('asset-1');
    setCover.mockRejectedValue(new Error('network'));
    const { result } = setup();

    await act(async () => {
      result.current.upload(new Blob(['x'], { type: 'image/jpeg' }));
    });

    await waitFor(() =>
      expect(result.current.error).toBe('studio.container.cover.error.upload'),
    );
  });

  it('stays uploading until the live list refetch shows the new cover', async () => {
    uploadPicture.mockResolvedValue('asset-1');
    setCover.mockResolvedValue({ id: 'p1' });
    const { result, live, archived } = await setupBesideHeldLists();

    act(() => result.current.upload(new Blob(['x'], { type: 'image/jpeg' })));

    await waitFor(() => expect(live.started() && archived.started()).toBe(true));
    await act(async () => archived.land());
    expect(result.current.uploading).toBe(true);
    expect(result.current.done).toBe(false);
    live.land();
    await waitFor(() => expect(result.current.done).toBe(true));
  });

  it('is done once the live list lands, without waiting for the archived list', async () => {
    uploadPicture.mockResolvedValue('asset-1');
    setCover.mockResolvedValue({ id: 'p1' });
    const { result, live, archived } = await setupBesideHeldLists();

    act(() => result.current.upload(new Blob(['x'], { type: 'image/jpeg' })));

    await waitFor(() => expect(live.started() && archived.started()).toBe(true));
    live.land();
    await waitFor(() => expect(result.current.done).toBe(true));
  });
});
