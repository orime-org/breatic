// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));

const { uploadPicture } = vi.hoisted(() => ({ uploadPicture: vi.fn() }));
vi.mock('@web/pages/studio/shared/upload-picture', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  uploadPicture,
}));

const { setCover } = vi.hoisted(() => ({ setCover: vi.fn() }));
vi.mock('@web/data/api/projects', () => ({ projectsApi: { setCover } }));

import { useProjectCover } from '@web/pages/studio/container/cards/use-project-cover';
import { PictureUploadError } from '@web/pages/studio/shared/upload-picture';

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
  return renderHook(() => useProjectCover('p1', 'acme'), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useProjectCover', () => {
  it('uploads the crop as a cover, points the project at it, and refreshes both lists', async () => {
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['studio', 'acme', 'projects'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['studios', 'recent'] });
    expect(result.current.error).toBeNull();
  });

  it('says the storage is full when the account has no room, and leaves the cover alone', async () => {
    uploadPicture.mockRejectedValue(new PictureUploadError('storage'));
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
    uploadPicture.mockRejectedValue(new PictureUploadError('unsupportedType'));
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
});
