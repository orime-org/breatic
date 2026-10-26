// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '@web/data/api/mini-tools';
import type * as ToastModule from '@web/lib/toast';
import type { MiniToolPlannedRequest, VideoToolDraftById } from '@breatic/shared/mini-tools';
import { miniToolPlannedRequestSchema } from '@breatic/shared/mini-tools';
import { CANVAS_NODES_KEY } from '@breatic/shared';
import { miniToolsApi } from '@web/data/api/mini-tools';
import { ApiException } from '@web/data/api/types';
import { addNode, readNodes, readEdges, removeNode } from '@web/data/yjs/canvas-space';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { preparePlannedVideoRun, startPlannedVideoRun, type PlannedVideoRun } from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import { miniToolIntent } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { getRunning, resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useUploadMarksStore } from '@web/stores/upload-marks';

vi.mock('@web/data/api/mini-tools', async (original) => ({ ...(await original<typeof ApiModule>()), miniToolsApi: { ...(await original<typeof ApiModule>()).miniToolsApi, runPlanned: vi.fn() } }));
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

/** Existing Canvas capabilities attached to a real source document. @throws {never} Never. */
function press(over: Partial<PlannedVideoRun> = {}): PlannedVideoRun {
  return { projectId: PROJECT, spaceId: SPACE, userId: 'author', toolId: 'video.remove-bg', draft: draft(), analyses: [],
    source: { id: SOURCE, name: 'ORIGINAL', position: { x: 30, y: 40 }, groupOrigin: null, width: 400, height: 200, mimeType: 'video/webm' },
    sourceExists: () => getDoc(docName.canvasSpace(PROJECT, SPACE)).getMap(CANVAS_NODES_KEY).has(SOURCE),
    canWrite: () => true, stillOpen: () => true, onBuilt: vi.fn(), ...over };
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
    expect(body).toEqual({ tool: 'video.remove-bg', project_id: PROJECT, space_id: SPACE, run_id: expect.any(String), draft: draft(), analysis_refs: [], outputs: [{ outputIndex: 0, nodeId: expect.any(String), recipe: { kind: 'remove-bg' } }] });
    expect(body.outputs[0]!.nodeId).not.toBe(SOURCE);
    expect(targets()).toHaveLength(1);
    expect(targets()[0]).toMatchObject({ id: body.outputs[0]!.nodeId, type: 'video', data: { name: 'MATTE-ORIGINAL' } });
    expect(readEdges(doc)).toEqual([expect.objectContaining({ source: SOURCE, target: body.outputs[0]!.nodeId, toolId: 'video.remove-bg' })]);
    expect(JSON.stringify(original)).toBe(sourceBefore);
    expect(Object.keys(body).sort()).toEqual(['analysis_refs', 'draft', 'outputs', 'project_id', 'run_id', 'space_id', 'tool']);
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
