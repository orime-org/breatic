// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/data/api/canvas', () => ({
  canvasApi: { listNodeHistory: vi.fn(), fetchLimits: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { canvasApi, type NodeHistoryEntry } from '@web/data/api/canvas';
import { toast } from '@web/lib/toast';
import { NodeHistoryPanelContainer } from '@web/spaces/canvas/history/NodeHistoryPanelContainer';
import { useCanvasStore } from '@web/stores/canvas';

// Minimal host-node view: the container only reads `type` + `data.content`.
const NODES = [
  { id: 'target', type: 'image', data: { content: 'x.png' } },
] as unknown as React.ComponentProps<
  typeof NodeHistoryPanelContainer
>['nodes'];

/**
 * Mount the container in a REAL ReactFlow (NodeToolbar renders its children only
 * when the host node exists in the flow) + a QueryClientProvider.
 * @returns The render result.
 */
function mount(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ReactFlow
          nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
          edges={[]}
        >
          <NodeHistoryPanelContainer
            nodes={NODES}
            projectId='p'
            onRestore={vi.fn()}
          />
        </ReactFlow>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/**
 * Builds a success generation entry fixture.
 * @param id - Entry id.
 * @returns A {@link NodeHistoryEntry}.
 */
function entry(id: string): NodeHistoryEntry {
  return {
    id,
    operatorName: null,
    entryType: 'generation',
    status: 'success',
    content: `${id}.png`,
    thumbnailUrl: null,
    errorMessage: null,
    metadata: {},
    createdAt: '2026-07-21T00:00:00.000Z',
  };
}

describe('NodeHistoryPanelContainer first-page gate (#1619, user 2026-07-22)', () => {
  beforeEach(() => {
    onlineManager.setOnline(true); // each test starts online (the paused test flips it)
    vi.clearAllMocks(); // reset call history between tests (mocks are module-level)
    vi.mocked(canvasApi.fetchLimits).mockResolvedValue({
      nodeHistoryPageSize: 20,
    } as never);
    vi.mocked(toast.error).mockReturnValue('t');
    useCanvasStore.setState({
      panelHostId: null,
      panelKind: null,
      pickSession: null,
    });
  });

  it('renders NOTHING while the first page loads — no skeleton, no panel', async () => {
    // A never-resolving fetch keeps the query pending (isLoading).
    vi.mocked(canvasApi.listNodeHistory).mockReturnValue(
      new Promise<never>(() => {}),
    );
    mount();
    act(() => {
      useCanvasStore.getState().openHistoryPanel('target');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('node-history-close')).not.toBeInTheDocument();
    });
    // The old skeleton must be gone entirely (user 2026-07-22).
    expect(screen.queryByTestId('node-history-loading')).not.toBeInTheDocument();
  });

  it('renders nothing while the first fetch is PAUSED (offline), then the result once online (Gate-2)', async () => {
    onlineManager.setOnline(false);
    // The mock would resolve, but offline PAUSES the fetch → status='pending'
    // (isPending true, isLoading FALSE), data undefined. The pre-fix isLoading
    // gate fell through here to a false "No history yet" empty state.
    vi.mocked(canvasApi.listNodeHistory).mockResolvedValue({
      entries: [],
      total: 0,
    });
    mount();
    act(() => {
      useCanvasStore.getState().openHistoryPanel('target');
    });
    // Let effects flush; the fetch stays paused → the panel must NOT show.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId('node-history-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('node-history-close')).not.toBeInTheDocument();
    // Reconnect → the paused fetch resumes → the real (empty) result renders,
    // proving the pause (not a broken mount) hid the panel above.
    act(() => {
      onlineManager.setOnline(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('node-history-empty')).toBeInTheDocument();
    });
  });

  it('toasts + closes on a first-page load error — the panel never shows', async () => {
    vi.mocked(canvasApi.listNodeHistory).mockRejectedValue(new Error('boom'));
    mount();
    act(() => {
      useCanvasStore.getState().openHistoryPanel('target');
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('canvas.history.loadError');
    });
    expect(useCanvasStore.getState().panelKind).toBeNull();
    expect(screen.queryByTestId('node-history-close')).not.toBeInTheDocument();
  });

  it('renders the panel once the first page resolves with rows', async () => {
    vi.mocked(canvasApi.listNodeHistory).mockResolvedValue({
      entries: [entry('a'), entry('b')],
      total: 2,
    });
    mount();
    act(() => {
      useCanvasStore.getState().openHistoryPanel('target');
    });
    await waitFor(() => {
      expect(screen.getByTestId('node-history-close')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('node-history-row')).toHaveLength(2);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('renders the empty state when the first page resolves with 0 rows', async () => {
    vi.mocked(canvasApi.listNodeHistory).mockResolvedValue({
      entries: [],
      total: 0,
    });
    mount();
    act(() => {
      useCanvasStore.getState().openHistoryPanel('target');
    });
    await waitFor(() => {
      expect(screen.getByTestId('node-history-empty')).toBeInTheDocument();
    });
  });

  it('keeps the panel open with stale rows when a REFETCH fails after data loaded (Gate-2 invariant)', async () => {
    // First page resolves (panel shows), then a later refetch REJECTS. Because
    // the container gates on isLoadingError (= isError && !hasData = false once
    // data exists), NOT isError, the panel must STAY — no toast, no close.
    vi.mocked(canvasApi.listNodeHistory)
      .mockResolvedValueOnce({ entries: [entry('a')], total: 1 })
      .mockRejectedValue(new Error('refetch boom'));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (content: string): React.JSX.Element => (
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ReactFlow
            nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
            edges={[]}
          >
            <NodeHistoryPanelContainer
              nodes={
                [
                  { id: 'target', type: 'image', data: { content } },
                ] as unknown as React.ComponentProps<
                  typeof NodeHistoryPanelContainer
                >['nodes']
              }
              projectId='p'
              onRestore={vi.fn()}
            />
          </ReactFlow>
        </TooltipProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree('a.png'));
    act(() => {
      useCanvasStore.getState().openHistoryPanel('target');
    });
    await waitFor(() =>
      expect(screen.getByTestId('node-history-close')).toBeInTheDocument(),
    );
    // Change the node's content to a value NOT in the loaded rows → the
    // edge-triggered effect invalidates → refetch → the 2nd mock REJECTS.
    rerender(tree('changed.png'));
    await waitFor(() =>
      expect(canvasApi.listNodeHistory).toHaveBeenCalledTimes(2),
    );
    // The panel stays open with its stale rows; no error toast, no close.
    expect(screen.getByTestId('node-history-close')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panelKind).toBe('history');
  });
});
