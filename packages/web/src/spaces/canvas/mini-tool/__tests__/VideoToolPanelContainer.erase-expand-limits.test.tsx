// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 execution design §10.2, §10.4, §10.5 and §10.8 panel rows (packages/web/AGENTS.md#disabled-controls): the erase
 * Run and "Track selection" are `aria-disabled` and a press explains why with a toast when the model input would last
 * outside `minSeconds`–`maxSeconds` (shared `modelGrid` and `gridSecondsAllowed`), when the anchor lies
 * outside the range, or when the source is transparent; the expand Run does the same when the source is longer than
 * `maxDurationSeconds`, the target's long side passes `maxTargetSide` (shared `videoExpandLayout`), or the source is
 * transparent. The props `erase` and `expand` (config `executions."video.erase"` and `"video.expand"`) and
 * `presentation.transparent` are shapes this test chose, as the lip-sync range test chose `lipSync`.
 *
 * Fixture: a 20 s 960x540 source at 25 fps.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { t } from '@breatic/shared';
import { fingerprintMiniToolAnalysisInput, projectMiniToolAnalysisInput, videoExpandLayout, type MiniToolAnalysisRecord, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolAnalysisRef, commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';

const projectId = 'erase-project'; const spaceId = 'erase-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 20, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
// The selected version's grid at 25 fps.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 500 };
const ERASE = { minSeconds: 1, maxSeconds: 5, maxGridFps: 30 };
const EXPAND = { maxDurationSeconds: 180, maxTargetSide: 4096 };

/**
 * Mounts a panel over a committed draft.
 * @param toolId - The tool.
 * @param params - Draft parameters replacing the defaults.
 * @param options - The configured limits, transparency and the run entry.
 * @param options.erase - The erase config prop.
 * @param options.expand - The expand config prop.
 * @param options.transparent - Whether the source is transparent.
 * @param options.presentedTime - The presented frame's time, 0 s by default.
 * @param options.mediaInfo - The stored source size, 960x540 by default.
 * @param options.display - The presentation's display size, which applies the sample aspect ratio.
 * @param options.onRunVideo - The execution entry.
 * @returns Nothing.
 */
function mount(toolId: Extract<VideoToolId, 'video.erase' | 'video.expand'>, params: Record<string, unknown>,
  options: { erase?: object; expand?: object; transparent?: boolean; presentedTime?: number; mediaInfo?: typeof mediaInfo; display?: { width: number; height: number; duration?: number }; onRunVideo?: () => Promise<unknown> } = {}): void {
  const stored = options.mediaInfo ?? mediaInfo;
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const initial = createVideoToolDraft(toolId, { ...source, mediaInfo: stored });
  commitVideoToolDraft(doc, nodeId, toolId, { ...initial, params: { ...initial.params, ...params } } as VideoToolDraftById[typeof toolId]);
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params: {} });
  const presentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: options.presentedTime ?? 0,
    presentationRef: { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } }, ...(options.display ? { display: options.display } : {}), ...(options.transparent ? { transparent: true } : {}) } as VideoToolPresentation;
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...stored } };
  const proposed: object = { erase: options.erase ?? ERASE, expand: options.expand ?? EXPAND };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId={toolId} node={node} nodes={[node]} presentation={presentation} onRunVideo={options.onRunVideo ?? vi.fn()} {...proposed} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
}

/**
 * Presses a control and checks the press was refused with exactly the given toast.
 * @param control - The control.
 * @param message - The toast the refusal shows.
 * @returns Nothing.
 */
function expectRefused(control: HTMLElement, message: string): void {
  expect(control).toHaveAttribute('aria-disabled', 'true');
  expect(control).not.toBeDisabled();
  act(() => control.click());
  expect(toast.warning).toHaveBeenCalledOnce();
  expect(toast.warning).toHaveBeenCalledWith(message);
}

const track = (): HTMLElement => screen.getByRole('button', { name: new RegExp(t('canvas.miniTool.videoUI.trackObject')) });
const REGION = { region: { box: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }, points: [] } };

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

// Ranges and anchors are grid frame numbers on the 25 fps grid (frames-split §7.16): 1 s is 25 frames.
describe('erase limits on Track selection (execution design §10.2, §10.4)', () => {
  it('lets a 3 s range anchored inside it be tracked', () => {
    mount('video.erase', { ...REGION, range: { start: 0, end: 75 }, anchor: { frameIndex: 25 } });
    expect(track()).not.toHaveAttribute('aria-disabled', 'true');
  });

  it.each([
    ['shorter than 1 s', { start: 0, end: 20 }],
    ['longer than 5 s on the model grid', { start: 0, end: 125 }],
  ] as const)('refuses a range %s and names the allowed length', (_case, range) => {
    // 5 s at 25 fps is 125 grid frames, exactly 5 s; the config's maximum below it refuses the same range.
    mount('video.erase', { ...REGION, range, anchor: { frameIndex: 0 } }, range.end === 125 ? { erase: { ...ERASE, maxSeconds: 4.9 } } : {});
    const max = range.end === 125 ? 4.9 : 5;
    expectRefused(track(), t('canvas.miniTool.videoUI.eraseRange', { min: 1, max }));
  });

  it('refuses a presented frame outside the range, since the press anchors on it', () => {
    mount('video.erase', { ...REGION, range: { start: 0, end: 75 }, anchor: { frameIndex: 0 } }, { presentedTime: 4 });
    expectRefused(track(), t('canvas.miniTool.videoUI.anchorOutsideRange'));
  });

  it('tracks a range away from 0 s on the presented frame, whatever anchor the draft held before', async () => {
    const start = vi.spyOn(miniToolAnalysesApi, 'start').mockReturnValue(new Promise(() => undefined));
    mount('video.erase', { ...REGION, range: { start: 250, end: 350 }, anchor: { frameIndex: 0 } }, { presentedTime: 12 });
    expect(track()).not.toHaveAttribute('aria-disabled', 'true');
    act(() => track().click());
    expect(toast.warning).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]?.[0]).toMatchObject({ kind: 'tracked_mask', params: { range: { start: 250, end: 350 }, anchor: { frameIndex: 300 } } });
  });

  // Execution design §10.3: a retry starts a new tracking run for the selection the failed run was made for, wherever the
  // user scrubbed. Retry shows only for a failed run matching the draft, so it sends the draft's own range, anchor, region
  // and prompt as the panel's Track selection does; the profile's default prompt stays the server's to substitute.
  it('retries a failed tracking with the draft selection and its anchor, not the presented frame, and leaves the draft as it was', async () => {
    const anchor = { frameIndex: 250 };
    mount('video.erase', { ...REGION, range: { start: 250, end: 350 }, anchor }, { presentedTime: 12 });
    const doc = getDoc(docName.canvasSpace(projectId, spaceId));
    const held = readVideoToolDraft(doc, nodeId, 'video.erase');
    if (held.state !== 'supported') throw new Error('No draft');
    const draft = held.draft as VideoToolDraftById['video.erase'];
    const profile = { id: 'sam3-video-rle', version: '1', weightsHash: null, params: { default_prompt: 'object' } };
    const analysisInput = projectMiniToolAnalysisInput({ kind: 'tracked_mask', source: draft.source, params: draft.params, profile });
    if (analysisInput.kind !== 'tracked_mask') throw new Error('Not a tracking input');
    const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
    const failedRunId = '40000000-0000-4000-8000-000000000001';
    const record = { schemaVersion: 1, draftId: draft.draftId, revision: draft.revision, analysisRunId: failedRunId, acceptedAt: '2026-11-07T00:00:00.000001Z',
      binding: { assetId: '50000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: sourceURL, kind: 'video', mediaInfo },
      analysisInput, inputFingerprint, kind: 'tracked_mask', status: 'failed', result: null, error: { code: 'timeout', step: 'track' }, usage: [], artifactUnavailable: false } as MiniToolAnalysisRecord;
    vi.spyOn(miniToolAnalysesApi, 'get').mockResolvedValue(record);
    const start = vi.spyOn(miniToolAnalysesApi, 'start').mockReturnValue(new Promise(() => undefined));
    act(() => commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.erase', kind: 'tracked_mask', draftId: draft.draftId, analysisRunId: failedRunId, inputFingerprint }));
    const retry = await screen.findByRole('button', { name: t('canvas.miniTool.videoUI.retryTracking') });
    act(() => retry.click());
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const body = start.mock.calls[0]?.[0];
    expect(analysisInput.trackingPrompt).toBe('object');
    expect(body).toMatchObject({ kind: 'tracked_mask', draftId: draft.draftId, params: { range: draft.params.range, anchor, region: draft.params.region, trackingPrompt: '' },
      presentationRef: { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } } });
    expect(body?.analysisRunId).not.toBe(failedRunId);
    const after = readVideoToolDraft(doc, nodeId, 'video.erase');
    expect(after.state === 'supported' ? after.draft.revision : null).toBe(draft.revision);
  });

  // Execution design §10.3 and erase admission (`eraseTracking`): a tracking stays made for a selection under the profile it
  // froze. After the tracking profile changed between two trackings, the user's undo back to the first selection shows
  // the first tracking again: each record is judged with its own profile, not the newest record's.
  it('shows the tracking made for the current selection under its own profile after a later tracking used another profile', async () => {
    const anchor = { frameIndex: 250 };
    mount('video.erase', { ...REGION, range: { start: 250, end: 350 }, anchor }, { presentedTime: 12 });
    const doc = getDoc(docName.canvasSpace(projectId, spaceId));
    const held = readVideoToolDraft(doc, nodeId, 'video.erase');
    if (held.state !== 'supported') throw new Error('No draft');
    const draft = held.draft as VideoToolDraftById['video.erase'];
    /**
     * A tracking record for these params under this profile.
     * @param analysisRunId - The run.
     * @param params - The selection it was made for.
     * @param profile - The profile it froze.
     * @param acceptedAt - When it was accepted.
     * @returns The record and its fingerprint.
     */
    async function tracking(analysisRunId: string, params: VideoToolDraftById['video.erase']['params'], profile: object, acceptedAt: string): Promise<MiniToolAnalysisRecord> {
      const analysisInput = projectMiniToolAnalysisInput({ kind: 'tracked_mask', source: draft.source, params, profile });
      const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
      return { schemaVersion: 1, draftId: draft.draftId, revision: draft.revision, analysisRunId, acceptedAt,
        binding: { assetId: '50000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: sourceURL, kind: 'video', mediaInfo },
        analysisInput, inputFingerprint, kind: 'tracked_mask', status: 'failed', result: null, error: { code: 'timeout', step: 'track' }, usage: [], artifactUnavailable: false } as MiniToolAnalysisRecord;
    }
    const first = await tracking('40000000-0000-4000-8000-000000000001', draft.params, { id: 'sam3-video-rle', version: '1', weightsHash: null, params: { default_prompt: 'object' } }, '2026-11-07T00:00:00.000001Z');
    const later = await tracking('40000000-0000-4000-8000-000000000002', { ...draft.params, range: { start: 275, end: 350 } }, { id: 'sam3-video-rle', version: '2', weightsHash: null, params: { default_prompt: 'thing' } }, '2026-11-07T01:00:00.000001Z');
    vi.spyOn(miniToolAnalysesApi, 'get').mockImplementation(async (runId: string) => (runId === first.analysisRunId ? first : later));
    act(() => {
      for (const record of [first, later]) commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.erase', kind: 'tracked_mask', draftId: draft.draftId, analysisRunId: record.analysisRunId, inputFingerprint: record.inputFingerprint });
    });
    expect(await screen.findByRole('button', { name: t('canvas.miniTool.videoUI.retryTracking') })).toBeInTheDocument();
  });

  it('refuses a transparent source', () => {
    mount('video.erase', { ...REGION, range: { start: 0, end: 75 }, anchor: { frameIndex: 0 } }, { transparent: true });
    expectRefused(track(), t('canvas.miniTool.videoUI.transparentSource'));
  });
});

describe('expand limits on Run (execution design §10.5)', () => {
  const WIDER = { frame: { x: -0.25, y: 0, width: 1.5, height: 1 }, ratio: 'free' };

  it('runs a 1440x540 target of a 20 s source', () => {
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    mount('video.expand', WIDER, { onRunVideo });
    const run = screen.getByTestId('mini-tool-run');
    expect(run).not.toHaveAttribute('aria-disabled', 'true');
    act(() => run.click());
    expect(onRunVideo).toHaveBeenCalledOnce();
  });

  it('refuses a source longer than maxDurationSeconds', () => {
    mount('video.expand', WIDER, { expand: { ...EXPAND, maxDurationSeconds: 4 } });
    expectRefused(screen.getByTestId('mini-tool-run'), t('canvas.miniTool.videoUI.expandTooLong', { max: 4 }));
  });

  // Admission measures the presented duration (ledger plan.display.duration), not the stored one.
  it('judges the duration by the presentation once it is known', () => {
    mount('video.expand', WIDER, { expand: { ...EXPAND, maxDurationSeconds: 4 }, mediaInfo: { ...mediaInfo, duration: 3 }, display: { width: 960, height: 540, duration: 4.5 } });
    expectRefused(screen.getByTestId('mini-tool-run'), t('canvas.miniTool.videoUI.expandTooLong', { max: 4 }));
  });

  it('runs a source whose stored duration passes the limit while its presented duration does not', () => {
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    mount('video.expand', WIDER, { expand: { ...EXPAND, maxDurationSeconds: 4 }, display: { width: 960, height: 540, duration: 3.5 }, onRunVideo });
    const run = screen.getByTestId('mini-tool-run');
    expect(run).not.toHaveAttribute('aria-disabled', 'true');
    act(() => run.click());
    expect(onRunVideo).toHaveBeenCalledOnce();
  });

  it('refuses a target whose long side passes maxTargetSide', () => {
    mount('video.expand', { frame: { x: -2, y: 0, width: 5, height: 1 }, ratio: 'free' });
    expectRefused(screen.getByTestId('mini-tool-run'), t('canvas.miniTool.videoUI.expandTooLarge', { max: 4096 }));
  });

  // A 1440x1080 source with a 4:3 sample aspect ratio displays, and is expanded by admission, at 1920x1080 (ledger plan.display).
  it('sizes the frame of an anamorphic source by its display size, so 1:1 is 1920x1920', () => {
    mount('video.expand', {}, { mediaInfo: { ...mediaInfo, width: 1440, height: 1080 }, display: { width: 1920, height: 1080 } });
    act(() => within(screen.getByTestId('video-expand-ratios')).getByRole('button', { name: '1:1' }).click());
    const held = readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, 'video.expand');
    expect(held.state).toBe('supported');
    const frame = held.state === 'supported' ? (held.draft as VideoToolDraftById['video.expand']).params.frame : null;
    expect(videoExpandLayout(frame!, { width: 1920, height: 1080 }, Infinity)).toMatchObject({ width: 1920, height: 1920 });
    expect(canvasSessions.of(spaceId).getState().miniTool?.sourceSize).toEqual({ width: 1920, height: 1080 });
  });

  it('refuses a transparent source', () => {
    mount('video.expand', WIDER, { transparent: true });
    expectRefused(screen.getByTestId('mini-tool-run'), t('canvas.miniTool.videoUI.transparentSource'));
  });
});
