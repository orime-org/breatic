// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §97 (canvas design §4 对口型 row; execution design §9.3, §9.4; frames-split §7.11 retry row): the lip-sync
 * panel as `CanvasSpace` mounts it (`MiniToolPanelContainer` with no `lipSync`, `lipSyncFailure` or `onRetryFailed`) wires them
 * itself:
 * - `lipSync` comes from `GET /canvas/limits` `lipSync` (config `executions.video.lip-sync`), read through `canvasApi.fetchLimits`
 *   with the models joined to their catalog entries: the model picker lists exactly the configured models and Run's range
 *   toast names their minimum and maximum, and the tracking range;
 * - `lipSyncFailure` is the failed output's `error` of this host's last lip-sync run: the run is the `mini_tool` task of the
 *   output node the host's `video.lip-sync` edge leads to, read with `miniToolsApi.getRun`;
 * - the people and dialogue caps come from the same answer's `lipSync.maxPeople` / `lipSync.maxDialogues` (canvas design §4:
 *   at the cap, "Add dialogue" and the people beyond it are `aria-disabled` and a click says why with a toast); the fixtures
 *   use 1 and 3, so the design's initial 2 and 8 written into code fail. No web copy for these two toasts exists yet, so only
 *   that one warning toast is shown is asserted, not its text;
 * - `onRetryFailed` posts the existing planned retry form (`POST /mini-tools` with `retry: { runId, outputIndexes }`, shared
 *   `miniToolExecutionRequestSchema`) for that run's failed output.
 * How the panel finds the run and that the retry form carries `video.lip-sync` are shapes this test chose. The request layer
 * (`apiGet`, `apiPost`) is mocked and answers only the reads named here; the limits cache starts empty.
 *
 * Fixture: a 5 s video and one dialogue of 3 s audio starting at 0 s in cut_off mode, so the result lasts 3 s and the run uses
 * the source range [0, 3].
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiGet: http.get,
  apiPost: http.post,
}));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { t, type ModelCatalog, type ModelEntry, type NodeTaskEntry } from '@breatic/shared';
import { fingerprintMiniToolAnalysisInput, miniToolExecutionRequestSchema, projectMiniToolAnalysisInput, type LipsyncFailureReason, type MiniToolAnalysisRecord, type MiniToolExecutionRecord, type VideoToolDraftById } from '@breatic/shared/mini-tools';
import { MiniToolPanelContainer } from '../MiniToolPanelContainer';
import type { VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { addEdge, addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolAnalysisRef, commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasApi } from '@web/data/api/canvas';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';

const projectId = '01000000-0000-4000-8000-000000000001'; const spaceId = '02000000-0000-4000-8000-000000000001';
const nodeId = '10000000-0000-4000-8000-000000000001'; const outputId = '10000000-0000-4000-8000-000000000002';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
const analysisRunId = '80000000-0000-4000-8000-000000000001';
const failedRunId = '90000000-0000-4000-8000-000000000001';
const audioId = '40000000-0000-4000-8000-000000000009';
const frameTable = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 125, step: 4, duration: 4 }] };
const presentation: VideoToolPresentation = { frameTable, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0 };
const profile = { id: 'people', version: '1', weightsHash: null, params: {} };

/**
 * A lip-sync model as the catalog serves it.
 * @param name - The catalog name.
 * @param displayName - The name shown.
 * @returns The entry.
 */
function model(name: string, displayName: string): ModelEntry {
  return { name, display_name: displayName, modality: 'video', mode: 'talking_head', description: '', guide: '', tier: 'optional', generation_time: 600, takes_prompt: false, params: {}, providers: [] };
}
// The shipped default sits in the catalog too, so a hard-coded list shows it and fails the exact-list assertion.
const CATALOG = { image: [], video: [model('sync-lipsync-3', 'Sync Lipsync 3'), model('lipsync-configured-a', 'Configured A'), model('lipsync-configured-b', 'Configured B')], audio: [], tts: [], three_d: [], total: 3, credit_multiplier: 1 } as unknown as ModelCatalog;

type Range = { minDurationSeconds: number; maxDurationSeconds: number };
/**
 * `GET /canvas/limits` with the given lip-sync ranges: models A then B, and the tracking range.
 * @param first - Model A's range.
 * @param tracking - The tracking range.
 * @returns The answer.
 */
function limits(first: Range, tracking: Range, caps: { maxPeople: number; maxDialogues: number } = { maxPeople: 2, maxDialogues: 8 }): Record<string, unknown> {
  return {
    referencePoolCap: 10, nodeHistoryPageSize: 20, understandMaxBytes: 20_971_520, understandLongMediaMaxBytes: 2_147_483_648,
    waveformMaxSeconds: 600, waveformMaxBytes: 200_000_000, waveformPeaksRetryMs: 5000, waveformPeaksRetryMaxMs: 600_000,
    removeBackgroundModel: 'remove-bg-configured',
    lipSync: { models: [{ name: 'lipsync-configured-a', ...first }, { name: 'lipsync-configured-b', minDurationSeconds: 1, maxDurationSeconds: 15 }], tracking, ...caps },
  };
}

/**
 * Answers the request layer's reads: the limits, and when given, the output node's task list and its failed run.
 * @param answer - The limits answer.
 * @param failure - The failed run's output error, or none for a host with no lip-sync run.
 * @returns Nothing.
 */
function serve(answer: Record<string, unknown>, failure?: LipsyncFailureReason): void {
  http.get.mockImplementation(async (path: string): Promise<unknown> => {
    if (path === '/canvas/limits') return structuredClone(answer);
    if (failure !== undefined && path === `/canvas/nodes/${outputId}/tasks`) return { tasks: [task()] };
    if (failure !== undefined && path === `/projects/${projectId}/mini-tool-runs/${failedRunId}`) return run(failure);
    throw new Error(`Unexpected GET ${path}`);
  });
}

/**
 * The output node's settled lip-sync task row, pointing at its parent run.
 * @returns The row.
 */
function task(): NodeTaskEntry {
  return {
    id: 'a0000000-0000-4000-8000-000000000001', taskId: failedRunId, projectId, spaceId, nodeId: outputId, kind: 'generation', action: 'mini_tool',
    status: 'failed', startedByUserId: 'user-1', startedAt: '2026-11-06T00:00:00.000001Z', settledAt: '2026-11-06T00:01:00.000001Z', budgetMs: 7_200_000,
    label: 'video.lip-sync', errorMessage: 'Lip sync failed', nodeHistoryId: null, content: null, coverUrl: null,
    mediaWidth: null, mediaHeight: null, duration: null, mimeType: null, size: null,
  };
}

/**
 * The failed lip-sync run as `GET /projects/:projectId/mini-tool-runs/:runId` answers it; the reason is the failed output's error.
 * @param failure - The reason.
 * @returns The record.
 */
function run(failure: LipsyncFailureReason): MiniToolExecutionRecord {
  return {
    schemaVersion: 1, runId: failedRunId, status: 'failed', planFingerprint: 'c'.repeat(64), resultVersion: 1,
    sourceBindings: [{ assetId: '70000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: sourceURL, kind: 'video', mediaInfo }],
    outputs: [{ outputIndex: 0, nodeId: outputId, recipe: { kind: 'lip-sync' }, late: false, result: { status: 'failed', error: structuredClone(failure) } }],
    usage: [], billingState: 'settled', error: { message: 'output failed' },
  };
}

type Dialogue = VideoToolDraftById['video.lip-sync']['params']['dialogues'][number];
/**
 * A dialogue row bound to the 3 s audio, with this person (or none).
 * @param dialogueId - The row id.
 * @param personId - The bound person, or null.
 * @returns The row.
 */
function dialogue(dialogueId: string, personId: string | null): Dialogue {
  return { dialogueId, personId, analysisRunId: personId === null ? null : analysisRunId, audioInputId: audioId, startTime: 0 };
}
const ROW_A = '41000000-0000-4000-8000-000000000001'; const ROW_B = '41000000-0000-4000-8000-000000000002'; const ROW_C = '41000000-0000-4000-8000-000000000003';

/**
 * Commits a lip-sync draft with these dialogue rows over the 3 s audio, with a people analysis that found these people,
 * and opens the lip-sync panel on it.
 * @param rows - The dialogue rows; by default one row bound to `person-a`.
 * @param people - The people the analysis found, in detection order.
 * @returns Nothing.
 */
async function seed(rows?: Dialogue[], people: readonly string[] = ['person-a']): Promise<void> {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const initial = createVideoToolDraft('video.lip-sync', source);
  const draft: VideoToolDraftById['video.lip-sync'] = {
    ...initial,
    inputs: [{ inputId: audioId, url: 'https://assets.example.test/voice.m4a', mediaInfo: { duration: 3, mimeType: 'audio/mp4' } }],
    params: { ...initial.params, dialogues: rows ?? [{ ...initial.params.dialogues[0], personId: 'person-a', analysisRunId, audioInputId: audioId, startTime: 0 }] },
  };
  commitVideoToolDraft(doc, nodeId, 'video.lip-sync', draft);
  const analysisInput = projectMiniToolAnalysisInput({ kind: 'people', source, params: draft.params, profile });
  const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
  const identity = {
    schemaVersion: 1 as const, draftId: draft.draftId, revision: draft.revision, analysisRunId, acceptedAt: '2026-11-06T00:00:00.000001Z',
    binding: { assetId: '70000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: sourceURL, kind: 'video' as const, mediaInfo },
    analysisInput, inputFingerprint,
  };
  const record: MiniToolAnalysisRecord = {
    ...identity, kind: 'people', status: 'completed', artifactUnavailable: false, error: null, usage: [],
    result: { ...identity, kind: 'people', anchor: { frameIndex: 0, pts: 0 }, people: people.map((personId, index) => ({ personId, faceBox: { x: 0.1 + index * 0.3, y: 0.1, width: 0.2, height: 0.2 }, artifactRefs: [] })) },
  };
  vi.spyOn(miniToolAnalysesApi, 'get').mockResolvedValue(record);
  commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.lip-sync', kind: 'people', draftId: draft.draftId, analysisRunId, inputFingerprint });
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.lip-sync', { sourceContent: sourceURL, params: {} });
}

/**
 * Adds the host's earlier lip-sync output: an empty video node behind a `video.lip-sync` edge, its one task failed.
 * @returns The output node's view.
 */
function addFailedOutput(): CanvasNodeView {
  const taskCounts = { running: 0, done: 0, failed: 1, expired: 0 };
  addNode(projectId, spaceId, { id: outputId, type: 'video', position: { x: 600, y: 0 }, data: { content: '', name: 'Source lip-sync', locked: false, createdAt: 0, createdBy: 'test', attachments: [], taskCounts } });
  addEdge(projectId, spaceId, { id: `${nodeId}->${outputId}`, source: nodeId, target: outputId, toolId: 'video.lip-sync' });
  return { id: outputId, type: 'video', position: { x: 600, y: 0 }, data: { handling: false, content: '', taskCounts } };
}

/**
 * Mounts the panel container as `CanvasSpace` does and waits until the identified person is bound on its first row.
 * @param withOutput - Whether the host has a failed lip-sync output.
 * @param rows - The draft's dialogue rows (see {@link seed}).
 * @param people - The people the analysis found (see {@link seed}).
 * @returns Nothing.
 */
async function mount(withOutput = false, rows?: Dialogue[], people?: readonly string[]): Promise<void> {
  await seed(rows, people);
  const host: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  const nodes = withOutput ? [host, addFailedOutput()] : [host];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(modelCatalogQuery().queryKey, CATALOG);
  render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><MiniToolPanelContainer nodes={nodes} getLastWriteWasLocal={() => false} onRun={vi.fn()} onRunVideo={vi.fn().mockResolvedValue({ kind: 'done', result: {} })} videoPresentation={new Map([[nodeId, presentation]])} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
  await screen.findAllByText('Person 1');
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

beforeEach(() => { vi.clearAllMocks(); canvasApi.resetLimitsCache(); });
afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); canvasApi.resetLimitsCache(); vi.restoreAllMocks(); });

describe('the lip-sync panel reads its models and ranges from the canvas limits (§97; canvas design §4 对口型)', () => {
  it('lists exactly the configured models in order, the first chosen', async () => {
    serve(limits({ minDurationSeconds: 1, maxDurationSeconds: 300 }, { minDurationSeconds: 0.5, maxDurationSeconds: 600 }));
    await mount();
    const trigger = await waitFor(() => {
      const found = screen.getByTestId('video-lip-sync-controls').querySelector('[data-testid="generate-model-trigger"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(trigger).toHaveTextContent('Configured A');
    fireEvent.click(trigger);
    expect(screen.getAllByTestId(/^generate-model-option-/).map((option) => option.getAttribute('data-testid'))).toEqual(['generate-model-option-lipsync-configured-a', 'generate-model-option-lipsync-configured-b']);
  });

  it('refuses a 3 s result outside the first configured model range and names that range', async () => {
    serve(limits({ minDurationSeconds: 1.5, maxDurationSeconds: 2.5 }, { minDurationSeconds: 0.5, maxDurationSeconds: 10 }));
    await mount();
    const run = screen.getByTestId('mini-tool-run');
    await waitFor(() => expect(run).toHaveAttribute('aria-disabled', 'true'));
    act(() => run.click());
    expect(toast.warning).toHaveBeenCalledWith(t('canvas.miniTool.videoUI.lipSyncDurationRange', { min: 1.5, max: 2.5, duration: 3 }));
  });

  it('refuses a [0, 3] source range outside the configured tracking range and names that range', async () => {
    serve(limits({ minDurationSeconds: 1, maxDurationSeconds: 10 }, { minDurationSeconds: 0.75, maxDurationSeconds: 2.25 }));
    await mount();
    const run = screen.getByTestId('mini-tool-run');
    await waitFor(() => expect(run).toHaveAttribute('aria-disabled', 'true'));
    act(() => run.click());
    expect(toast.warning).toHaveBeenCalledWith(t('canvas.miniTool.videoUI.lipSyncTrackingRange', { min: 0.75, max: 2.25, length: 3 }));
  });
});

describe('the lip-sync panel shows the last run failure and retries it (§97; execution design §9.4; frames-split §7.11 retry)', () => {
  const reason: LipsyncFailureReason = { kind: 'lipsync', persons: [{ personId: 'person-a', detectionNumber: 2, step: 'gen', category: 'timeout' }], shared: null };

  it('lists the failed output reason of the host last lip-sync run per person', async () => {
    serve(limits({ minDurationSeconds: 1, maxDurationSeconds: 300 }, { minDurationSeconds: 0.5, maxDurationSeconds: 600 }), reason);
    await mount(true);
    const failure = await screen.findByTestId('video-lip-sync-failure');
    expect(failure).toHaveTextContent(`${ui('personNumber', { number: 2 })} · ${ui('personFailTimeout')}`);
    expect(failure).toHaveTextContent(ui('personFailRetryNext'));
  });

  it('retries that run failed output through the planned retry form', async () => {
    serve(limits({ minDurationSeconds: 1, maxDurationSeconds: 300 }, { minDurationSeconds: 0.5, maxDurationSeconds: 600 }), reason);
    http.post.mockResolvedValue({ task_id: 'b0000000-0000-4000-8000-000000000001', status: 'pending' });
    await mount(true);
    const retry = await screen.findByRole('button', { name: ui('retryFailedPeople') });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(http.post).toHaveBeenCalledOnce());
    const [path, body] = http.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/mini-tools');
    expect(body).toMatchObject({ tool: 'video.lip-sync', project_id: projectId, space_id: spaceId, retry: { runId: failedRunId, outputIndexes: [0] } });
    expect(body.run_id).not.toBe(failedRunId);
    expect(miniToolExecutionRequestSchema.safeParse(body).success).toBe(true);
  });
});

describe('the lip-sync panel takes its people and dialogue caps from the canvas limits (§97; canvas design §4 对口型)', () => {
  const ranges = [{ minDurationSeconds: 1, maxDurationSeconds: 300 }, { minDurationSeconds: 0.5, maxDurationSeconds: 600 }] as const;

  /**
   * The dialogue rows of the host's current lip-sync draft.
   * @returns The rows.
   */
  function rowsNow(): readonly Dialogue[] {
    const reading = readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, 'video.lip-sync');
    if (reading.state !== 'supported') throw new Error('Expected the committed lip-sync draft');
    return (reading.draft as VideoToolDraftById['video.lip-sync']).params.dialogues;
  }

  it('refuses a second distinct person with maxPeople 1 and keeps the person already chosen selectable', async () => {
    serve(limits(...ranges, { maxPeople: 1, maxDialogues: 3 }));
    await mount(false, [dialogue(ROW_A, 'person-a'), dialogue(ROW_B, null)], ['person-a', 'person-b']);
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`video-person-${ROW_B}`));
    const second = await screen.findByRole('option', { name: 'Person 2' });
    await waitFor(() => expect(second).toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByRole('option', { name: 'Person 1' })).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(second);
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(rowsNow().find((row) => row.dialogueId === ROW_B)?.personId).toBeNull();
  });

  it('refuses a fourth dialogue row with maxDialogues 3', async () => {
    serve(limits(...ranges, { maxPeople: 1, maxDialogues: 3 }));
    await mount(false, [dialogue(ROW_A, 'person-a'), dialogue(ROW_B, 'person-a'), dialogue(ROW_C, 'person-a')]);
    const add = screen.getByRole('button', { name: ui('addDialogue') });
    await waitFor(() => expect(add).toHaveAttribute('aria-disabled', 'true'));
    expect(add).not.toBeDisabled();
    fireEvent.click(add);
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(rowsNow()).toHaveLength(3);
  });
});
