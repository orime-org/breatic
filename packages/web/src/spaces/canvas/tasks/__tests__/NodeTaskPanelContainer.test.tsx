// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The task list's own lifecycle (#186 §7.1).
 *
 * The list is one reader's fetch; the four counts beside it come off the canvas
 * document and move on their own. So the two can disagree, and what keeps them
 * from disagreeing on screen is when this panel asks again.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/data/api/canvas', () => ({
  canvasApi: { listNodeTasks: vi.fn(), dismissNodeTask: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { canvasApi } from '@web/data/api/canvas';
import { NodeTaskPanelContainer } from '@web/spaces/canvas/tasks/NodeTaskPanelContainer';
import { useCanvasStore } from '@web/stores/canvas';

type Nodes = React.ComponentProps<typeof NodeTaskPanelContainer>['nodes'];

/** The host node as the container reads it. */
function nodes(failed = 1): Nodes {
  return [
    {
      id: 'target',
      data: { taskCounts: { running: 0, done: 0, failed, expired: 0 } },
    },
  ] as unknown as Nodes;
}

/**
 * Mount the container in a real ReactFlow, with the app's own cache settings.
 *
 * `staleTime` matters here: the app sets 30 seconds
 * (`app/providers/QueryClientProvider.tsx`), which is long enough for a reader
 * to close this panel, watch a task finish, and open it again.
 * @param hostNodes - What the canvas holds.
 * @returns The render result, so a case can rerender with other nodes.
 */
let client: QueryClient;

function mount(hostNodes: Nodes = nodes()): ReturnType<typeof render> {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ReactFlow
          nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
          edges={[]}
        >
          <NodeTaskPanelContainer
            nodes={hostNodes}
            projectId='p'
            spaceId='s'
            readOnly={false}
            onReplace={vi.fn()}
            onRetry={vi.fn()}
          />
        </ReactFlow>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([]);
  useCanvasStore.getState().openTaskPanel('target', 'failed');
});

describe('NodeTaskPanelContainer', () => {
  it('closes when its host node disappears', async () => {
    const view = mount();
    await waitFor(() =>
      expect(useCanvasStore.getState().panelHostId).toBe('target'),
    );

    // A collaborator deleted the node this panel hangs on. Its three sibling
    // panels all close themselves here, and `resolvePanelSelectionAction`
    // leaves the case to them rather than acting on a host that is gone.
    view.rerender(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ReactFlow nodes={[]} edges={[]}>
            <NodeTaskPanelContainer
              nodes={[] as unknown as Nodes}
              projectId='p'
              spaceId='s'
              readOnly={false}
              onReplace={vi.fn()}
              onRetry={vi.fn()}
            />
          </ReactFlow>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(useCanvasStore.getState().panelHostId).toBeNull(),
    );
  });

  it('asks the server again when the node’s counts move', async () => {
    const view = mount(nodes(1));
    await waitFor(() =>
      expect(canvasApi.listNodeTasks).toHaveBeenCalledTimes(1),
    );

    // The task that was running finished: the server recounted and collab
    // wrote the new numbers onto the node. The rows this panel is showing
    // describe the state before that, down to a countdown still ticking on a
    // task that has ended.
    view.rerender(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ReactFlow
            nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
            edges={[]}
          >
            <NodeTaskPanelContainer
              nodes={nodes(2)}
              projectId='p'
              spaceId='s'
              readOnly={false}
              onReplace={vi.fn()}
              onRetry={vi.fn()}
            />
          </ReactFlow>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(canvasApi.listNodeTasks).toHaveBeenCalledTimes(2),
    );
  });
});
