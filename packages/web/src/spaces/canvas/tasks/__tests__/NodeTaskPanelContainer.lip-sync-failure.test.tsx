// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 D24-1 (canvas design §4 对口型 row: the people who did not succeed are listed "on the node and in
 * the panel"; execution design §9.4): each lip-sync run has one output node, and that node is the authority for the run's
 * failure. Its task list, the node-level surface that already reads a planned row's parent run (`OpenNodeTaskPanel`
 * `parentRunIds` → `miniToolsApi.getRun`), shows the failed output's per-person lines ("Person N · category" and the next
 * step) and offers "Retry failed items" (`canvas.miniTool.videoUI.retryFailedPeople`) only when shared
 * `lipsyncFailureRetryable` says the reason is retryable; the retry goes through `miniToolsApi.retryPlannedVideoRun` to the
 * existing retry admission (`POST /mini-tools` with `retry: { runId, outputIndexes: [0] }`).
 *
 * The request layer (`apiGet`, `apiPost`) is mocked and answers the task list and the run; translation is real.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type NodeTaskEntry } from '@breatic/shared';
import { miniToolExecutionRequestSchema, type LipsyncFailureReason, type MiniToolExecutionRecord } from '@breatic/shared/mini-tools';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), apiGet: http.get, apiPost: http.post }));
vi.mock('@web/data/api/credits', () => ({ noteCreditsChanged: vi.fn() }));
vi.mock('@web/spaces/canvas/generate/model-catalog-query', () => ({ modelCatalogQuery: () => ({ queryKey: ['fixture-catalog'], queryFn: async () => ({ image: [], video: [], audio: [], tts: [], three_d: [] }) }) }));
vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@web/spaces/canvas/tasks/use-ticking-clock', () => ({ useTickingClock: () => 1_793_001_600_000 }));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { miniToolsApi } from '@web/data/api/mini-tools';
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

/**
 * The output node's failed lip-sync task row, pointing at its parent run.
 * @returns The row.
 */
function row(): NodeTaskEntry {
  return { id: '40000000-0000-4000-8000-000000000001', taskId: RUN, projectId: PROJECT, spaceId: SPACE, nodeId: OUTPUT, kind: 'generation', action: 'mini_tool', label: 'video.lip-sync', status: 'failed', startedByUserId: 'reader',
    startedAt: '2026-10-26T00:00:00.000Z', settledAt: '2026-10-26T00:00:01.000Z', budgetMs: 7_200_000, errorMessage: 'Lip sync failed', nodeHistoryId: null, content: null, coverUrl: null, mediaWidth: null, mediaHeight: null, duration: null, mimeType: null, size: null };
}

/**
 * The failed lip-sync run; the reason is the failed output's error (TR05).
 * @param reason - The reason.
 * @param takenOver - Whether an admitted retry has taken the failed output over.
 * @returns The record.
 */
function record(reason: LipsyncFailureReason, takenOver = false): MiniToolExecutionRecord {
  return { schemaVersion: 1, runId: RUN, status: 'failed', planFingerprint: 'a'.repeat(64), resultVersion: 1,
    sourceBindings: [{ assetId: '80000000-0000-4000-8000-000000000001', contentHash: 'b'.repeat(64), canonicalURL: 'https://assets.example.test/video/source.mp4', kind: 'video', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } }],
    outputs: [{ outputIndex: 0, nodeId: OUTPUT, recipe: { kind: 'lip-sync' }, late: false, result: { status: 'failed', error: structuredClone(reason) }, takenOver }],
    usage: [], billingState: 'settled', error: { message: 'output failed' } };
}

/**
 * Answers the output node's task list and its run.
 * @param reason - The run's failure reason.
 * @param takenOver - Whether an admitted retry has taken the failed output over.
 * @returns Nothing.
 */
function serve(reason: LipsyncFailureReason, takenOver = false): void {
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

describe('the lip-sync output node lists its failed people and retries them (§97 D24-1; canvas design §4 对口型, execution design §9.4)', () => {
  it('shows each failed person with category and next step, and retries through retryPlannedVideoRun', async () => {
    serve({ kind: 'lipsync', persons: [{ personId: 'person-b', detectionNumber: 2, step: 'gen', category: 'timeout' }, { personId: 'person-c', detectionNumber: 3, step: 'clip', category: 'failed' }], shared: null });
    http.post.mockResolvedValue({ task_id: '60000000-0000-4000-8000-000000000001', status: 'pending' });
    const sent = vi.spyOn(miniToolsApi, 'retryPlannedVideoRun');
    mount();
    // The failed row itself is on screen; what follows is what the row says about the run.
    await screen.findByTestId('node-task-row');
    await screen.findByText(new RegExp(`${ui('personNumber', { number: 2 })}\\W+${ui('personFailTimeout')}`));
    expect(screen.getByText(new RegExp(`${ui('personNumber', { number: 3 })}\\W+${ui('personFailFailed')}`))).toBeInTheDocument();
    expect(screen.getAllByText(ui('personFailRetryNext')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: ui('retryFailedPeople') }));
    await waitFor(() => expect(http.post).toHaveBeenCalledOnce());
    const [path, body] = http.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/mini-tools');
    expect(body).toMatchObject({ tool: 'video.lip-sync', project_id: PROJECT, space_id: SPACE, retry: { runId: RUN, outputIndexes: [0] } });
    expect(body.run_id).not.toBe(RUN);
    expect(miniToolExecutionRequestSchema.safeParse(body).success).toBe(true);
    expect(sent).toHaveBeenCalledExactlyOnceWith(body, expect.any(String));
  });

  it('shows a no-face person with its next step and offers no retry', async () => {
    serve({ kind: 'lipsync', persons: [{ personId: 'person-a', detectionNumber: 1, step: 'faces', category: 'no_face' }], shared: null });
    mount();
    await screen.findByTestId('node-task-row');
    await screen.findByText(new RegExp(`${ui('personNumber', { number: 1 })}\\W+${ui('personFailNoFace')}`));
    expect(screen.getByText(ui('personFailNoFaceNext'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ui('retryFailedPeople') })).toBeNull();
  });

  // frames-split §7.15 可重试结束: once a retry has taken the failed output over, the old run's people stay listed with no retry.
  it('lists the failed people of a run whose output a retry took over and offers no retry', async () => {
    serve({ kind: 'lipsync', persons: [{ personId: 'person-b', detectionNumber: 2, step: 'gen', category: 'timeout' }], shared: null }, true);
    mount();
    await screen.findByText(new RegExp(`${ui('personNumber', { number: 2 })}\\W+${ui('personFailTimeout')}`));
    expect(screen.queryByRole('button', { name: ui('retryFailedPeople') })).toBeNull();
  });
});
