// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('NodeHistoryPanelContainer loading UX — C hybrid (#1812, user 2026-07-22)', () => {
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

  it('stays hidden during the grace window, then shows a skeleton while the first page keeps loading', async () => {
    // A never-resolving fetch keeps the query pending (isPending).
    vi.mocked(canvasApi.listNodeHistory).mockReturnValue(
      new Promise<never>(() => {}),
    );
    mount();
    act(() => {
      useCanvasStore.getState().openHistoryPanel('target');
    });
    // Grace window: synchronously after opening (t≈0, well under
    // SKELETON_DELAY_MS) nothing renders — no panel, no skeleton — so a fast
    // load never flashes a skeleton. Asserted with no wall-clock margin so a
    // loaded CI runner can't race the 250ms timer (Gate-2).
    expect(screen.queryByTestId('node-history-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('node-history-close')).not.toBeInTheDocument();
    // Still loading past the delay → the panel appears with a skeleton (slow
    // load gets feedback instead of an unresponsive dead click).
    await waitFor(() => {
      expect(screen.getByTestId('node-history-loading')).toBeInTheDocument();
    });
    expect(screen.getByTestId('node-history-close')).toBeInTheDocument();
    // a11y: the skeleton announces a busy/status region (Gate-2).
    expect(screen.getByTestId('node-history-loading')).toHaveAttribute(
      'role',
      'status',
    );
  });

  it('never shows a false empty while the first fetch is PAUSED (offline) — skeleton after the delay, real result once online (Gate-2)', async () => {
    onlineManager.setOnline(false);
    // The mock would resolve, but offline PAUSES the fetch → status='pending'
    // (isPending true, isLoading FALSE), data undefined. The empty state must
    // NEVER show while paused — a paused first fetch shows the skeleton, not a
    // false "No history yet".
    vi.mocked(canvasApi.listNodeHistory).mockResolvedValue({
      entries: [],
      total: 0,
    });
    mount();
    act(() => {
      useCanvasStore.getState().openHistoryPanel('target');
    });
    // Past the delay: a paused first fetch shows a skeleton, never the empty.
    await waitFor(() => {
      expect(screen.getByTestId('node-history-loading')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('node-history-empty')).not.toBeInTheDocument();
    // Reconnect → the paused fetch resumes → the real (empty) result renders,
    // proving the pause (not a broken mount) drove the skeleton above.
    act(() => {
      onlineManager.setOnline(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('node-history-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('node-history-loading')).not.toBeInTheDocument();
  });

  it('shows an in-panel error + retry on a first-page load error — NO toast, NO close (C hybrid)', async () => {
    vi.mocked(canvasApi.listNodeHistory).mockRejectedValue(new Error('boom'));
    mount();
    act(() => {
      useCanvasStore.getState().openHistoryPanel('target');
    });
    // The panel opens and shows the error in-panel with a retry button.
    await waitFor(() => {
      expect(screen.getByTestId('node-history-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('node-history-retry')).toBeInTheDocument();
    // a11y: the error is announced (role=alert), not silent (Gate-2).
    expect(screen.getByTestId('node-history-error')).toHaveAttribute(
      'role',
      'alert',
    );
    // Reverted from the toast+close behaviour: no toast, panel stays open.
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByTestId('node-history-close')).toBeInTheDocument();
    expect(useCanvasStore.getState().panelKind).toBe('history');
  });

  it('refetches when the in-panel retry button is clicked', async () => {
    // First call rejects (error state), the retry click triggers a 2nd call
    // that resolves with rows.
    vi.mocked(canvasApi.listNodeHistory)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ entries: [entry('a')], total: 1 });
    mount();
    act(() => {
      useCanvasStore.getState().openHistoryPanel('target');
    });
    await waitFor(() => {
      expect(screen.getByTestId('node-history-retry')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('node-history-retry'));
    await waitFor(() => {
      expect(canvasApi.listNodeHistory).toHaveBeenCalledTimes(2);
    });
    // The successful retry replaces the error with the rows.
    await waitFor(() => {
      expect(screen.getByTestId('node-history-row')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('node-history-error')).not.toBeInTheDocument();
  });

  it('renders the rows with NO skeleton flash when the first page loads fast', async () => {
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
    // A load that beats the delay never shows the skeleton.
    expect(screen.queryByTestId('node-history-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('node-history-error')).not.toBeInTheDocument();
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

  it('shows a skeleton IMMEDIATELY on a user retry — no grace vanish (#1812 B)', async () => {
    // First fetch errors; the retry's fetch never resolves → the retry stays
    // loading. query-core 5.96 resets a NO-DATA errored query to
    // status='pending' on refetch (query.js reducer: `data === undefined →
    // { error: null, status: 'pending' }`), so the retry re-enters the loading
    // path. `retryRequested` makes it show the skeleton at once (B), instead of
    // the panel vanishing for the 250ms grace window (A).
    vi.mocked(canvasApi.listNodeHistory)
      .mockRejectedValueOnce(new Error('boom'))
      .mockReturnValue(new Promise<never>(() => {}));
    mount();
    act(() => {
      useCanvasStore.getState().openHistoryPanel('target');
    });
    await waitFor(() => {
      expect(screen.getByTestId('node-history-retry')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('node-history-retry'));

    // Flush the refetch's state propagation (isPending → true) via act, with NO
    // wall-clock elapsed — the 250ms grace timer therefore cannot have fired, so
    // a skeleton here is purely from `retryRequested` (B), deterministically
    // (not a timer race — Gate-2 r2). Under the grace-only path (A) the panel
    // would still be null here — this distinguishes B from A without the clock.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('node-history-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('node-history-error')).not.toBeInTheDocument();
  });

  it('gives a fresh grace window when the panel switches to another still-loading node (#1812 Gate-2)', async () => {
    // Both nodes never resolve → both stay pending (isPending true throughout).
    vi.mocked(canvasApi.listNodeHistory).mockReturnValue(
      new Promise<never>(() => {}),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const twoNodes = [
      { id: 'A', type: 'image', data: { content: 'a.png' } },
      { id: 'B', type: 'image', data: { content: 'b.png' } },
    ] as unknown as React.ComponentProps<
      typeof NodeHistoryPanelContainer
    >['nodes'];
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ReactFlow
            nodes={[
              { id: 'A', position: { x: 0, y: 0 }, data: {} },
              { id: 'B', position: { x: 0, y: 0 }, data: {} },
            ]}
            edges={[]}
          >
            <NodeHistoryPanelContainer
              nodes={twoNodes}
              projectId='p'
              onRestore={vi.fn()}
            />
          </ReactFlow>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    // Open node A → still loading past the delay → skeleton shows (elapsed=true).
    act(() => {
      useCanvasStore.getState().openHistoryPanel('A');
    });
    await waitFor(() => {
      expect(screen.getByTestId('node-history-loading')).toBeInTheDocument();
    });
    // Switch the panel to node B (also still loading). `key={host}` remounts the
    // open panel → a FRESH grace window → the skeleton must NOT persist
    // immediately (B does not inherit A's elapsed skeleton).
    act(() => {
      useCanvasStore.getState().openHistoryPanel('B');
    });
    expect(screen.queryByTestId('node-history-loading')).not.toBeInTheDocument();
    // ...and once B's own grace elapses, its skeleton appears.
    await waitFor(() => {
      expect(screen.getByTestId('node-history-loading')).toBeInTheDocument();
    });
  });

  it('keeps the panel open with stale rows when a REFETCH fails after data loaded (Gate-2 invariant)', async () => {
    // First page resolves (panel shows), then a later refetch REJECTS. Because
    // the container gates the error state on isLoadingError (= isError &&
    // !hasData = false once data exists), NOT isError, the panel must STAY.
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
    // The panel stays open with its stale rows; no error state, no toast.
    expect(screen.getByTestId('node-history-close')).toBeInTheDocument();
    expect(screen.queryByTestId('node-history-error')).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panelKind).toBe('history');
  });
});
