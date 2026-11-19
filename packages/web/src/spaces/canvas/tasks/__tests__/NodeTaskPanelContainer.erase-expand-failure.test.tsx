// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 execution design §10.4, §10.5 failure tables and §10.8 copy rows: like a lip-sync output (the lip-sync failure
 * test), an erase or expand output node's failed task row shows the run's failure lines and offers "Retry failed items"
 * (`canvas.miniTool.videoUI.retryFailedItems`) only when shared `modelFailureRetryable` says the reason is retryable. An
 * erase shows its one step and category ("<step> · <category>" with `stepFail.<step>`) and its next step; an expand shows
 * one line per window ("Window N · <category>", `windowNumber`), a stopped window naming the window that stopped it
 * (`windowStoppedNext`). The model_output_mismatch category is `failOutputMismatch`; the next steps of an erase rejection
 * and mismatch are `eraseRejectedNext` and `eraseMismatchNext`, of an expand rejection `expandRejectedNext`.
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
const OUTPUT = '30000000-0000-4000-8000-000000000001';
const RUN = '50000000-0000-4000-8000-000000000001';
type Nodes = React.ComponentProps<typeof NodeTaskPanelContainer>['nodes'];
let client: QueryClient;

// The tool whose output node the case mounts.
const TOOL = { current: 'video.erase' as 'video.erase' | 'video.expand' };

/**
 * The output node's failed task row, pointing at its parent run.
 * @returns The row.
 */
function row(): NodeTaskEntry {
  return { id: '40000000-0000-4000-8000-000000000001', taskId: RUN, projectId: PROJECT, spaceId: SPACE, nodeId: OUTPUT, kind: 'generation', action: 'mini_tool', label: TOOL.current, status: 'failed', startedByUserId: 'user',
    startedAt: '2026-10-26T00:00:00.000Z', settledAt: '2026-10-26T00:00:01.000Z', budgetMs: 7_200_000, errorMessage: 'Lip sync failed', nodeHistoryId: null, content: null, coverUrl: null, mediaWidth: null, mediaHeight: null, duration: null, mimeType: null, size: null };
}

/**
 * The failed run; the reason is the failed output's error.
 * @param reason - The reason.
 * @param takenOver - Whether an admitted retry has taken the failed output over.
 * @returns The record.
 */
function record(reason: Record<string, unknown>, takenOver = false): MiniToolExecutionRecord {
  return { schemaVersion: 1, runId: RUN, status: 'failed', planFingerprint: 'a'.repeat(64), resultVersion: 1,
    sourceBindings: [{ assetId: '80000000-0000-4000-8000-000000000001', contentHash: 'b'.repeat(64), canonicalURL: 'https://assets.example.test/video/source.mp4', kind: 'video', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } }],
    outputs: [{ outputIndex: 0, nodeId: OUTPUT, recipe: { kind: TOOL.current === 'video.erase' ? 'erase' : 'expand' }, late: false, result: { status: 'failed', error: structuredClone(reason) as never }, takenOver }],
    usage: [], billingState: 'settled', error: { message: 'output failed' } };
}

/**
 * Answers the output node's task list and its run.
 * @param reason - The run's failure reason.
 * @param takenOver - Whether an admitted retry has taken the failed output over.
 * @returns Nothing.
 */
function serve(reason: Record<string, unknown>, takenOver = false): void {
  http.get.mockImplementation(async (path: string): Promise<unknown> => {
    if (path === `/canvas/nodes/${OUTPUT}/tasks`) return { tasks: [row()] };
    if (path === `/projects/${PROJECT}/mini-tool-runs/${RUN}`) return record(reason, takenOver);
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

/**
 * A `canvas.miniTool.videoUI.*` message in the active (English) locale.
 * @param key - The key under the video tool namespace.
 * @param params - Its ICU parameters.
 * @returns The message.
 */
function ui(key: string, params?: Record<string, string | number>): string {
  return t(`canvas.miniTool.videoUI.${key}`, params);
}

beforeEach(() => {
  vi.clearAllMocks(); useTaskActionsInFlight.setState({ inFlight: new Set() });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  canvasSessions.of(SPACE).getState().openTaskPanel(OUTPUT, 'failed');
});
afterEach(() => { cleanup(); client.clear(); resetRunOnceForTests(); canvasSessions.of(SPACE).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('erase and expand output nodes list their failure and retry what can be retried (execution design §10.4, §10.5)', () => {
  it.each([
    ['generate', 'model_rejected', 'personFailRejected', 'eraseRejectedNext', false],
    ['composite', 'model_output_mismatch', 'failOutputMismatch', 'eraseMismatchNext', false],
    ['mask', 'timeout', 'personFailTimeout', 'personFailRetryNext', true],
  ] as const)('an erase failing at %s with %s shows its step, category and next step; retry offered: %s', async (step, category, label, next, retryable) => {
    TOOL.current = 'video.erase';
    serve({ kind: 'erase', step, category });
    http.post.mockResolvedValue({ task_id: '60000000-0000-4000-8000-000000000001', status: 'pending' });
    mount();
    await screen.findByTestId('node-task-row');
    await screen.findByText(new RegExp(`${ui(`stepFail.${step}`)}\\W+${ui(label)}`));
    expect(screen.getByText(ui(next))).toBeInTheDocument();
    const retry = screen.queryByRole('button', { name: ui('retryFailedItems') });
    if (!retryable) { expect(retry).toBeNull(); return; }
    fireEvent.click(retry!);
    await waitFor(() => expect(http.post).toHaveBeenCalledOnce());
    const [path, sent] = http.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/mini-tools');
    expect(sent).toMatchObject({ tool: 'video.erase', retry: { runId: RUN, outputIndexes: [0] } });
    expect(miniToolExecutionRequestSchema.safeParse(sent).success).toBe(true);
  });

  // The node's retry and the tool panel's share one intent per run (`plannedRetryIntent`), so either one waiting shows on both.
  it('shows the retry waiting while it is sent, under the run\'s one retry intent', async () => {
    TOOL.current = 'video.erase';
    serve({ kind: 'erase', step: 'mask', category: 'timeout' });
    http.post.mockReturnValue(new Promise(() => undefined));
    mount();
    const retry = await screen.findByRole('button', { name: ui('retryFailedItems') });
    expect(retry).not.toHaveAttribute('aria-busy');
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: ui('retryFailedItems') })).toHaveAttribute('aria-busy', 'true'));
    expect(useTaskActionsInFlight.getState().running.has(`planned-retry:${RUN}:0`)).toBe(true);
  });

  it('an expand lists each window that did not succeed, a stopped window naming the one that stopped it, and retries', async () => {
    TOOL.current = 'video.expand';
    serve({ kind: 'expand', windows: [{ windowIndex: 2, step: 'generate', category: 'timeout' }, { windowIndex: 3, step: 'generate', category: 'stopped' }], shared: null });
    http.post.mockResolvedValue({ task_id: '60000000-0000-4000-8000-000000000001', status: 'pending' });
    mount();
    await screen.findByTestId('node-task-row');
    await screen.findByText(new RegExp(`${ui('windowNumber', { number: 3 })}\\W+${ui('personFailTimeout')}`));
    expect(screen.getByText(new RegExp(`${ui('windowNumber', { number: 4 })}\\W+${ui('personFailStopped')}`))).toBeInTheDocument();
    expect(screen.getByText(ui('windowStoppedNext', { number: 3 }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: ui('retryFailedItems') }));
    await waitFor(() => expect(http.post).toHaveBeenCalledOnce());
    expect(http.post.mock.calls[0][1]).toMatchObject({ tool: 'video.expand', retry: { runId: RUN, outputIndexes: [0] } });
  });

  it('an expand window the model rejected shows its next step and offers no retry', async () => {
    TOOL.current = 'video.expand';
    serve({ kind: 'expand', windows: [{ windowIndex: 0, step: 'generate', category: 'model_rejected' }, { windowIndex: 1, step: 'generate', category: 'stopped' }], shared: null });
    mount();
    await screen.findByTestId('node-task-row');
    await screen.findByText(new RegExp(`${ui('windowNumber', { number: 1 })}\\W+${ui('personFailRejected')}`));
    expect(screen.getByText(ui('expandRejectedNext'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ui('retryFailedItems') })).toBeNull();
  });

  // frames-split §7.15 可重试结束: once a retry has taken the failed output over, the old run's failure stays listed with no retry.
  it.each(['video.erase', 'video.expand'] as const)('a %s output a retry took over shows its failure and offers no retry', async (tool) => {
    TOOL.current = tool;
    serve(tool === 'video.erase' ? { kind: 'erase', step: 'mask', category: 'timeout' } : { kind: 'expand', windows: [{ windowIndex: 2, step: 'generate', category: 'timeout' }], shared: null }, true);
    mount();
    await screen.findByText(new RegExp(`${ui(tool === 'video.erase' ? 'stepFail.mask' : 'windowNumber', { number: 3 })}\\W+${ui('personFailTimeout')}`));
    expect(screen.queryByRole('button', { name: ui('retryFailedItems') })).toBeNull();
  });
});
