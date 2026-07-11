// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from 'sonner';

import { GeneratePanelContainer } from '@web/spaces/canvas/generate/GeneratePanelContainer';
import { modelsApi } from '@web/data/api';
import { useCanvasStore } from '@web/stores';

/**
 * Mounts the container under a fresh QueryClient (no retries — the failure
 * path resolves in one round trip).
 * @returns The render result.
 */
function mountContainer(): ReturnType<typeof render> {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ReactFlowProvider>
        <GeneratePanelContainer
          projectId='p'
          spaceId='s'
          nodes={[
            {
              id: 'target',
              data: { kind: 'image', status: 'idle' },
            },
          ]}
          edges={[]}
        />
      </ReactFlowProvider>
    </QueryClientProvider>,
  );
}

// Model-catalog failure gate (spec §9.3, user-ratified): a failed catalog
// fetch must EXPLAIN itself (toast) and not open the Generate panel — the old
// behavior silently rendered a dead panel (blank model pill, hidden ratio
// picker, permanently disabled execute) with zero feedback.
describe('GeneratePanelContainer — catalog failure gate', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    useCanvasStore.setState({
      generatePanelNodeId: null,
      referencePickForNodeId: null,
    });
  });

  it('on catalog fetch failure: toasts, closes the panel intent, renders nothing', async () => {
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockRejectedValue(new Error('boom'));
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target');
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
    expect(useCanvasStore.getState().generatePanelNodeId).toBeNull();
    expect(
      screen.queryByTestId('generate-prompt-editor'),
    ).not.toBeInTheDocument();
    listSpy.mockRestore();
  });
});
