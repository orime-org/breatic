// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '@web/data/api/mini-tools';
import type * as ToastModule from '@web/lib/toast';
import type { MiniToolPlannedRequest, VideoToolDraftById } from '@breatic/shared/mini-tools';
import { miniToolPlannedRequestSchema, planVideoFrames, planVideoSplit } from '@breatic/shared/mini-tools';
import { CANVAS_NODES_KEY, t } from '@breatic/shared';
import { miniToolsApi } from '@web/data/api/mini-tools';
import { ApiException } from '@web/data/api/types';
import { addNode, readNodes, readEdges, removeNode } from '@web/data/yjs/canvas-space';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { plannedRetryIntent, preparePlannedVideoRun, retryPlannedVideoRun, startPlannedVideoRun, type PlannedVideoRun } from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import { miniToolIntent } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { getRunning, resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useUploadMarksStore } from '@web/stores/upload-marks';
import { spendCapMessage } from '@web/lib/spend-cap-message';
import { toast } from '@web/lib/toast';

vi.mock('@web/data/api/mini-tools', async (original) => ({ ...(await original<typeof ApiModule>()), miniToolsApi: { ...(await original<typeof ApiModule>()).miniToolsApi, runPlanned: vi.fn(), retryPlannedVideoRun: vi.fn() } }));
vi.mock('@web/lib/toast', async (original) => ({ ...(await original<typeof ToastModule>()), toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const RESETS_AT = '2026-12-01T00:00:00.000Z';
const SPEND_CAP = new ApiException({ status: 402, message: 'This Studio reached its monthly limit.', reason: 'spend_cap_reached', fromServer: true,
  details: { scope: 'studio', limit: '10', resetsAt: RESETS_AT } });

const PROJECT = '10000000-0000-4000-8000-000000000001';
const SPACE = '10000000-0000-4000-8000-000000000002';
const SOURCE = '10000000-0000-4000-8000-000000000003';
const TASK = '10000000-0000-4000-8000-000000000004';
const URL = 'https://assets.example.test/original.webm';

/** Original editable source snapshot, independent of future preparation. @throws {never} Never. */
function draft(): VideoToolDraftById['video.split'] {
  return {
    version: 1, draftId: '10000000-0000-4000-8000-000000000005', revision: '10000000-0000-4000-8000-000000000006',
    source: { nodeId: SOURCE, canonicalURL: URL, mediaInfo: { width: 400, height: 200, duration: 0.28, mimeType: 'video/webm' } },
    inputs: [], params: { cuts: [] },
  };
}

// §95 (design §10.8 request row, §7.11): the press carries the selected bundle's identity as the request's presentation_ref, input
// id to {toolInputId, planSha256}; the field the press holds it in is `presentationRef` (question D9-4).
const PRESENTATION_REF = { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } };

/** Existing Canvas capabilities attached to a real source document. @throws {never} Never. */
function press(over: Partial<PlannedVideoRun> = {}): PlannedVideoRun {
  return { projectId: PROJECT, spaceId: SPACE, userId: 'author', toolId: 'video.split', draft: draft(), analyses: [], presentationRef: PRESENTATION_REF, grid: GRID,
    source: { id: SOURCE, name: 'ORIGINAL', position: { x: 30, y: 40 }, groupOrigin: null, width: 400, height: 200, mimeType: 'video/webm' },
    sourceExists: () => getDoc(docName.canvasSpace(PROJECT, SPACE)).getMap(CANVAS_NODES_KEY).has(SOURCE),
    canWrite: () => true, stillOpen: () => true, onBuilt: vi.fn(), ...over } as PlannedVideoRun;
}

/** The actual newly created destination nodes. @throws {never} Never. */
function targets(): ReturnType<typeof readNodes> {
  return readNodes(getDoc(docName.canvasSpace(PROJECT, SPACE))).filter((node) => node.id !== SOURCE && node.type !== 'group');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRunOnceForTests();
  useUploadMarksStore.setState({ marks: {} });
  addNode(PROJECT, SPACE, { id: SOURCE, type: 'video', position: { x: 30, y: 40 }, data: { content: URL, mediaWidth: 400, mediaHeight: 200, duration: 0.28, mimeType: 'video/webm', name: 'ORIGINAL', locked: false, createdBy: 'author', createdAt: 0, attachments: [] } });
  vi.mocked(miniToolsApi.runPlanned).mockResolvedValue({ task_id: TASK, status: 'pending' });
});
afterEach(() => { resetRunOnceForTests(); vi.useRealTimers(); destroyDoc(docName.canvasSpace(PROJECT, SPACE)); });

// The selected version's grid: seven frames at 25 fps (0.28 s), as the admission reads it.
const GRID = { fps: { numerator: 25, denominator: 1 }, frameCount: 7 };
const COMMON = { version: 1 as const, draftId: draft().draftId, revision: draft().revision, source: draft().source, inputs: [] };

// Frames and split name one output per planned frame or segment; each recipe is what the admission plans from the same grid
// with the same shared function (planVideoFrames, planVideoSplit), which the server requires to equal the request's outputs.
describe('planned frame and segment outputs', () => {
  it('F20 extracts the picked frame into one image destination whose recipe is the planned frame', async () => {
    const framesDraft: VideoToolDraftById['video.extract-frames'] = { ...COMMON, params: { mode: 'last', frameIndex: 0 } };
    const body = await preparePlannedVideoRun(press({ toolId: 'video.extract-frames', draft: framesDraft, grid: GRID }));
    const [frame] = planVideoFrames(GRID, framesDraft.params);
    expect(body?.outputs).toEqual([{ outputIndex: 0, nodeId: expect.any(String), recipe: { kind: 'frame', frameIndex: frame!.frameIndex } }]);
    expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
    expect(targets()).toEqual([expect.objectContaining({ id: body!.outputs[0]!.nodeId, type: 'image' })]);
  });

  it('F21 splits into one video destination per planned segment, in order', async () => {
    const splitDraft: VideoToolDraftById['video.split'] = { ...COMMON, params: { cuts: [2, 5] } };
    const body = await preparePlannedVideoRun(press({ toolId: 'video.split', draft: splitDraft, grid: GRID }));
    const segments = planVideoSplit(GRID, splitDraft.params.cuts);
    expect(segments).toHaveLength(3);
    expect(body?.outputs.map((output) => output.recipe)).toEqual(segments.map(({ start, end }) => ({ kind: 'segment', range: { start, end } })));
    expect(body?.outputs.map((output) => output.outputIndex)).toEqual([0, 1, 2]);
    expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
    expect(targets().map((node) => node.type)).toEqual(['video', 'video', 'video']);
    expect(new Set(targets().map((node) => node.id))).toEqual(new Set(body!.outputs.map((output) => output.nodeId)));
  });

  it('F22 builds nothing for a frame or segment run without the selected version grid', async () => {
    const splitDraft: VideoToolDraftById['video.split'] = { ...COMMON, params: { cuts: [2] } };
    await expect(preparePlannedVideoRun(press({ toolId: 'video.split', draft: splitDraft, grid: null }))).rejects.toThrow();
    expect(targets()).toHaveLength(0);
  });
});

describe('planned video press: independent frozen body and original graph', () => {
  it('F05 prepares one distinct video destination and a strict complete public request without touching its source', async () => {
    const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
    const original = doc.getMap(CANVAS_NODES_KEY).get(SOURCE);
    const sourceBefore = JSON.stringify(original);
    const run = press();
    const body = await preparePlannedVideoRun(run);
    expect(body).not.toBeNull();
    if (body === null) throw new Error('Expected prepared request');
    expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ tool: 'video.split', project_id: PROJECT, space_id: SPACE, run_id: expect.any(String), draft: draft(), analysis_refs: [], presentation_ref: PRESENTATION_REF, outputs: [{ outputIndex: 0, nodeId: expect.any(String), recipe: { kind: 'segment', range: { start: 0, end: 7 } } }] });
    expect(body.outputs[0]!.nodeId).not.toBe(SOURCE);
    expect(targets()).toHaveLength(1);
    expect(targets()[0]).toMatchObject({ id: body.outputs[0]!.nodeId, type: 'video', data: { name: 'SPLIT-ORIGINAL' } });
    expect(readEdges(doc)).toEqual([expect.objectContaining({ source: SOURCE, target: body.outputs[0]!.nodeId, toolId: 'video.split' })]);
    expect(JSON.stringify(original)).toBe(sourceBefore);
    expect(Object.keys(body).sort()).toEqual(['analysis_refs', 'draft', 'outputs', 'presentation_ref', 'project_id', 'run_id', 'space_id', 'tool']);
    expect(run.onBuilt).toHaveBeenCalledOnce();
  });

  it('F03 snapshots draft, source and copied inputs before its first asynchronous boundary', async () => {
    const run = press();
    run.draft.inputs.push({ inputId: '10000000-0000-4000-8000-000000000007', url: 'https://assets.example.test/copied.wav' });
    const frozen = structuredClone(run.draft);
    const preparing = preparePlannedVideoRun(run);
    run.draft.revision = '10000000-0000-4000-8000-000000000008';
    run.draft.source.canonicalURL = 'https://assets.example.test/later.webm';
    run.draft.source.mediaInfo.width = 900;
    run.draft.inputs[0]!.url = 'https://assets.example.test/later.wav';
    expect((await preparing)?.draft).toEqual(frozen);
  });

  it('F11 uses absolute Group origin for a top-level output without building a new Group', async () => {
    const body = await preparePlannedVideoRun(press({ source: { ...press().source, position: { x: 30, y: 40 }, groupOrigin: { x: 700, y: 900 } } }));
    expect(body).not.toBeNull();
    expect(targets()).toHaveLength(1);
    expect(targets()[0]!.position).toEqual({ x: 730 + NODE_STEP.x, y: 940 });
    expect(targets()[0]!.parentId).toBeUndefined();
    expect(readNodes(getDoc(docName.canvasSpace(PROJECT, SPACE))).filter((node) => node.type === 'group')).toEqual([]);
  });

  it.each(['missing-source', 'not-writable'] as const)('F02 stops %s before graph creation or POST', async (reason) => {
    const run = press(reason === 'missing-source' ? { sourceExists: () => false } : { canWrite: () => false });
    expect(await preparePlannedVideoRun(run)).toBeNull();
    expect(targets()).toEqual([]);
    expect(readEdges(getDoc(docName.canvasSpace(PROJECT, SPACE)))).toEqual([]);
    expect(miniToolsApi.runPlanned).not.toHaveBeenCalled();
  });

  it('F04 joins double press and panel reopen through the existing runOnce owner with one graph and body', async () => {
    let answer: ((value: ApiModule.MiniToolPlannedRunAnswer) => void) | undefined;
    vi.mocked(miniToolsApi.runPlanned).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const run = press();
    const first = startPlannedVideoRun(run);
    void first.catch(() => undefined);
    const again = startPlannedVideoRun(press({ onBuilt: vi.fn() }));
    void again.catch(() => undefined);
    await vi.waitFor(() => expect(miniToolsApi.runPlanned).toHaveBeenCalledOnce());
    expect(getRunning(miniToolIntent(SPACE, SOURCE, 'video.split'))).toBeDefined();
    expect(targets()).toHaveLength(1);
    expect(readEdges(getDoc(docName.canvasSpace(PROJECT, SPACE)))).toHaveLength(1);
    const body = vi.mocked(miniToolsApi.runPlanned).mock.calls[0]![0];
    expect(body.outputs[0]!.nodeId).toBe(targets()[0]!.id);
    expect(run.onBuilt).toHaveBeenCalledOnce();
    answer?.({ task_id: TASK, status: 'pending' });
    expect(await first).toEqual({ kind: 'done', result: { task_id: TASK, status: 'pending' } });
    expect(await again).toEqual(await first);
    expect(getRunning(miniToolIntent(SPACE, SOURCE, 'video.split'))).toBeUndefined();
    expect(useUploadMarksStore.getState().markOf(SPACE, body.outputs[0]!.nodeId)).toBeUndefined();
  });

  it('F04 resends an unknown answer with exactly the original key, run_id, body, targets and lineage', async () => {
    vi.useFakeTimers();
    vi.mocked(miniToolsApi.runPlanned).mockRejectedValueOnce(new ApiException({ status: 503, message: 'unavailable', retryAfterSeconds: 0.001 }));
    const run = press();
    const work = startPlannedVideoRun(run);
    void work.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(miniToolsApi.runPlanned).toHaveBeenCalledOnce();
    const sent = structuredClone(vi.mocked(miniToolsApi.runPlanned).mock.calls[0]!);
    run.draft.revision = '10000000-0000-4000-8000-000000000009';
    await vi.advanceTimersByTimeAsync(1);
    expect(await work).toEqual({ kind: 'done', result: { task_id: TASK, status: 'pending' } });
    expect(vi.mocked(miniToolsApi.runPlanned).mock.calls).toEqual([sent, sent]);
    expect(targets()).toHaveLength(1);
    expect(readEdges(getDoc(docName.canvasSpace(PROJECT, SPACE)))).toHaveLength(1);
  });

  // inner#1968 design 3.3a, 3.10: a press refused at a monthly spend limit says that limit on the nodes it built.
  it('M1-05 a press refused at a spend limit says the limit and its reset day on its output nodes', async () => {
    vi.mocked(miniToolsApi.runPlanned).mockRejectedValueOnce(SPEND_CAP);
    expect(await startPlannedVideoRun(press())).toMatchObject({ kind: 'failed' });
    const [node] = targets();
    expect(useUploadMarksStore.getState().markOf(SPACE, node!.id)).toMatchObject({ state: 'failed', message: { text: spendCapMessage('studio', '10', RESETS_AT) } });
  });

  it('F14 settles an accepted press after panel leave without stealing the new session or recreating a deleted target', async () => {
    let answer: ((value: ApiModule.MiniToolPlannedRunAnswer) => void) | undefined;
    let open = true;
    vi.mocked(miniToolsApi.runPlanned).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const run = press({ stillOpen: () => open });
    const work = startPlannedVideoRun(run);
    void work.catch(() => undefined);
    await vi.waitFor(() => expect(miniToolsApi.runPlanned).toHaveBeenCalledOnce());
    const body: MiniToolPlannedRequest = vi.mocked(miniToolsApi.runPlanned).mock.calls[0]![0];
    const builtCalls = vi.mocked(run.onBuilt).mock.calls.length;
    open = false;
    removeNode(PROJECT, SPACE, body.outputs[0]!.nodeId);
    answer?.({ task_id: TASK, status: 'running' });
    expect(await work).toEqual({ kind: 'done', result: { task_id: TASK, status: 'running' } });
    expect(targets()).toEqual([]);
    expect(vi.mocked(run.onBuilt).mock.calls).toHaveLength(builtCalls);
    expect(readNodes(getDoc(docName.canvasSpace(PROJECT, SPACE)))[0]).toMatchObject({ data: { content: URL } });
  });
});

// One retry of a planned run's failed output, shared by the output node's task row and the host's tool panel (inner#1306 #24):
// one intent per output, the retry body, the send and the refusal toast.
describe('retrying a planned run\'s failed output', () => {
  const RUN = '10000000-0000-4000-8000-000000000009';

  it('sends one retry of that output under its intent and reports it done', async () => {
    vi.mocked(miniToolsApi.retryPlannedVideoRun).mockResolvedValue({ task_id: TASK, status: 'pending' });
    const onDone = vi.fn();
    const first = retryPlannedVideoRun({ projectId: PROJECT, spaceId: SPACE, tool: 'video.split', runId: RUN, outputIndex: 2, onDone });
    expect(getRunning(plannedRetryIntent(RUN, 2))).toBe(true);
    const second = retryPlannedVideoRun({ projectId: PROJECT, spaceId: SPACE, tool: 'video.split', runId: RUN, outputIndex: 2, onDone });
    await expect(first).resolves.toMatchObject({ kind: 'done' });
    await second;
    expect(miniToolsApi.retryPlannedVideoRun).toHaveBeenCalledOnce();
    const [body] = vi.mocked(miniToolsApi.retryPlannedVideoRun).mock.calls[0]!;
    expect(body).toMatchObject({ tool: 'video.split', project_id: PROJECT, space_id: SPACE, retry: { runId: RUN, outputIndexes: [2] } });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('M1-06 says the spend limit when the retry is refused at it', async () => {
    vi.mocked(miniToolsApi.retryPlannedVideoRun).mockRejectedValue(SPEND_CAP);
    await retryPlannedVideoRun({ projectId: PROJECT, spaceId: SPACE, tool: 'video.split', runId: RUN, onDone: vi.fn() });
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(spendCapMessage('studio', '10', RESETS_AT));
  });

  it('says why the retry was refused', async () => {
    vi.mocked(miniToolsApi.retryPlannedVideoRun).mockRejectedValue(new Error('down'));
    const onDone = vi.fn();
    await retryPlannedVideoRun({ projectId: PROJECT, spaceId: SPACE, tool: 'video.split', runId: RUN, onDone });
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(t('canvas.miniTool.panel.couldNotStart'));
    expect(onDone).not.toHaveBeenCalled();
  });
});
