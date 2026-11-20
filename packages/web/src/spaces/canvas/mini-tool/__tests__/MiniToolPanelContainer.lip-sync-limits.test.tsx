// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 (canvas design §4 lip-sync row; execution design §9.3, §9.4; frames-split §7.11 retry row): the lip-sync
 * panel as `CanvasSpace` mounts it (`MiniToolPanelContainer` with no `lipSync`, `lipSyncFailure` or `onRetryFailed`) wires them
 * itself:
 * - `lipSync` comes from `GET /canvas/limits` `lipSync` (config `executions.video.lip-sync`), read through `canvasApi.fetchLimits`
 *   with the models joined to their catalog entries: the model picker lists exactly the configured models and Run's range
 *   toast names their minimum and maximum, and the tracking range;
 * - `lipSyncFailure` is the failed output's `error` of the most recently started lip-sync run of this host (D24-1): among the
 *   output nodes the host's `video.lip-sync` edges lead to that are still on the canvas, the `mini_tool` task row started
 *   last, read with `miniToolsApi.getRun`; when that run did not fail the panel shows no failure, even if an older one did;
 * - the people and dialogue caps come from the same answer's `lipSync.maxPeople` / `lipSync.maxDialogues` (canvas design §4:
 *   at the cap, "Add dialogue" and the people beyond it are `aria-disabled` and a click says why with a toast); the fixtures
 *   use 1 and 3, so the design's initial 2 and 8 written into code fail. The toasts reuse the server's refusal copy
 *   `server.mini_tool.lipSyncTooManyPeople` / `lipSyncTooManyDialogues` `{max}`, which web's catalog already resolves (D24-2);
 * - `onRetryFailed` sends the existing planned retry form (`POST /mini-tools` with `retry: { runId, outputIndexes }`, shared
 *   `miniToolExecutionRequestSchema`) for that run's failed output through `miniToolsApi.retryPlannedVideoRun` (D24-1);
 * - the footer shows the server's quote (D26-1): `POST /mini-tools/quote` with the planned request body of the current draft
 *   answers `{ credits }`, computed as admission would freeze it, so the panel prices nothing itself. The request layer
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
import { fingerprintMiniToolAnalysisInput, miniToolExecutionRequestSchema, miniToolPlannedRequestSchema, projectMiniToolAnalysisInput, type LipsyncFailureReason, type MiniToolAnalysisRecord, type MiniToolExecutionRecord, type VideoToolDraftById } from '@breatic/shared/mini-tools';
import { MiniToolPanelContainer } from '../MiniToolPanelContainer';
import type { VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { addEdge, addNode, readNodes, removeNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolAnalysisRef, commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasApi } from '@web/data/api/canvas';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { miniToolsApi } from '@web/data/api/mini-tools';
import { canvasSessions } from '@web/stores/canvas-session';
import { resetRunOnceForTests, useTaskActionsInFlight } from '@web/stores/task-actions-in-flight';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';
import { formatCreditAmount } from '@web/lib/format-credit-amount';

const projectId = '01000000-0000-4000-8000-000000000001'; const spaceId = '02000000-0000-4000-8000-000000000001';
const nodeId = '10000000-0000-4000-8000-000000000001'; const outputId = '10000000-0000-4000-8000-000000000002';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
const analysisRunId = '80000000-0000-4000-8000-000000000001';
const failedRunId = '90000000-0000-4000-8000-000000000001';
const audioId = '40000000-0000-4000-8000-000000000009';
// The selected version's grid: 125 frames at 25 fps (5 s).
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
// The selected tool input the run is planned against (frames-split §7.13); the quote request names it as the run would.
const PRESENTATION_REF = { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } };
const presentation: VideoToolPresentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0 };
// The same presentation once its selected tool input is known, as a ready node publishes it; analysis and quote requests need it.
const planned: VideoToolPresentation = { ...presentation, presentationRef: PRESENTATION_REF };
let mounted: VideoToolPresentation;
const profile = { id: 'people', version: '1', weightsHash: null, params: {} };

/**
 * A lip-sync model as the catalog serves it.
 * @param name - The catalog name.
 * @param displayName - The name shown.
 * @returns The entry.
 */
function model(name: string, displayName: string): ModelEntry {
  return { name, display_name: displayName, modality: 'video', mode: 'talking_head', description: '', guide: '', tier: 'optional', generation_time: 600, takes_prompt: false, params: {}, availability: { upstreams: [] } };
}
// The shipped default sits in the catalog too, so a hard-coded list shows it and fails the exact-list assertion.
let catalog: ModelCatalog;
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

/** One lip-sync output of the host: its node, its run, when the run started and why it failed (null when it succeeded). */
interface OutputRun { nodeId: string; runId: string; startedAt: string; failure: LipsyncFailureReason | null; takenOver?: boolean }

/**
 * Answers the request layer's reads: the limits, and when given, the output node's task list and its failed run.
 * @param answer - The limits answer.
 * @param failure - The failed run's output error, or none for a host with no lip-sync run.
 * @returns Nothing.
 */
function serve(answer: Record<string, unknown>, failure?: LipsyncFailureReason): void {
  serveRuns(answer, failure === undefined ? [] : [{ nodeId: outputId, runId: failedRunId, startedAt: '2026-11-06T00:00:00.000001Z', failure }]);
}

/**
 * Answers the request layer's reads: the limits, each output node's task list and each run.
 * @param answer - The limits answer.
 * @param runs - The host's lip-sync outputs.
 * @returns Nothing.
 */
function serveRuns(answer: Record<string, unknown>, runs: readonly OutputRun[]): void {
  http.get.mockImplementation(async (path: string): Promise<unknown> => {
    if (path === '/canvas/limits') return structuredClone(answer);
    for (const output of runs) {
      if (path === `/canvas/nodes/${output.nodeId}/tasks`) return { tasks: [task(output)] };
      if (path === `/projects/${projectId}/mini-tool-runs/${output.runId}`) return run(output.failure, output);
    }
    throw new Error(`Unexpected GET ${path}`);
  });
}

/**
 * An output node's settled lip-sync task row, pointing at its parent run.
 * @param output - The output; by default the single failed output.
 * @returns The row.
 */
function task(output: OutputRun = { nodeId: outputId, runId: failedRunId, startedAt: '2026-11-06T00:00:00.000001Z', failure: null }): NodeTaskEntry {
  return {
    id: `a${output.runId.slice(1)}`, taskId: output.runId, projectId, spaceId, nodeId: output.nodeId, kind: 'generation', action: 'mini_tool',
    status: output.failure === null ? 'done' : 'failed', startedByUserId: 'user-1', startedAt: output.startedAt, settledAt: output.startedAt, budgetMs: 7_200_000,
    label: 'video.lip-sync', errorMessage: output.failure === null ? null : 'Lip sync failed', nodeHistoryId: null, content: null, coverUrl: null,
    mediaWidth: null, mediaHeight: null, duration: null, mimeType: null, size: null,
  };
}

/**
 * A lip-sync run as `GET /projects/:projectId/mini-tool-runs/:runId` answers it: failed with the reason as the failed output's
 * error, or completed with a registered video.
 * @param failure - The reason, or null for a run that succeeded.
 * @param output - Its output node and run; by default the single failed output.
 * @returns The record.
 */
function run(failure: LipsyncFailureReason | null, output: Pick<OutputRun, 'nodeId' | 'runId' | 'takenOver'> = { nodeId: outputId, runId: failedRunId }): MiniToolExecutionRecord {
  const sourceBindings: MiniToolExecutionRecord['sourceBindings'] = [{ assetId: '70000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: sourceURL, kind: 'video', mediaInfo }];
  if (failure === null) {
    return {
      schemaVersion: 1, runId: output.runId, status: 'completed', planFingerprint: 'c'.repeat(64), resultVersion: 1, sourceBindings,
      outputs: [{ outputIndex: 0, nodeId: output.nodeId, recipe: { kind: 'lip-sync' }, late: false, result: { status: 'registered', assetId: '71000000-0000-4000-8000-000000000001', canonicalURL: 'https://assets.example.test/lip-synced.mp4', kind: 'video', mimeType: 'video/mp4', size: 1024, contentHash: 'e'.repeat(64), width: 960, height: 540, duration: 3, cover: null } }],
      usage: [], billingState: 'settled', error: null,
    };
  }
  return {
    schemaVersion: 1, runId: output.runId, status: 'failed', planFingerprint: 'c'.repeat(64), resultVersion: 1, sourceBindings,
    outputs: [{ outputIndex: 0, nodeId: output.nodeId, recipe: { kind: 'lip-sync' }, late: false, result: { status: 'failed', error: structuredClone(failure) }, ...(output.takenOver === undefined ? {} : { takenOver: output.takenOver }) }],
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
    result: { ...identity, kind: 'people', anchor: { frameIndex: 0 }, people: people.map((personId, index) => ({ personId, faceBox: { x: 0.1 + index * 0.3, y: 0.1, width: 0.2, height: 0.2 }, artifactRefs: [] })) },
  };
  vi.spyOn(miniToolAnalysesApi, 'get').mockResolvedValue(record);
  commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.lip-sync', kind: 'people', draftId: draft.draftId, analysisRunId, inputFingerprint });
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.lip-sync', { sourceContent: sourceURL, params: {} });
}

/**
 * Adds a lip-sync output of the host: a video node behind a `video.lip-sync` edge, with its one task settled.
 * @param id - The output node id; by default the single failed output.
 * @param failed - Whether its task failed.
 * @returns The output node's view.
 */
function addFailedOutput(id = outputId, failed = true): CanvasNodeView {
  const taskCounts = { running: 0, done: failed ? 0 : 1, failed: failed ? 1 : 0, expired: 0 };
  addNode(projectId, spaceId, { id, type: 'video', position: { x: 600, y: 0 }, data: { content: '', name: 'Source lip-sync', locked: false, createdAt: 0, createdBy: 'test', attachments: [], taskCounts } });
  addEdge(projectId, spaceId, { id: `${nodeId}->${id}`, source: nodeId, target: id, toolId: 'video.lip-sync' });
  return { id, type: 'video', position: { x: 600, y: 0 }, data: { handling: false, content: '', taskCounts } };
}

/**
 * Mounts the panel container as `CanvasSpace` does and waits until the identified person is bound on its first row.
 * @param withOutput - Whether the host has a failed lip-sync output.
 * @param rows - The draft's dialogue rows (see {@link seed}).
 * @param people - The people the analysis found (see {@link seed}).
 * @param outputs - Adds the host's lip-sync outputs after the draft is seeded and returns the views still on the canvas.
 * @returns A rerender with the canvas's next output views, the panel staying mounted.
 */
async function mount(withOutput = false, rows?: Dialogue[], people?: readonly string[], outputs?: () => CanvasNodeView[]): Promise<(next: CanvasNodeView[]) => void> {
  await seed(rows, people);
  const host: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(modelCatalogQuery().queryKey, catalog);
  const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
  /**
   * The panel container as `CanvasSpace` mounts it over these node views.
   * @param nodes - The canvas's node views.
   * @returns The tree.
   */
  const tree = (nodes: CanvasNodeView[]): React.JSX.Element => <QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><MiniToolPanelContainer nodes={nodes} getLastWriteWasLocal={() => false} onRun={vi.fn()} onRunVideo={onRunVideo} videoPresentation={new Map([[nodeId, mounted]])} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>;
  const { rerender } = render(tree([host, ...(withOutput ? [addFailedOutput()] : []), ...(outputs?.() ?? [])]));
  await screen.findAllByText('Person 1');
  return (next) => rerender(tree([host, ...next]));
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

beforeEach(() => { vi.clearAllMocks(); canvasApi.resetLimitsCache(); catalog = CATALOG; mounted = presentation; });
afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); canvasApi.resetLimitsCache(); resetRunOnceForTests(); vi.restoreAllMocks(); });

describe('the lip-sync panel reads its models and ranges from the canvas limits (§97; canvas design §4 lip-sync row)', () => {
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
    const sent = vi.spyOn(miniToolsApi, 'retryPlannedVideoRun');
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
    expect(sent).toHaveBeenCalledExactlyOnceWith(body, expect.any(String));
  });

  it('shows the retry waiting while it is sent, under the run\'s one retry intent', async () => {
    serve(limits({ minDurationSeconds: 1, maxDurationSeconds: 300 }, { minDurationSeconds: 0.5, maxDurationSeconds: 600 }), reason);
    http.post.mockReturnValue(new Promise(() => undefined));
    await mount(true);
    const retry = await screen.findByRole('button', { name: ui('retryFailedPeople') });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: ui('retryFailedPeople') })).toHaveAttribute('aria-busy', 'true'));
    expect(useTaskActionsInFlight.getState().running.has(`planned-retry:${failedRunId}:0`)).toBe(true);
  });

  // frames-split §7.15 retryable end: a failed output an admitted retry took over accepts no further retry.
  it('lists the failure of a run whose output a retry took over and offers no retry', async () => {
    serveRuns(limits({ minDurationSeconds: 1, maxDurationSeconds: 300 }, { minDurationSeconds: 0.5, maxDurationSeconds: 600 }),
      [{ nodeId: outputId, runId: failedRunId, startedAt: '2026-11-06T00:00:00.000001Z', failure: reason, takenOver: true }]);
    await mount(true);
    const failure = await screen.findByTestId('video-lip-sync-failure');
    expect(failure).toHaveTextContent(`${ui('personNumber', { number: 2 })} · ${ui('personFailTimeout')}`);
    expect(screen.queryByRole('button', { name: ui('retryFailedPeople') })).toBeNull();
  });

  it('offers no retry when the reason is not retryable (a person with no face)', async () => {
    serve(limits({ minDurationSeconds: 1, maxDurationSeconds: 300 }, { minDurationSeconds: 0.5, maxDurationSeconds: 600 }), { kind: 'lipsync', persons: [{ personId: 'person-a', detectionNumber: 1, step: 'faces', category: 'no_face' }], shared: null });
    await mount(true);
    const failure = await screen.findByTestId('video-lip-sync-failure');
    expect(failure).toHaveTextContent(ui('personFailNoFace'));
    expect(screen.queryByRole('button', { name: ui('retryFailedPeople') })).toBeNull();
  });
});

// The output node's counts are what moves when its run settles or a retry starts on it, so the host's failure block reads
// the last run again whenever they move, without the panel being reopened.
describe('the host panel follows its lip-sync output as the run settles (§97 D24-1; execution design §9.4)', () => {
  const reason: LipsyncFailureReason = { kind: 'lipsync', persons: [{ personId: 'person-a', detectionNumber: 2, step: 'gen', category: 'timeout' }], shared: null };

  it('shows the failure of a run that fails while the panel is open', async () => {
    const state = { failed: false };
    http.get.mockImplementation(async (path: string): Promise<unknown> => {
      if (path === '/canvas/limits') return limits({ minDurationSeconds: 1, maxDurationSeconds: 300 }, { minDurationSeconds: 0.5, maxDurationSeconds: 600 });
      if (path === `/canvas/nodes/${outputId}/tasks`) return { tasks: [{ ...task({ nodeId: outputId, runId: failedRunId, startedAt: '2026-11-06T00:00:00.000001Z', failure: state.failed ? reason : null }), ...(state.failed ? {} : { status: 'running', settledAt: null }) }] };
      if (path === `/projects/${projectId}/mini-tool-runs/${failedRunId}`) {
        if (state.failed) return run(reason);
        const running = run(null);
        return { ...running, status: 'running', billingState: 'idle', outputs: running.outputs.map((output) => ({ ...output, result: null })) };
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    /**
     * The output node's view with these counts.
     * @param taskCounts - Its task counts.
     * @returns The view.
     */
    const view = (taskCounts: { running: number; done: number; failed: number; expired: number }): CanvasNodeView => ({ id: outputId, type: 'video', position: { x: 600, y: 0 }, data: { handling: false, content: '', taskCounts } });
    const next = await mount(false, undefined, undefined, () => {
      addNode(projectId, spaceId, { id: outputId, type: 'video', position: { x: 600, y: 0 }, data: { content: '', name: 'Source lip-sync', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
      addEdge(projectId, spaceId, { id: `${nodeId}->${outputId}`, source: nodeId, target: outputId, toolId: 'video.lip-sync' });
      return [view({ running: 1, done: 0, failed: 0, expired: 0 })];
    });
    await waitFor(() => expect(http.get.mock.calls.map(([path]) => path)).toContain(`/projects/${projectId}/mini-tool-runs/${failedRunId}`));
    expect(screen.queryByTestId('video-lip-sync-failure')).toBeNull();
    state.failed = true;
    next([view({ running: 0, done: 0, failed: 1, expired: 0 })]);
    expect(await screen.findByTestId('video-lip-sync-failure')).toHaveTextContent(`${ui('personNumber', { number: 2 })} · ${ui('personFailTimeout')}`);
  });
});

describe('the host panel shows the failure of its most recently started lip-sync run only (§97 D24-1; canvas design §4 lip-sync row)', () => {
  const ranges = [{ minDurationSeconds: 1, maxDurationSeconds: 300 }, { minDurationSeconds: 0.5, maxDurationSeconds: 600 }] as const;
  const OLDER = '10000000-0000-4000-8000-000000000011'; const NEWER = '10000000-0000-4000-8000-000000000012';
  const OLDER_RUN = '91000000-0000-4000-8000-000000000001'; const NEWER_RUN = '91000000-0000-4000-8000-000000000002';
  const olderReason: LipsyncFailureReason = { kind: 'lipsync', persons: [{ personId: 'person-a', detectionNumber: 4, step: 'gen', category: 'timeout' }], shared: null };
  const newerReason: LipsyncFailureReason = { kind: 'lipsync', persons: [{ personId: 'person-a', detectionNumber: 5, step: 'gen', category: 'model_rejected' }], shared: null };
  // The older output is added after the newer one, so neither insertion nor id order picks the newer run.
  const older = (failure: LipsyncFailureReason | null): OutputRun => ({ nodeId: OLDER, runId: OLDER_RUN, startedAt: '2026-11-06T01:00:00.000001Z', failure });
  const newer = (failure: LipsyncFailureReason | null): OutputRun => ({ nodeId: NEWER, runId: NEWER_RUN, startedAt: '2026-11-06T02:00:00.000001Z', failure });

  /**
   * Waits until the panel has read the run of the newer output, so a missing failure is the panel's answer, not a pending read.
   * @returns Nothing.
   */
  async function newerRunRead(): Promise<void> {
    await waitFor(() => expect(http.get.mock.calls.map(([path]) => path)).toContain(`/projects/${projectId}/mini-tool-runs/${NEWER_RUN}`));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it('shows the newer failed run when both outputs failed with different reasons', async () => {
    serveRuns(limits(...ranges), [newer(newerReason), older(olderReason)]);
    await mount(false, undefined, undefined, () => [addFailedOutput(NEWER), addFailedOutput(OLDER)]);
    const failure = await screen.findByTestId('video-lip-sync-failure');
    expect(failure).toHaveTextContent(`${ui('personNumber', { number: 5 })} · ${ui('personFailRejected')}`);
    expect(failure).not.toHaveTextContent(ui('personNumber', { number: 4 }));
  });

  it('shows no failure when the newer run succeeded and only the older failed', async () => {
    serveRuns(limits(...ranges), [newer(null), older(olderReason)]);
    await mount(false, undefined, undefined, () => [addFailedOutput(NEWER, false), addFailedOutput(OLDER)]);
    await newerRunRead();
    expect(screen.queryByTestId('video-lip-sync-failure')).toBeNull();
  });

  it('ignores a newer output that is no longer on the canvas', async () => {
    serveRuns(limits(...ranges), [newer(newerReason), older(olderReason)]);
    await mount(false, undefined, undefined, () => {
      addFailedOutput(NEWER);
      removeNode(projectId, spaceId, NEWER);
      return [addFailedOutput(OLDER)];
    });
    const failure = await screen.findByTestId('video-lip-sync-failure');
    expect(failure).toHaveTextContent(`${ui('personNumber', { number: 4 })} · ${ui('personFailTimeout')}`);
    expect(failure).not.toHaveTextContent(ui('personNumber', { number: 5 }));
  });
});

describe('the lip-sync panel takes its people and dialogue caps from the canvas limits (§97; canvas design §4 lip-sync row)', () => {
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
    // The capped person carries the limit after its name (demo lip-sync-controls.tsx personCapReached suffix).
    const second = await screen.findByRole('option', { name: `Person 2${ui('personCapReached', { count: 1 })}` });
    await waitFor(() => expect(second).toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByRole('option', { name: 'Person 1' })).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(second);
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(t('server.mini_tool.lipSyncTooManyPeople', { max: 1 }));
    expect(rowsNow().find((row) => row.dialogueId === ROW_B)?.personId).toBeNull();
  });

  it('refuses a fourth dialogue row with maxDialogues 3', async () => {
    serve(limits(...ranges, { maxPeople: 1, maxDialogues: 3 }));
    await mount(false, [dialogue(ROW_A, 'person-a'), dialogue(ROW_B, 'person-a'), dialogue(ROW_C, 'person-a')]);
    const add = screen.getByRole('button', { name: ui('addDialogue') });
    await waitFor(() => expect(add).toHaveAttribute('aria-disabled', 'true'));
    expect(add).not.toBeDisabled();
    fireEvent.click(add);
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(t('server.mini_tool.lipSyncTooManyDialogues', { max: 3 }));
    expect(rowsNow()).toHaveLength(3);
  });
});

describe('the lip-sync footer shows the server quote for the current draft (§97 D26-1; execution design §9.3 pricing)', () => {
  const ranges = [{ minDurationSeconds: 1, maxDurationSeconds: 300 }, { minDurationSeconds: 0.5, maxDurationSeconds: 600 }] as const;
  // The catalog prices the models, so any number the panel computed itself would show; only the quote may reach the footer.
  const pricing = { base_price: 400_000, formula: '{"total_price": get_duration(video) * base_price}', discount_rate: 100 };
  const priced = (name: string): ModelEntry => ({ ...model(name, name), pricing, params: { video: { fill: 'tool', default: null }, audio: { fill: 'tool', default: null } } } as unknown as ModelEntry);
  const PRICED = { image: [], video: [priced('lipsync-configured-a'), priced('lipsync-configured-b')], audio: [], tts: [], three_d: [], total: 2, credit_multiplier: 1 } as unknown as ModelCatalog;
  const QUOTES: Readonly<Record<string, number>> = { 'lipsync-configured-a': 137.5, 'lipsync-configured-b': 260.25 };

  /**
   * The quote requests posted so far, in order.
   * @returns Their bodies.
   */
  function quoteBodies(): Record<string, unknown>[] {
    return http.post.mock.calls.filter(([path]) => path === '/mini-tools/quote').map(([, body]) => body as Record<string, unknown>);
  }

  /**
   * The footer's text.
   * @returns The text.
   */
  function footer(): string {
    return screen.getByTestId('mini-tool-credit').textContent ?? '';
  }

  /**
   * The host's committed lip-sync draft.
   * @returns The draft.
   */
  function draftNow(): VideoToolDraftById['video.lip-sync'] {
    const reading = readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, 'video.lip-sync');
    if (reading.state !== 'supported') throw new Error('Expected the committed lip-sync draft');
    return reading.draft as VideoToolDraftById['video.lip-sync'];
  }

  /**
   * Answers each quote request with the credits of the model its draft selects (the first configured one by default).
   * @returns Nothing.
   */
  function answerQuotes(): void {
    http.post.mockImplementation(async (path: string, body: { draft: VideoToolDraftById['video.lip-sync'] }): Promise<unknown> => {
      if (path !== '/mini-tools/quote') throw new Error(`Unexpected POST ${path}`);
      return { credits: QUOTES[body.draft.params.modelId ?? 'lipsync-configured-a'] };
    });
  }

  beforeEach(() => { catalog = PRICED; mounted = planned; });

  it('shows the quoted credits and posts the planned request of the current draft, creating no node', async () => {
    answerQuotes();
    serve(limits(...ranges));
    await mount(false, [dialogue(ROW_A, 'person-a')], ['person-a']);
    await waitFor(() => expect(footer()).toBe(formatCreditAmount(137.5)));
    const [body] = quoteBodies();
    expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ tool: 'video.lip-sync', project_id: projectId, space_id: spaceId, presentation_ref: PRESENTATION_REF });
    expect(body!.draft).toEqual(draftNow());
    expect(body!.analysis_refs).toEqual([expect.objectContaining({ toolId: 'video.lip-sync', kind: 'people', analysisRunId })]);
    const outputs = body!.outputs as { outputIndex: number; nodeId: string; recipe: unknown }[];
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ outputIndex: 0, recipe: { kind: 'lip-sync' } });
    expect(outputs[0]!.nodeId).not.toBe(nodeId);
    // A quote is not a run: the output node it names (generated by the panel, reused by the Run) is not put on the canvas yet.
    expect(readNodes(getDoc(docName.canvasSpace(projectId, spaceId))).map((node) => node.id)).toEqual([nodeId]);
  });

  it('quotes the changed draft again and shows the new answer', async () => {
    answerQuotes();
    serve(limits(...ranges));
    await mount(false, [dialogue(ROW_A, 'person-a')], ['person-a']);
    await waitFor(() => expect(footer()).toBe(formatCreditAmount(137.5)));
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    fireEvent.click(screen.getByTestId('generate-model-option-lipsync-configured-b'));
    await waitFor(() => expect(footer()).toBe(formatCreditAmount(260.25)));
    const latest = quoteBodies().at(-1)!;
    expect(miniToolPlannedRequestSchema.safeParse(latest).success).toBe(true);
    expect((latest.draft as VideoToolDraftById['video.lip-sync']).params.modelId).toBe('lipsync-configured-b');
    expect(latest.draft).toEqual(draftNow());
    // The output node id is generated when the draft is first quoted and kept for later quotes and the Run (D27-1).
    expect(latest.outputs).toEqual(quoteBodies()[0]!.outputs);
  });

  it('shows no number while the quote has not answered', async () => {
    http.post.mockImplementation(() => new Promise<never>(() => undefined));
    serve(limits(...ranges));
    await mount(false, [dialogue(ROW_A, 'person-a')], ['person-a']);
    await waitFor(() => expect(quoteBodies()).toHaveLength(1));
    // Give any number the panel could compute on its own (the catalog prices both models) the time to appear.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(footer()).not.toMatch(/\d/);
  });
});

describe('reopening the lip-sync panel keeps its identified people (§97; canvas design §4 lip-sync row)', () => {
  it('starts no people analysis and keeps the bound person when the draft already has an accepted one', async () => {
    mounted = planned;
    const started = vi.spyOn(miniToolAnalysesApi, 'start').mockImplementation(() => new Promise(() => undefined));
    serve(limits({ minDurationSeconds: 1, maxDurationSeconds: 300 }, { minDurationSeconds: 0.5, maxDurationSeconds: 600 }));
    await seed([dialogue(ROW_A, 'person-a')], ['person-a']);
    const host: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(modelCatalogQuery().queryKey, catalog);
    render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><MiniToolPanelContainer nodes={[host]} getLastWriteWasLocal={() => false} onRun={vi.fn()} videoPresentation={new Map([[nodeId, mounted]])} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(started).not.toHaveBeenCalled();
    const reading = readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, 'video.lip-sync');
    expect(reading.state === 'supported' ? (reading.draft as VideoToolDraftById['video.lip-sync']).params.dialogues.map((row) => row.personId) : null).toEqual(['person-a']);
  });
});
