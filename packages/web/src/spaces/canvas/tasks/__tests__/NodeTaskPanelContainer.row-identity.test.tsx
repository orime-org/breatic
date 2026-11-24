// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** The task panel's rows of a planned run keep their own identities, with controlled HTTP IO (frames-split §7.19). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeTaskEntry } from '@breatic/shared';

vi.mock('@web/data/api/canvas', () => ({ canvasApi: { listNodeTasks: vi.fn(), dismissNodeTask: vi.fn() }, getCachedUnderstandMaxBytes: vi.fn(() => null) }));
vi.mock('@web/data/api/request', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), runOnceRequest: vi.fn() }));
vi.mock('@web/data/api/credits', () => ({ noteCreditsChanged: vi.fn() }));
vi.mock('@web/spaces/canvas/generate/model-catalog-query', () => ({ modelCatalogQuery: () => ({ queryKey: ['fixture-catalog'], queryFn: async () => ({ image: [], video: [], audio: [], tts: [], three_d: [] }) }) }));
vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@web/i18n/use-translation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@web/spaces/canvas/tasks/use-ticking-clock', () => ({ useTickingClock: () => 1_793_001_600_000 }));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { canvasApi } from '@web/data/api/canvas';
import { NodeTaskPanelContainer } from '@web/spaces/canvas/tasks/NodeTaskPanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';
import { useTaskActionsInFlight } from '@web/stores/task-actions-in-flight';
import { resetRetryFilesForTests, stashRetryFile } from '@web/spaces/canvas/upload-retry-files';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const SPACE = '20000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000001';
const ROW = '40000000-0000-4000-8000-000000000001';
const RUN = '50000000-0000-4000-8000-000000000001';
const WINNER = 'https://assets.example.test/video/winner.webm';
type Nodes = React.ComponentProps<typeof NodeTaskPanelContainer>['nodes'];
type OnRetry = React.ComponentProps<typeof NodeTaskPanelContainer>['onRetry'];
type CompatibleRow = NodeTaskEntry & { taskId: string | null };
let client: QueryClient;

/** A public row retains its own identity independently from the accepted parent.
 * @throws {never} Never.
 */
function row(patch: Partial<CompatibleRow> = {}): CompatibleRow {
  return { id: ROW, taskId: RUN, projectId: PROJECT, spaceId: SPACE, nodeId: NODE, kind: 'generation', action: 'mini_tool', label: 'video.split', status: 'done', startedByUserId: 'reader', startedAt: '2026-10-26T00:00:00.000Z', settledAt: '2026-10-26T00:00:01.000Z', budgetMs: 7_200_000,
    errorMessage: null, nodeHistoryId: null, content: null, coverUrl: null, mediaWidth: null, mediaHeight: null, duration: null, mimeType: null, size: null, ...patch };
}
/** Supply the real view-layer node shape, with current user content independent from the restored result.
 * @throws {never} Never.
 */
function nodes(done = 1, id = NODE): Nodes {
  return [{ id, type: 'video', data: { handling: false, content: 'https://assets.example.test/video/user-current.mp4', taskCounts: { running: 0, done, failed: 0, expired: 0 } } }];
}
/** Mount the actual panel container inside its existing ReactFlow and query providers.
 * @throws {Error} On render failures.
 */
function tree(hostNodes: Nodes = nodes(), projectId = PROJECT, onRetry: OnRetry = vi.fn()): React.JSX.Element {
  return <QueryClientProvider client={client}><TooltipProvider><ReactFlow nodes={hostNodes.map((n) => ({ id: n.id, position: { x: 0, y: 0 }, data: {} }))} edges={[]}>
    <NodeTaskPanelContainer nodes={hostNodes} projectId={projectId} spaceId={SPACE} readOnly={false} onRetry={onRetry} />
  </ReactFlow></TooltipProvider></QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks(); resetRetryFilesForTests(); useTaskActionsInFlight.setState({ inFlight: new Set() });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  canvasSessions.of('').getState().openTaskPanel(NODE, 'done');
  vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([row()]);
  vi.mocked(canvasApi.dismissNodeTask).mockResolvedValue({ removed: true, counts: { running: 0, done: 0, failed: 0, expired: 0 } });
});
afterEach(() => { cleanup(); client.clear(); });

describe('node-task panel rows of a planned run (frames-split §7.19)', () => {
  it('N15 marking the settled row read still sends its row ID rather than the parent ID', async () => {
    render(tree()); fireEvent.click(await screen.findByTestId('task-action-finish'));
    await waitFor(() => expect(canvasApi.dismissNodeTask).toHaveBeenCalledWith(ROW, { projectId: PROJECT, spaceId: SPACE, nodeId: NODE }));
    expect(canvasApi.dismissNodeTask).not.toHaveBeenCalledWith(RUN, expect.anything());
  });
  it('N15 viewing a late result still opens its own history ID', async () => {
    const historyId = '60000000-0000-4000-8000-000000000001';
    vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([row({ status: 'expired', nodeHistoryId: historyId, content: WINNER })]);
    canvasSessions.of('').getState().openTaskPanel(NODE, 'expired'); render(tree()); fireEvent.click(await screen.findByTestId('task-action-view'));
    expect(canvasSessions.of('').getState()).toMatchObject({ panelHostId: NODE, panelKind: 'history', historyFocus: historyId });
  });
  it('N15 upload retry and stashed-file ownership stay keyed by the node-row ID', async () => {
    const retry = vi.fn(); vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([row({ status: 'failed', action: 'upload', label: 'clip.webm' })]);
    stashRetryFile(PROJECT, SPACE, ROW, new File(['clip'], 'clip.webm')); canvasSessions.of('').getState().openTaskPanel(NODE, 'failed'); render(tree(nodes(), PROJECT, retry));
    fireEvent.click(await screen.findByTestId('task-action-retry')); expect(retry).toHaveBeenCalledWith(NODE, ROW); expect(retry).not.toHaveBeenCalledWith(NODE, RUN);
  });
});
