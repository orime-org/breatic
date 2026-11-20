// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 lip-sync person boxes on the node (demo lip-sync-controls.tsx FaceOverlay and redetectPatch; canvas design line 98):
 * - E1: the box of the person bound to the active dialogue row (the first row until one is chosen) is the selected one;
 * - E6: after a failed re-detect, the earlier identification's boxes stay hidden;
 * - a box whose person would take the run past the people limit is aria-disabled, and its press toasts the limit and leaves
 *   the row as it was.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), apiGet: http.get, apiPost: http.post }));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@web/spaces/canvas/mini-tool/FilmStrip', () => ({ FilmStrip: () => null }));
vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { t } from '@breatic/shared';
import { fingerprintMiniToolAnalysisInput, projectMiniToolAnalysisInput, type MiniToolAnalysisRecord, type VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolPanelContainer } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolAnalysisRef, commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { canvasSessions } from '@web/stores/canvas-session';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { TooltipProvider } from '@web/components/ui/tooltip';
import type { MediaSurfaceBinding } from '../../video-presentation/types';
import { readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { toast } from '@web/lib/toast';

const projectId = '01000000-0000-4000-8000-000000000002'; const spaceId = '02000000-0000-4000-8000-000000000002';
const nodeId = '10000000-0000-4000-8000-000000000003';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
const RUN_A = '80000000-0000-4000-8000-00000000000a'; const RUN_B = '80000000-0000-4000-8000-00000000000b';
const ROW_A = '41000000-0000-4000-8000-00000000000a'; const ROW_B = '41000000-0000-4000-8000-00000000000b';
// The selected version's grid at 25 fps.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
const profile = { id: 'people', version: '1', weightsHash: null, params: {} };
let target: HTMLElement | null = null;

afterEach(() => { target?.remove(); target = null; destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); resetRunOnceForTests(); vi.restoreAllMocks(); });

/**
 * Seeds a lip-sync draft whose two rows are bound to person-a and person-b of a completed identification, with an optional
 * later identification that failed, then mounts the panel over a node display.
 * @param failedLater - Whether a later identification failed.
 * @param options - Overrides: each row's person, and the people limit.
 * @param options.persons - Each row's person, in row order.
 * @param options.maxPeople - The people limit.
 * @returns Nothing.
 */
async function mount(failedLater: boolean, options: { persons?: readonly (string | null)[]; maxPeople?: number } = {}): Promise<void> {
  http.get.mockRejectedValue(new Error('not served'));
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const initial = createVideoToolDraft('video.lip-sync', source);
  const rows = [ROW_A, ROW_B].map((dialogueId, index) => ({ dialogueId, personId: failedLater ? null : options.persons?.[index] !== undefined ? options.persons[index] : `person-${'ab'[index]}`, analysisRunId: failedLater ? null : RUN_A, audioInputId: null, startTime: 0 }));
  const draft: VideoToolDraftById['video.lip-sync'] = { ...initial, params: { ...initial.params, dialogues: rows } };
  commitVideoToolDraft(doc, nodeId, 'video.lip-sync', draft);
  const analysisInput = projectMiniToolAnalysisInput({ kind: 'people', source, params: draft.params, profile });
  const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
  /**
   * One identification record of this draft.
   * @param analysisRunId - The run.
   * @param acceptedAt - When it was accepted.
   * @param completed - Whether it found people, or failed.
   * @returns The record.
   */
  const record = (analysisRunId: string, acceptedAt: string, completed: boolean): MiniToolAnalysisRecord => {
    const identity = { schemaVersion: 1 as const, draftId: draft.draftId, revision: draft.revision, analysisRunId, acceptedAt, binding: { assetId: '70000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: sourceURL, kind: 'video' as const, mediaInfo }, analysisInput, inputFingerprint };
    return completed
      ? { ...identity, kind: 'people', status: 'completed', artifactUnavailable: false, error: null, usage: [], result: { ...identity, kind: 'people', anchor: { frameIndex: 0 }, people: ['person-a', 'person-b'].map((personId, index) => ({ personId, faceBox: { x: 0.1 + index * 0.4, y: 0.1, width: 0.2, height: 0.2 }, artifactRefs: [] })) } }
      : { ...identity, kind: 'people', status: 'failed', artifactUnavailable: false, error: { code: 'failed', message: 'failed' }, usage: [], result: null } as unknown as MiniToolAnalysisRecord;
  };
  const records = new Map([[RUN_A, record(RUN_A, '2026-11-06T00:00:00.000001Z', true)], ...(failedLater ? [[RUN_B, record(RUN_B, '2026-11-07T00:00:00.000001Z', false)] as const] : [])]);
  vi.spyOn(miniToolAnalysesApi, 'get').mockImplementation(async (id: string) => records.get(id)!);
  for (const id of records.keys()) commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.lip-sync', kind: 'people', draftId: draft.draftId, analysisRunId: id, inputFingerprint });
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.lip-sync', { sourceContent: sourceURL, params: {} });
  target = document.createElement('div'); document.body.append(target);
  const element = document.createElement('video'); const surface = document.createElement('canvas');
  const frame = { sourceKey: 'canonical-key', sourceEpoch: 1, seekEpoch: 1, mediaTime: 0, surface };
  const binding: MediaSurfaceBinding = { sourceKey: frame.sourceKey, sourceEpoch: 1, element, surface, container: target, original: mediaInfo, getSeekEpoch: () => 1, getPresentedFrame: () => frame, seek: vi.fn(), play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() };
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.lip-sync' node={node} nodes={[node]} overlayTarget={target} binding={binding} lipSync={{ models: [], tracking: { minDurationSeconds: 0.5, maxDurationSeconds: 600 }, maxPeople: options.maxPeople }} presentation={{ grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0 }} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId('video-identify-people')).toBeInTheDocument());
}

/**
 * The person boxes drawn on the node.
 * @returns The boxes in detection order.
 */
function boxes(): HTMLElement[] {
  return within(screen.getByTestId('video-tool-node-overlay')).queryAllByRole('button').filter((button) => button.hasAttribute('aria-pressed'));
}

describe('lip-sync person boxes on the node', () => {
  it('E1 selects the first row\'s person until a row is chosen, then the chosen row\'s person', async () => {
    await mount(false);
    await waitFor(() => expect(boxes()).toHaveLength(2));
    expect(boxes().map((box) => box.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    act(() => canvasSessions.of(spaceId).getState().setMiniToolParam('activeDialogueId', ROW_B));
    expect(boxes().map((box) => box.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(boxes()[0]!.className).not.toContain('status-selected');
  });

  it('E6 keeps the earlier identification\'s boxes hidden after a failed re-detect', async () => {
    await mount(true);
    await waitFor(() => expect(screen.getByTestId('video-identify-people')).toHaveTextContent(/.+/));
    await waitFor(() => expect(miniToolAnalysesApi.get).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(boxes()).toHaveLength(0);
  });

  it('refuses a box press that would take the run past the people limit', async () => {
    await mount(false, { persons: ['person-a', null], maxPeople: 1 });
    act(() => canvasSessions.of(spaceId).getState().setMiniToolParam('activeDialogueId', ROW_B));
    await waitFor(() => expect(boxes()).toHaveLength(2));
    const [first, second] = boxes();
    expect(second).toHaveAttribute('aria-disabled', 'true');
    expect(first).not.toHaveAttribute('aria-disabled');
    act(() => second!.click());
    expect(toast.warning).toHaveBeenCalledWith(t('server.mini_tool.lipSyncTooManyPeople', { max: 1 }));
    const held = readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, 'video.lip-sync');
    expect(held.state === 'supported' ? (held.draft as VideoToolDraftById['video.lip-sync']).params.dialogues.map((row) => row.personId) : null).toEqual(['person-a', null]);
  });
});
