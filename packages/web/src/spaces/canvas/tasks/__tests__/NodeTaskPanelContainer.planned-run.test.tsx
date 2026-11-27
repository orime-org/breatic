// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1306 frames-split design §7.19: a planned run (here a split) is rerun only as a whole, from its tool's panel, so the
 * task row of its failed output node offers only Clear, never Retry.
 *
 * The request layer (`apiGet`, `apiPost`) is mocked and answers the task list; translation is real.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type NodeTaskEntry } from '@breatic/shared';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), apiGet: http.get, apiPost: http.post }));
vi.mock('@web/spaces/canvas/generate/model-catalog-query', () => ({ modelCatalogQuery: () => ({ queryKey: ['fixture-catalog'], queryFn: async () => ({ image: [], video: [], audio: [], tts: [], three_d: [] }) }) }));
vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@web/spaces/canvas/tasks/use-ticking-clock', () => ({ useTickingClock: () => 1_793_001_600_000 }));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { NodeTaskPanelContainer } from '@web/spaces/canvas/tasks/NodeTaskPanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';
import { resetRunOnceForTests, useTaskActionsInFlight } from '@web/stores/task-actions-in-flight';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const SPACE = '20000000-0000-4000-8000-000000000001';
const OUTPUT = '30000000-0000-4000-8000-000000000002';
const RUN = '50000000-0000-4000-8000-000000000001';
type Nodes = React.ComponentProps<typeof NodeTaskPanelContainer>['nodes'];
let client: QueryClient;

/**
 * The output node's failed split task row, pointing at its parent run.
 * @returns The row.
 */
function row(): NodeTaskEntry {
  return { id: '40000000-0000-4000-8000-000000000001', taskId: RUN, projectId: PROJECT, spaceId: SPACE, nodeId: OUTPUT, kind: 'generation', action: 'mini_tool', label: 'video.split', status: 'failed', startedByUserId: 'reader',
    startedAt: '2026-10-26T00:00:00.000Z', settledAt: '2026-10-26T00:00:01.000Z', budgetMs: 7_200_000, errorMessage: 'Split failed', nodeHistoryId: null, content: null, coverUrl: null, mediaWidth: null, mediaHeight: null, duration: null, mimeType: null, size: null };
}

/**
 * Answers the output node's task list.
 * @returns Nothing.
 */
function serve(): void {
  http.get.mockImplementation(async (path: string): Promise<unknown> => {
    if (path === `/canvas/nodes/${OUTPUT}/tasks`) return { tasks: [row()] };
    throw new Error(`Unexpected GET ${path}`);
  });
}

/**
 * Mounts the output node's open failed-task list inside its ReactFlow and query providers.
 * @returns Nothing.
 */
function mount(): void {
  const nodes: Nodes = [{ id: OUTPUT, type: 'video', data: { handling: false, content: '', taskCounts: { running: 0, done: 0, failed: 1, expired: 0 } } }];
  render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId: PROJECT, spaceId: SPACE, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlow nodes={nodes.map((n) => ({ id: n.id, position: { x: 0, y: 0 }, data: {} }))} edges={[]}>
    <NodeTaskPanelContainer nodes={nodes} projectId={PROJECT} spaceId={SPACE} readOnly={false} onRetry={vi.fn()} />
  </ReactFlow></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks(); useTaskActionsInFlight.setState({ inFlight: new Set() });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  canvasSessions.of(SPACE).getState().openTaskPanel(OUTPUT, 'failed');
});
afterEach(() => { cleanup(); client.clear(); resetRunOnceForTests(); canvasSessions.of(SPACE).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('a failed planned output node is rerun only as a whole (frames-split §7.19)', () => {
  it('offers Clear and no Retry on the failed row', async () => {
    serve();
    mount();
    await screen.findByTestId('node-task-row');
    expect(await screen.findByRole('button', { name: t('canvas.task.action.clear') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('canvas.task.action.retry') })).toBeNull();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('pressing Clear sends no mini-tool request', async () => {
    serve();
    mount();
    fireEvent.click(await screen.findByRole('button', { name: t('canvas.task.action.clear') }));
    await waitFor(() => expect(http.post.mock.calls.every((call) => call[0] !== '/mini-tools')).toBe(true));
  });
});
