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
import { toast } from '@web/lib/toast';

vi.mock('@web/data/api/mini-tools', async (original) => ({ ...(await original<typeof ApiModule>()), miniToolsApi: { ...(await original<typeof ApiModule>()).miniToolsApi, runPlanned: vi.fn(), retryPlannedVideoRun: vi.fn() } }));
vi.mock('@web/lib/toast', async (original) => ({ ...(await original<typeof ToastModule>()), toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const PROJECT = '10000000-0000-4000-8000-000000000001';
const SPACE = '10000000-0000-4000-8000-000000000002';
const SOURCE = '10000000-0000-4000-8000-000000000003';
const TASK = '10000000-0000-4000-8000-000000000004';
const URL = 'https://assets.example.test/original.webm';

/** Original editable source snapshot, independent of future preparation. @throws {never} Never. */
function draft(): VideoToolDraftById['video.remove-bg'] {
  return {
    version: 1, draftId: '10000000-0000-4000-8000-000000000005', revision: '10000000-0000-4000-8000-000000000006',
    source: { nodeId: SOURCE, canonicalURL: URL, mediaInfo: { width: 400, height: 200, duration: 0.28, mimeType: 'video/webm' } },
    inputs: [], params: {},
  };
}

// §95 (design §10.8 request row, §7.11): the press carries the selected bundle's identity as the request's presentation_ref, input
// id to {toolInputId, planSha256}; the field the press holds it in is `presentationRef` (question D9-4).
const PRESENTATION_REF = { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } };

/** Existing Canvas capabilities attached to a real source document. @throws {never} Never. */
function press(over: Partial<PlannedVideoRun> = {}): PlannedVideoRun {
  return { projectId: PROJECT, spaceId: SPACE, userId: 'author', toolId: 'video.remove-bg', draft: draft(), analyses: [], presentationRef: PRESENTATION_REF,
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

// The source's compact presentation table: seven 40 ms frames (0.28 s), as the admission reads it.
const TABLE = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 7, step: 4, duration: 4 }] };
const COMMON = { version: 1 as const, draftId: draft().draftId, revision: draft().revision, source: draft().source, inputs: [] };

// Frames and split name one output per planned frame or segment; each recipe is what the admission plans from the same table
// with the same shared function (planVideoFrames, planVideoSplit), which the server requires to equal the request's outputs.
describe('planned frame and segment outputs', () => {
  it('F20 extracts the picked frame into one image destination whose recipe is the planned frame', async () => {
    const framesDraft: VideoToolDraftById['video.extract-frames'] = { ...COMMON, params: { mode: 'last', currentTime: 0 } };
    const body = await preparePlannedVideoRun(press({ toolId: 'video.extract-frames', draft: framesDraft, frameTable: TABLE }));
    const [frame] = planVideoFrames(TABLE, framesDraft.params);
    expect(body?.outputs).toEqual([{ outputIndex: 0, nodeId: expect.any(String), recipe: { kind: 'frame', frameIndex: frame!.frameIndex, pts: frame!.pts } }]);
    expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
    expect(targets()).toEqual([expect.objectContaining({ id: body!.outputs[0]!.nodeId, type: 'image' })]);
  });

  it('F21 splits into one video destination per planned segment, in order', async () => {
    const splitDraft: VideoToolDraftById['video.split'] = { ...COMMON, params: { cuts: [0.1, 0.2] } };
    const body = await preparePlannedVideoRun(press({ toolId: 'video.split', draft: splitDraft, frameTable: TABLE }));
    const segments = planVideoSplit(TABLE, splitDraft.params.cuts);
    expect(segments).toHaveLength(3);
    expect(body?.outputs.map((output) => output.recipe)).toEqual(segments.map(({ start, end }) => ({ kind: 'segment', range: { start, end } })));
    expect(body?.outputs.map((output) => output.outputIndex)).toEqual([0, 1, 2]);
    expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
    expect(targets().map((node) => node.type)).toEqual(['video', 'video', 'video']);
    expect(new Set(targets().map((node) => node.id))).toEqual(new Set(body!.outputs.map((output) => output.nodeId)));
  });

  // Execution design §10.5 geometry row: the expand node is sized by shared videoExpandLayout, as the quote and the admission are.
  it('F23 sizes an expand destination as the widened frame, each side rounded up to even', async () => {
    const expandDraft: VideoToolDraftById['video.expand'] = { ...COMMON, params: { frame: { x: -0.25, y: -0.1, width: 1.5025, height: 1.2 }, ratio: 'free', prompt: '' } };
    const body = await preparePlannedVideoRun(press({ toolId: 'video.expand', draft: expandDraft }));
    expect(body?.outputs.map((output) => output.recipe)).toEqual([{ kind: 'expand' }]);
    expect(targets().map((node) => node.type === 'video' ? [node.data.width, node.data.height] : null)).toEqual([[602, 240]]);
  });

  // Execution design §10.5: admission lays the target out on the ledger's display size, which applies the sample aspect ratio.
  it('F26 sizes an anamorphic source\'s expand destination from the presentation display size', async () => {
    const anamorphic = { ...COMMON, source: { ...COMMON.source, mediaInfo: { ...COMMON.source.mediaInfo, width: 1440, height: 1080 } } };
    const expandDraft: VideoToolDraftById['video.expand'] = { ...anamorphic, params: { frame: { x: 0, y: -0.5 + 1080 / 3840, width: 1, height: 1920 / 1080 }, ratio: '1:1', prompt: '' } };
    await preparePlannedVideoRun(press({ toolId: 'video.expand', draft: expandDraft, display: { width: 1920, height: 1080 } }));
    expect(targets().map((node) => node.type === 'video' ? [node.data.width, node.data.height] : null)).toEqual([[1920, 1920]]);
  });

  it('F22 builds nothing for a frame or segment run without the source table', async () => {
    const splitDraft: VideoToolDraftById['video.split'] = { ...COMMON, params: { cuts: [0.1] } };
    await expect(preparePlannedVideoRun(press({ toolId: 'video.split', draft: splitDraft, frameTable: null }))).rejects.toThrow();
    expect(targets()).toHaveLength(0);
  });
});

// Canvas design §4 transitions row (a new composed video, linked from the current and input nodes) and tools design §5 (result edges come from the current and input nodes): a
// transitions result is linked from the current node and from the picked input's node, in the press's one undo batch.
describe('a transitions result is linked from both of its videos', () => {
  const PICKED_NODE = '10000000-0000-4000-8000-000000000007';
  const CURRENT = '80000000-0000-4000-8000-000000000001'; const PICKED = '80000000-0000-4000-8000-000000000002';
  const media = { width: 400, height: 200, duration: 5, mimeType: 'video/webm' };
  /** A two-clip transitions draft of the host and the picked node. @param picked - The picked input's node. @returns The draft. */
  const transitions = (picked: string | undefined = PICKED_NODE): VideoToolDraftById['video.transitions'] => ({
    version: 1, draftId: draft().draftId, revision: draft().revision, source: { ...draft().source, mediaInfo: media },
    inputs: [{ inputId: CURRENT, url: URL, mediaInfo: media, sourceNodeId: SOURCE },
      { inputId: PICKED, url: 'https://assets.example.test/picked.webm', mediaInfo: media, ...(picked === undefined ? {} : { sourceNodeId: picked }) }],
    params: { clips: [
      { clipId: '90000000-0000-4000-8000-000000000011', inputId: CURRENT, in: 0, out: 4, transition: { kind: 'fade', duration: 0.5 } },
      { clipId: '90000000-0000-4000-8000-000000000012', inputId: PICKED, in: 0, out: 4, transition: { kind: 'cut', duration: 0 } },
    ] },
  }) as VideoToolDraftById['video.transitions'];
  const REF = { [CURRENT]: { toolInputId: 'a'.repeat(64), planSha256: 'd'.repeat(64) }, [PICKED]: { toolInputId: 'b'.repeat(64), planSha256: 'd'.repeat(64) } };

  it('F24 adds an edge from the host and one from the picked input node to the result', async () => {
    addNode(PROJECT, SPACE, { id: PICKED_NODE, type: 'video', position: { x: 0, y: 400 }, data: { content: 'https://assets.example.test/picked.webm', name: 'PICKED', locked: false, createdBy: 'author', createdAt: 0, attachments: [] } });
    const body = await preparePlannedVideoRun(press({ toolId: 'video.transitions', draft: transitions(), presentationRef: REF as PlannedVideoRun['presentationRef'] }));
    const output = body!.outputs[0]!.nodeId;
    const edges = readEdges(getDoc(docName.canvasSpace(PROJECT, SPACE))).map((edge) => ({ source: edge.source, target: edge.target, toolId: edge.toolId }));
    expect(edges).toEqual(expect.arrayContaining([{ source: SOURCE, target: output, toolId: 'video.transitions' }, { source: PICKED_NODE, target: output, toolId: 'video.transitions' }]));
    expect(edges).toHaveLength(2);
  });

  it('F25 adds no edge from a picked node that no longer exists', async () => {
    const body = await preparePlannedVideoRun(press({ toolId: 'video.transitions', draft: transitions(), presentationRef: REF as PlannedVideoRun['presentationRef'] }));
    const output = body!.outputs[0]!.nodeId;
    expect(readEdges(getDoc(docName.canvasSpace(PROJECT, SPACE))).map((edge) => edge.source + '>' + edge.target)).toEqual([`${SOURCE}>${output}`]);
  });
});

// Canvas design §3 inputs row (sourceNodeId gives the edge relation): a lip-sync result is linked from each dialogue audio
// node it uses that is still on the canvas, as a transitions result is from its picked video.
describe('a lip-sync result is linked from its dialogue audio nodes', () => {
  const AUDIO_NODE = '10000000-0000-4000-8000-000000000008';
  const GONE_NODE = '10000000-0000-4000-8000-000000000009';
  const AUDIO = '80000000-0000-4000-8000-000000000003'; const GONE = '80000000-0000-4000-8000-000000000004';
  const lipSync: VideoToolDraftById['video.lip-sync'] = { ...COMMON,
    inputs: [{ inputId: AUDIO, url: 'https://assets.example.test/a.mp3', mediaInfo: { duration: 1 }, sourceNodeId: AUDIO_NODE }, { inputId: GONE, url: 'https://assets.example.test/b.mp3', mediaInfo: { duration: 1 }, sourceNodeId: GONE_NODE }],
    params: { anchor: { frameIndex: 0, pts: 0 }, syncMode: 'cut_off', dialogues: [
      { dialogueId: '90000000-0000-4000-8000-000000000021', personId: 'p1', analysisRunId: '90000000-0000-4000-8000-000000000031', audioInputId: AUDIO, startTime: 0 },
      { dialogueId: '90000000-0000-4000-8000-000000000022', personId: 'p1', analysisRunId: '90000000-0000-4000-8000-000000000031', audioInputId: GONE, startTime: 0 },
    ] } } as VideoToolDraftById['video.lip-sync'];

  it('F27 adds an edge from the host and from each dialogue audio node still on the canvas', async () => {
    addNode(PROJECT, SPACE, { id: AUDIO_NODE, type: 'audio', position: { x: 0, y: 400 }, data: { content: 'https://assets.example.test/a.mp3', name: 'A', locked: false, createdBy: 'author', createdAt: 0, attachments: [] } });
    const body = await preparePlannedVideoRun(press({ toolId: 'video.lip-sync', draft: lipSync }));
    const output = body!.outputs[0]!.nodeId;
    expect(readEdges(getDoc(docName.canvasSpace(PROJECT, SPACE))).map((edge) => `${edge.source}>${edge.target}:${edge.toolId}`).sort())
      .toEqual([`${AUDIO_NODE}>${output}:video.lip-sync`, `${SOURCE}>${output}:video.lip-sync`].sort());
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
    expect(body).toEqual({ tool: 'video.remove-bg', project_id: PROJECT, space_id: SPACE, run_id: expect.any(String), draft: draft(), analysis_refs: [], presentation_ref: PRESENTATION_REF, outputs: [{ outputIndex: 0, nodeId: expect.any(String), recipe: { kind: 'remove-bg' } }] });
    expect(body.outputs[0]!.nodeId).not.toBe(SOURCE);
    expect(targets()).toHaveLength(1);
    expect(targets()[0]).toMatchObject({ id: body.outputs[0]!.nodeId, type: 'video', data: { name: 'MATTE-ORIGINAL' } });
    expect(readEdges(doc)).toEqual([expect.objectContaining({ source: SOURCE, target: body.outputs[0]!.nodeId, toolId: 'video.remove-bg' })]);
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
    expect(getRunning(miniToolIntent(SPACE, SOURCE, 'video.remove-bg'))).toBeDefined();
    expect(targets()).toHaveLength(1);
    expect(readEdges(getDoc(docName.canvasSpace(PROJECT, SPACE)))).toHaveLength(1);
    const body = vi.mocked(miniToolsApi.runPlanned).mock.calls[0]![0];
    expect(body.outputs[0]!.nodeId).toBe(targets()[0]!.id);
    expect(run.onBuilt).toHaveBeenCalledOnce();
    answer?.({ task_id: TASK, status: 'pending' });
    expect(await first).toEqual({ kind: 'done', result: { task_id: TASK, status: 'pending' } });
    expect(await again).toEqual(await first);
    expect(getRunning(miniToolIntent(SPACE, SOURCE, 'video.remove-bg'))).toBeUndefined();
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

  it('says why the retry was refused', async () => {
    vi.mocked(miniToolsApi.retryPlannedVideoRun).mockRejectedValue(new Error('down'));
    const onDone = vi.fn();
    await retryPlannedVideoRun({ projectId: PROJECT, spaceId: SPACE, tool: 'video.lip-sync', runId: RUN, onDone });
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(t('canvas.miniTool.panel.couldNotStart'));
    expect(onDone).not.toHaveBeenCalled();
  });
});
