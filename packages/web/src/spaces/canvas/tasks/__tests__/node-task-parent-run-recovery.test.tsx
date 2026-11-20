// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** Original open-panel/query boundary with controlled HTTP IO; SQL durability is covered in the real server suite. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeTaskEntry } from '@breatic/shared';
import { miniToolExecutionRecordSchema, type MiniToolExecutionRecord } from '@breatic/shared/mini-tools';

vi.mock('@web/data/api/canvas', () => ({ canvasApi: { listNodeTasks: vi.fn(), dismissNodeTask: vi.fn() }, getCachedUnderstandMaxBytes: vi.fn(() => null) }));
vi.mock('@web/data/api/request', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), runOnceRequest: vi.fn() }));
vi.mock('@web/data/api/credits', () => ({ noteCreditsChanged: vi.fn() }));
vi.mock('@web/spaces/canvas/generate/model-catalog-query', () => ({ modelCatalogQuery: () => ({ queryKey: ['fixture-catalog'], queryFn: async () => ({ image: [], video: [], audio: [], tts: [], three_d: [] }) }) }));
vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@web/i18n/use-translation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@web/spaces/canvas/tasks/use-ticking-clock', () => ({ useTickingClock: () => 1_793_001_600_000 }));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { canvasApi } from '@web/data/api/canvas';
import { apiGet, apiPost } from '@web/data/api/request';
import { NodeTaskPanelContainer } from '@web/spaces/canvas/tasks/NodeTaskPanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';
import { useTaskActionsInFlight } from '@web/stores/task-actions-in-flight';
import { resetRetryFilesForTests, stashRetryFile } from '@web/spaces/canvas/upload-retry-files';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const SPACE = '20000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000001';
const ROW = '40000000-0000-4000-8000-000000000001';
const RUN = '50000000-0000-4000-8000-000000000001';
const OTHER_RUN = '50000000-0000-4000-8000-000000000002';
const OTHER_ROW = '40000000-0000-4000-8000-000000000002';
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
/** Literal independent public record; source and output duration deliberately differ.
 * @throws {never} Never.
 */
function record(runId = RUN, version = 1): MiniToolExecutionRecord {
  return { schemaVersion: 1, runId, status: 'completed', planFingerprint: 'a'.repeat(64), resultVersion: version,
    sourceBindings: [{ assetId: '80000000-0000-4000-8000-000000000001', contentHash: 'b'.repeat(64), canonicalURL: 'https://assets.example.test/video/source.mp4', kind: 'video', mediaInfo: { width: 960, height: 540, duration: 5.055, mimeType: 'video/mp4' } }],
    outputs: [{ outputIndex: 0, nodeId: NODE, recipe: { kind: 'segment', range: { start: 0, end: 30 } }, late: false, result: { status: 'registered', assetId: '90000000-0000-4000-8000-000000000001', canonicalURL: WINNER, kind: 'video', mimeType: 'video/webm', size: 1588436, contentHash: 'c'.repeat(64), width: 960, height: 540, duration: 5.013, cover: null } }],
    usage: [{ consumptionKey: 'd'.repeat(64), state: 'pending', chargeTo: 'user', costUsd: null, credits: null }], billingState: 'waiting', error: null };
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
/** Inspect only validated execution data held by the actual QueryClient, without prescribing a new cache-key spelling.
 * @throws {never} Never.
 */
function cached(runId: string): MiniToolExecutionRecord | undefined {
  for (const query of client.getQueryCache().getAll()) {
    const parsed = miniToolExecutionRecordSchema.safeParse(query.state.data);
    if (parsed.success && parsed.data.runId === runId) return parsed.data;
  }
  return undefined;
}
/** List only the project-scoped run requests; other existing API reads cannot satisfy these assertions.
 * @throws {never} Never.
 */
function runPaths(): string[] {
  return vi.mocked(apiGet).mock.calls.map(([path]) => path).filter((path) => path.includes('/mini-tool-runs/'));
}

beforeEach(() => {
  vi.clearAllMocks(); resetRetryFilesForTests(); useTaskActionsInFlight.setState({ inFlight: new Set() });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  canvasSessions.of('').getState().openTaskPanel(NODE, 'done');
  vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([row()]);
  vi.mocked(canvasApi.dismissNodeTask).mockResolvedValue({ removed: true, counts: { running: 0, done: 0, failed: 0, expired: 0 } });
  vi.mocked(apiGet).mockResolvedValue(record());
});
afterEach(() => { cleanup(); client.clear(); });

describe('original node-task panel parent-run recovery', () => {
  it('N12 a fresh query client discovers the original parent and caches the complete typed record', async () => {
    expect(client.getQueryCache().getAll()).toHaveLength(0); render(tree());
    await waitFor(() => expect(runPaths()).toEqual([`/projects/${PROJECT}/mini-tool-runs/${RUN}`]));
    await waitFor(() => expect(cached(RUN)).toEqual(record()));
    expect(apiPost).not.toHaveBeenCalled();
  });
  it('N13 repeated reads keep current node content and the original list/history fields unchanged', async () => {
    const held = nodes(); const before = structuredClone(held); const entry = row({ content: 'https://assets.example.test/video/history.webm' });
    vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([entry]); const view = render(tree(held));
    await waitFor(() => expect(cached(RUN)?.outputs).toEqual(record().outputs));
    view.unmount(); render(tree(held)); await waitFor(() => expect(runPaths()).toHaveLength(2));
    expect(held).toEqual(before); expect(entry.content).toBe('https://assets.example.test/video/history.webm'); expect(apiPost).not.toHaveBeenCalled();
  });
  it('N18 uses the existing planned labels, skips unrelated/missing parents and deduplicates the original run ID', async () => {
    const labels = ['video.extract-frames', 'video.split'];
    const rows = labels.map((label, i) => row({ id: `planned-${i}`, label, taskId: RUN }));
    rows.push(row({ id: 'generate', action: 'generate', taskId: OTHER_RUN }), row({ id: 'legacy', label: 'video.upscale', taskId: OTHER_RUN }), row({ id: 'no-parent', taskId: null }));
    vi.mocked(canvasApi.listNodeTasks).mockResolvedValue(rows); render(tree(nodes(rows.length)));
    await waitFor(() => expect(runPaths()).toEqual([`/projects/${PROJECT}/mini-tool-runs/${RUN}`]));
    expect(apiPost).not.toHaveBeenCalled();
  });
  it.each([null, undefined])('N04 tolerates an older missing/null parent without inventing a run from the row ID (%s)', async (taskId) => {
    const entry: Omit<CompatibleRow, 'taskId'> & { taskId?: string | null } = row(); entry.taskId = taskId; if (taskId === undefined) delete entry.taskId;
    // An older server's JSON omits the new field; its wire is intentionally older than the current static type.
    vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([entry as NodeTaskEntry]); render(tree());
    await screen.findByTestId('task-action-finish'); expect(runPaths()).toEqual([]); expect(apiPost).not.toHaveBeenCalled();
  });
  it('N03 a legacy mini-tool label without F keeps its row when the real project resource is 404', async () => {
    const { ApiException } = await import('@web/data/api/types'); vi.mocked(apiGet).mockRejectedValue(new ApiException({ status: 404, message: 'not found' })); render(tree());
    await waitFor(() => expect(runPaths()).toEqual([`/projects/${PROJECT}/mini-tool-runs/${RUN}`]));
    expect(await screen.findByTestId('task-action-finish')).toBeInTheDocument(); expect(cached(RUN)).toBeUndefined(); expect(apiPost).not.toHaveBeenCalled();
  });
  it('N05/N16 keeps two parents in independent query identities rather than a single latest-run slot', async () => {
    vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([row({ id: OTHER_ROW, taskId: OTHER_RUN }), row()]);
    vi.mocked(apiGet).mockImplementation(async (path) => path.endsWith(OTHER_RUN) ? record(OTHER_RUN, 2) : record()); render(tree(nodes(2)));
    await waitFor(() => expect(new Set(runPaths())).toEqual(new Set([`/projects/${PROJECT}/mini-tool-runs/${RUN}`, `/projects/${PROJECT}/mini-tool-runs/${OTHER_RUN}`])));
    await waitFor(() => { expect(cached(RUN)).toEqual(record()); expect(cached(OTHER_RUN)).toEqual(record(OTHER_RUN, 2)); });
  });
  it.each(['network', '500', 'invalid schema'])('N16 preserves one run error and another run success without substituting or resubmitting (%s)', async (failure) => {
    const { ApiException } = await import('@web/data/api/types');
    vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([row(), row({ id: OTHER_ROW, taskId: OTHER_RUN })]);
    vi.mocked(apiGet).mockImplementation(async (path) => {
      if (path.endsWith(OTHER_RUN)) return record(OTHER_RUN);
      if (failure === 'invalid schema') return { ...record(), outputs: [] };
      throw new ApiException({ status: failure === '500' ? 500 : 0, message: 'fixture read failure', network: failure === 'network' });
    });
    render(tree(nodes(2))); await waitFor(() => expect(runPaths()).toHaveLength(2));
    await waitFor(() => expect(cached(OTHER_RUN)).toEqual(record(OTHER_RUN)));
    expect(cached(RUN)).toBeUndefined();
    await waitFor(() => expect(client.getQueryCache().getAll().filter((q) => q.state.status === 'error')).toHaveLength(1));
    expect(await screen.findAllByTestId('task-action-finish')).toHaveLength(2); expect(apiPost).not.toHaveBeenCalled();
  });
  it('N17 reopening the original panel refetches the parent even within the normal query stale window', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce(record(RUN, 1)).mockResolvedValueOnce(record(RUN, 2)); const view = render(tree());
    await waitFor(() => expect(cached(RUN)?.resultVersion).toBe(1)); view.unmount(); render(tree());
    await waitFor(() => expect(runPaths()).toHaveLength(2)); await waitFor(() => expect(cached(RUN)?.resultVersion).toBe(2));
    expect(apiPost).not.toHaveBeenCalled();
  });
  it('N17 counts changes reread the current original parent rather than preserve an obsolete cached bill', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce(record()).mockResolvedValueOnce({ ...record(), usage: [{ consumptionKey: 'd'.repeat(64), state: 'recorded', chargeTo: 'user', costUsd: 0.3, credits: 30 }], billingState: 'settled' });
    const view = render(tree()); await waitFor(() => expect(cached(RUN)?.billingState).toBe('waiting')); view.rerender(tree(nodes(2)));
    await waitFor(() => expect(runPaths()).toHaveLength(2)); await waitFor(() => expect(cached(RUN)?.billingState).toBe('settled'));
  });
  it('N17 the existing list-error reload also rereads the recovered parent cache', async () => {
    const view = render(tree()); await waitFor(() => expect(cached(RUN)?.resultVersion).toBe(1));
    vi.mocked(canvasApi.listNodeTasks).mockRejectedValueOnce(new Error('fixture list read failure')); view.rerender(tree(nodes(2)));
    const reload = await screen.findByTestId('node-task-panel-reload'); vi.mocked(apiGet).mockResolvedValue(record(RUN, 2)); fireEvent.click(reload);
    await waitFor(() => expect(cached(RUN)?.resultVersion).toBe(2)); expect(apiPost).not.toHaveBeenCalled();
  });
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
  it('N16 switching host reads that host row parent into its own cache entry', async () => {
    const view = render(tree()); await waitFor(() => expect(cached(RUN)).toEqual(record()));
    const otherNode = '30000000-0000-4000-8000-000000000002'; vi.mocked(canvasApi.listNodeTasks).mockResolvedValue([row({ id: OTHER_ROW, nodeId: otherNode, taskId: OTHER_RUN })]); vi.mocked(apiGet).mockResolvedValue(record(OTHER_RUN));
    await act(async () => { canvasSessions.of('').getState().openTaskPanel(otherNode, 'done'); }); view.rerender(tree(nodes(1, otherNode)));
    await waitFor(() => expect(canvasApi.listNodeTasks).toHaveBeenLastCalledWith(otherNode, PROJECT, SPACE));
    await waitFor(() => expect(runPaths()).toContain(`/projects/${PROJECT}/mini-tool-runs/${OTHER_RUN}`)); await waitFor(() => expect(cached(OTHER_RUN)).toEqual(record(OTHER_RUN)));
    expect(apiPost).not.toHaveBeenCalled();
  });
});
