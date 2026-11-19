// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 (canvas design §4 对口型行; packages/web/AGENTS.md#disabled-controls): Run is
 * `aria-disabled` and a click explains the allowed range with a toast when the result duration (shared `lipsyncTimeline`)
 * lies outside the selected model's `minDurationSeconds`/`maxDurationSeconds`, or the source range the run uses
 * (shared `lipsyncUsedSourceRange`) lies outside the tracking model's range; the toast is `canvas.miniTool.videoUI.
 * lipSyncDurationRange` `{min, max, duration}` or `lipSyncTrackingRange` `{min, max, length}` (D18). The panel prop `lipSync` (models and tracking
 * read from config `executions.video.lip-sync`) is a shape this test chose; no design fixes how web reads that config.
 *
 * Fixture: a 5 s video and one dialogue of 3 s audio starting at 0 s in cut_off mode, so the result lasts 3 s and the run
 * uses the source range [0, 3].
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { t } from '@breatic/shared';
import { fingerprintMiniToolAnalysisInput, projectMiniToolAnalysisInput, type MiniToolAnalysisRecord, type VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolAnalysisRef, commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';

const projectId = 'lipsync-project'; const spaceId = 'lipsync-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
const runId = '80000000-0000-4000-8000-000000000001';
const audioId = '40000000-0000-4000-8000-000000000009';
const frameTable = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 125, step: 4, duration: 4 }] };
const presentation: VideoToolPresentation = { frameTable, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0 };
const profile = { id: 'people', version: '1', weightsHash: null, params: {} };

type Range = { minDurationSeconds: number; maxDurationSeconds: number };
/**
 * The lip-sync config the panel receives: one model and the tracking model, each with its duration range.
 * @param model - The model's range.
 * @param tracking - The tracking model's range.
 * @returns The proposed `lipSync` prop.
 */
function lipSyncConfig(model: Range, tracking: Range): { models: (Range & { name: string; display_name: string })[]; tracking: Range } {
  return { models: [{ name: 'sync-lipsync-3', display_name: 'Sync Lipsync 3', ...model }], tracking };
}

/**
 * Commits a lip-sync draft whose one dialogue is bound to an identified person and a 3 s audio, with its people analysis.
 * @param modelId - The draft's chosen model, absent for the first configured one.
 * @returns Nothing.
 */
async function seed(modelId?: string): Promise<void> {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const initial = createVideoToolDraft('video.lip-sync', source);
  const draft: VideoToolDraftById['video.lip-sync'] = {
    ...initial,
    inputs: [{ inputId: audioId, url: 'https://assets.example.test/voice.m4a', mediaInfo: { duration: 3, mimeType: 'audio/mp4' } }],
    params: { ...initial.params, ...(modelId === undefined ? {} : { modelId }), dialogues: [{ ...initial.params.dialogues[0], personId: 'person-a', analysisRunId: runId, audioInputId: audioId, startTime: 0 }] },
  };
  commitVideoToolDraft(doc, nodeId, 'video.lip-sync', draft);
  const analysisInput = projectMiniToolAnalysisInput({ kind: 'people', source, params: draft.params, profile });
  const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
  const identity = {
    schemaVersion: 1 as const, draftId: draft.draftId, revision: draft.revision, analysisRunId: runId, acceptedAt: '2026-11-06T00:00:00.000001Z',
    binding: { assetId: '70000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: sourceURL, kind: 'video' as const, mediaInfo },
    analysisInput, inputFingerprint,
  };
  const record: MiniToolAnalysisRecord = {
    ...identity, kind: 'people', status: 'completed', artifactUnavailable: false, error: null, usage: [],
    result: { ...identity, kind: 'people', anchor: { frameIndex: 0, pts: 0 }, people: [{ personId: 'person-a', faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, artifactRefs: [] }] },
  };
  vi.spyOn(miniToolAnalysesApi, 'get').mockResolvedValue(record);
  commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.lip-sync', kind: 'people', draftId: draft.draftId, analysisRunId: runId, inputFingerprint });
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.lip-sync', { sourceContent: sourceURL, params: {} });
}

/**
 * Mounts the lip-sync panel and waits until the identified person is bound on its row.
 * @param lipSync - The proposed config prop.
 * @param onRunVideo - The execution entry.
 * @param modelId - The draft's chosen model, absent for the first configured one.
 * @returns The Run button.
 */
async function mount(lipSync: ReturnType<typeof lipSyncConfig>, onRunVideo: () => Promise<unknown>, modelId?: string): Promise<HTMLElement> {
  await seed(modelId);
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  const proposed: object = { lipSync };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.lip-sync' node={node} nodes={[node]} presentation={presentation} onRunVideo={onRunVideo} {...proposed} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
  // The row shows its person once the accepted people analysis is selected for this draft.
  await screen.findByText('Person 1');
  return screen.getByTestId('mini-tool-run');
}

/**
 * Presses Run and checks the press was refused with exactly the given toast.
 * @param run - The Run button.
 * @param onRunVideo - The execution entry that must stay unused.
 * @param message - The toast the refusal shows.
 * @returns Nothing.
 */
function expectRefused(run: HTMLElement, onRunVideo: () => Promise<unknown>, message: string): void {
  expect(run).toHaveAttribute('aria-disabled', 'true');
  expect(run).not.toBeDisabled();
  act(() => run.click());
  expect(onRunVideo).not.toHaveBeenCalled();
  expect(toast.warning).toHaveBeenCalledOnce();
  expect(toast.warning).toHaveBeenCalledWith(message);
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('lip-sync Run follows the model and tracking duration ranges (§97; canvas design §4 对口型)', () => {
  it('runs when the 3 s result and the [0, 3] source range fit both ranges', async () => {
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    const run = await mount(lipSyncConfig({ minDurationSeconds: 1, maxDurationSeconds: 10 }, { minDurationSeconds: 0.5, maxDurationSeconds: 10 }), onRunVideo);
    expect(run).not.toBeDisabled();
    expect(run).not.toHaveAttribute('aria-disabled', 'true');
    act(() => run.click());
    expect(onRunVideo).toHaveBeenCalledOnce();
  });

  it('refuses a 3 s result above the selected model maximum and names the model range', async () => {
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    const run = await mount(lipSyncConfig({ minDurationSeconds: 1.5, maxDurationSeconds: 2.5 }, { minDurationSeconds: 0.5, maxDurationSeconds: 10 }), onRunVideo);
    expectRefused(run, onRunVideo, t('canvas.miniTool.videoUI.lipSyncDurationRange', { min: 1.5, max: 2.5, duration: 3 }));
  });

  it('refuses a 3 s result below the selected model minimum and names the model range', async () => {
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    const run = await mount(lipSyncConfig({ minDurationSeconds: 3.5, maxDurationSeconds: 9.5 }, { minDurationSeconds: 0.5, maxDurationSeconds: 10 }), onRunVideo);
    expectRefused(run, onRunVideo, t('canvas.miniTool.videoUI.lipSyncDurationRange', { min: 3.5, max: 9.5, duration: 3 }));
  });

  it('refuses a [0, 3] source range longer than tracking accepts and names the tracking range', async () => {
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    const run = await mount(lipSyncConfig({ minDurationSeconds: 1, maxDurationSeconds: 10 }, { minDurationSeconds: 0.75, maxDurationSeconds: 2.25 }), onRunVideo);
    expectRefused(run, onRunVideo, t('canvas.miniTool.videoUI.lipSyncTrackingRange', { min: 0.75, max: 2.25, length: 3 }));
  });

  // Canvas design line 98: a model no longer in the configured list asks for another, as the generate panel does.
  it('refuses a draft whose model is no longer configured and asks for another', async () => {
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    const run = await mount(lipSyncConfig({ minDurationSeconds: 1, maxDurationSeconds: 10 }, { minDurationSeconds: 0.5, maxDurationSeconds: 10 }), onRunVideo, 'dropped-model');
    expectRefused(run, onRunVideo, t('canvas.generatePanel.modelUnavailable'));
  });
});
