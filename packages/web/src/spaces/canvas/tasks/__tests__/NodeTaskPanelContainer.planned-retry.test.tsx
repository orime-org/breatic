// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 frames-split design §10.8 retry row: the task row of a failed output node of a planned run (here a split)
 * offers Retry; the retry names the original run and that node's own output index, read from the run's outputs by
 * node id, and goes through `miniToolsApi.retryPlannedVideoRun` to the existing retry admission.
 *
 * The request layer (`apiGet`, `apiPost`) is mocked and answers the task list and the run; translation is real.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type NodeTaskEntry } from '@breatic/shared';
import { miniToolExecutionRequestSchema, type MiniToolExecutionRecord } from '@breatic/shared/mini-tools';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), apiGet: http.get, apiPost: http.post }));
vi.mock('@web/data/api/credits', () => ({ noteCreditsChanged: vi.fn() }));
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
const FIRST = '30000000-0000-4000-8000-000000000001';
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
 * The split run: its first segment failed on another node, the second on this one, or still pending while it runs.
 * @param failed - Whether this node's output failed.
 * @param takenOver - Whether an admitted retry has taken this node's failed output over.
 * @returns The record.
 */
function record(failed = true, takenOver = false): MiniToolExecutionRecord {
  return { schemaVersion: 1, runId: RUN, status: 'failed', planFingerprint: 'a'.repeat(64), resultVersion: 1,
    sourceBindings: [{ assetId: '80000000-0000-4000-8000-000000000001', contentHash: 'b'.repeat(64), canonicalURL: 'https://assets.example.test/video/source.mp4', kind: 'video', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } }],
    outputs: [
      { outputIndex: 0, nodeId: FIRST, recipe: { kind: 'segment', range: { start: 0, end: 2 } }, late: false, result: { status: 'failed', error: { code: 'mini_tool_failed' } } },
      { outputIndex: 1, nodeId: OUTPUT, recipe: { kind: 'segment', range: { start: 2, end: 5 } }, late: false, result: failed ? { status: 'failed', error: { code: 'mini_tool_failed' } } : null, takenOver },
    ],
    usage: [], billingState: failed ? 'settled' : 'idle', error: failed ? { code: 'mini_tool_failed' } : null, ...(failed ? {} : { status: 'running' }) };
}

/**
 * Answers the output node's task list and its run.
 * @param failed - Whether this node's output failed.
 * @param takenOver - Whether an admitted retry has taken this node's failed output over.
 * @returns Nothing.
 */
function serve(failed = true, takenOver = false): void {
  http.get.mockImplementation(async (path: string): Promise<unknown> => {
    if (path === `/canvas/nodes/${OUTPUT}/tasks`) return { tasks: [row()] };
    if (path === `/projects/${PROJECT}/mini-tool-runs/${RUN}`) return record(failed, takenOver);
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

describe('a failed planned output node retries its own output (frames-split §10.8 retry row)', () => {
  it('offers Retry on the failed row and sends the original run with this node\'s output index', async () => {
    serve();
    http.post.mockResolvedValue({ task_id: '60000000-0000-4000-8000-000000000001', status: 'pending' });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: t('canvas.task.action.retry') }));
    await waitFor(() => expect(http.post).toHaveBeenCalledOnce());
    const [path, body] = http.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/mini-tools');
    expect(body).toMatchObject({ tool: 'video.split', project_id: PROJECT, space_id: SPACE, retry: { runId: RUN, outputIndexes: [1] } });
    expect(body.run_id).not.toBe(RUN);
    expect(miniToolExecutionRequestSchema.safeParse(body).success).toBe(true);
  });

  // frames-split §7.15 可重试结束: a failed output an admitted retry took over accepts no further retry; the next one starts
  // from the run that took it over.
  it('offers no Retry on the old failed row once a retry has taken its output over', async () => {
    serve(true, true);
    mount();
    await screen.findByTestId('node-task-row');
    await waitFor(() => expect(http.get).toHaveBeenCalledWith(`/projects/${PROJECT}/mini-tool-runs/${RUN}`));
    await waitFor(() => expect(client.getQueryState(['mini-tool-run', PROJECT, RUN])?.status).toBe('success'));
    expect(screen.queryByRole('button', { name: t('canvas.task.action.retry') })).toBeNull();
  });

  it('offers no Retry while the run has no failed output on this node', async () => {
    serve(false);
    mount();
    await screen.findByTestId('node-task-row');
    await waitFor(() => expect(http.get).toHaveBeenCalledWith(`/projects/${PROJECT}/mini-tool-runs/${RUN}`));
    expect(screen.queryByRole('button', { name: t('canvas.task.action.retry') })).toBeNull();
  });
});
