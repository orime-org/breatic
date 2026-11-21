// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 frames-split §7.13 Dv current row ("the revision must match to commit; otherwise read the latest and say so"):
 * a scene detection that finishes after the user edited its split draft is not applied, because the edit wins, and the panel
 * says so once with an info toast instead of dropping it silently.
 *
 * Fixture: a 5 s 960x540 source on a 25 fps grid of 125 frames.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const records = new Map<string, unknown>();
vi.mock('@web/data/api/mini-tool-analyses', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/api/mini-tool-analyses')>();
  // The server's answer is the record the test holds for that run.
  return { ...actual, miniToolAnalysisQuery: (runId: string) => ({ ...actual.miniToolAnalysisQuery(runId), queryFn: () => Promise.resolve(records.get(runId)) }) };
});

import { newId, t } from '@breatic/shared';
import { fingerprintMiniToolAnalysisInput, projectMiniToolAnalysisInput, type MiniToolAnalysisRecord } from '@breatic/shared/mini-tools';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolAnalysisRef, commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { miniToolAnalysisQuery } from '@web/data/api/mini-tool-analyses';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';

const projectId = 'scene-project'; const spaceId = 'scene-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
const profile = { id: 'pyscenedetect-content', version: '0.7.2', weightsHash: null, params: { threshold: 27, minSceneLength: 15 } };

/**
 * One accepted scene detection of the split draft's revision.
 * @param runId - The analysis run.
 * @param revision - The draft revision it froze.
 * @param draftId - The draft it belongs to.
 * @param status - Its calculation status.
 * @returns The record.
 */
async function sceneRecord(runId: string, revision: string, draftId: string, status: 'running' | 'completed'): Promise<MiniToolAnalysisRecord> {
  const analysisInput = projectMiniToolAnalysisInput({ kind: 'scene_cuts', source, params: { range: { start: 0, end: grid.frameCount } }, profile });
  const identity = {
    schemaVersion: 1 as const, draftId, revision, analysisRunId: runId, acceptedAt: '2026-10-25T09:03:03.100001Z',
    binding: { assetId: '50000000-0000-4000-8000-000000000001', contentHash: 'b'.repeat(64), canonicalURL: sourceURL, kind: 'video' as const, mediaInfo },
    analysisInput, inputFingerprint: await fingerprintMiniToolAnalysisInput(analysisInput),
  };
  return status === 'running'
    ? { ...identity, kind: 'scene_cuts', status, result: null, error: null, usage: [], artifactUnavailable: false }
    : { ...identity, kind: 'scene_cuts', status, error: null, usage: [], artifactUnavailable: false, result: { ...identity, kind: 'scene_cuts', fps: grid.fps, frameCount: grid.frameCount, cuts: [{ frameIndex: 43, detectionScore: 31 }] } };
}

/**
 * Mounts a split panel whose draft has an accepted scene detection in the given state.
 * @param status - The detection's state at mount.
 * @returns The query client, the run, and the draft's revision the detection froze.
 */
async function mount(status: 'running' | 'completed'): Promise<{ client: QueryClient; runId: string; draftId: string; revision: string }> {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const draft = createVideoToolDraft('video.split', source);
  commitVideoToolDraft(doc, nodeId, 'video.split', draft);
  const runId = newId();
  const record = await sceneRecord(runId, draft.revision, draft.draftId, status);
  records.set(runId, record);
  commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.split', kind: 'scene_cuts', draftId: draft.draftId, analysisRunId: runId, inputFingerprint: record.inputFingerprint });
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.split', { sourceContent: sourceURL, params: {} });
  const presentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0 } as VideoToolPresentation;
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.split' node={node} presentation={presentation} onRunVideo={vi.fn()} costs={{ execution: '1' }} maxOutputs={50} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
  return { client, runId, draftId: draft.draftId, revision: draft.revision };
}

/**
 * Makes the user's own edit of the split draft: a new revision with one cut.
 * @throws {Error} When the fixture has no draft.
 */
function editDraft(): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const held = readVideoToolDraft(doc, nodeId, 'video.split');
  if (held.state !== 'supported') throw new Error('Missing draft');
  commitVideoToolDraft(doc, nodeId, 'video.split', { ...held.draft, revision: newId(), params: { ...held.draft.params, cuts: [30] } });
}

/**
 * The cuts the stored split draft holds.
 * @returns The cuts.
 */
function storedCuts(): readonly number[] {
  const held = readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, 'video.split');
  return held.state === 'supported' ? held.draft.params.cuts : [];
}

beforeEach(() => { vi.clearAllMocks(); records.clear(); });
afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('a scene detection that finishes on an earlier edit (frames-split §7.13 Dv current row)', () => {
  it('keeps the edit and says so once when the detection completes after the draft changed', async () => {
    const { client, runId, draftId, revision } = await mount('running');
    // The panel holds the running detection once its button offers to detect again.
    await waitFor(() => expect(screen.getByTestId('video-detect-scenes')).toHaveTextContent(t('canvas.miniTool.videoUI.detectAgain')));
    act(() => editDraft());
    const completed = await sceneRecord(runId, revision, draftId, 'completed');
    records.set(runId, completed);
    act(() => client.setQueryData(miniToolAnalysisQuery(runId).queryKey, completed));
    await waitFor(() => expect(toast.info).toHaveBeenCalledExactlyOnceWith(t('canvas.miniTool.videoUI.detectionSuperseded')));
    expect(storedCuts()).toEqual([30]);
    act(() => editDraft());
    await act(async () => { await client.invalidateQueries({ queryKey: miniToolAnalysisQuery(runId).queryKey }); });
    expect(toast.info).toHaveBeenCalledOnce();
  });

  it('applies a detection that completes on the revision it froze and says nothing', async () => {
    const { client, runId, draftId, revision } = await mount('running');
    // The panel holds the running detection once its button offers to detect again.
    await waitFor(() => expect(screen.getByTestId('video-detect-scenes')).toHaveTextContent(t('canvas.miniTool.videoUI.detectAgain')));
    const completed = await sceneRecord(runId, revision, draftId, 'completed');
    records.set(runId, completed);
    act(() => client.setQueryData(miniToolAnalysisQuery(runId).queryKey, completed));
    await waitFor(() => expect(storedCuts()).toEqual([43]));
    expect(toast.info).not.toHaveBeenCalled();
  });
});
