// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 execution design §10.2, §10.4, §10.5 and §10.8 panel rows (packages/web/AGENTS.md#disabled-controls): the erase
 * Run and "Track selection" are `aria-disabled` and a press explains why with a toast when the model input would last
 * outside `minSeconds`–`maxSeconds` (shared `modelGrid` and `gridSecondsAllowed`), when the anchor lies
 * outside the range, or when the source is transparent; the expand Run does the same when the source is longer than
 * `maxDurationSeconds`, the target's long side passes `maxTargetSide` (shared `videoExpandLayout`), or the source is
 * transparent. The props `erase` and `expand` (config `executions."video.erase"` and `"video.expand"`) and
 * `presentation.transparent` are shapes this test chose, as the lip-sync range test chose `lipSync`.
 *
 * Fixture: a 5 s 960x540 source at 25 fps.
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
import type { VideoToolDraftById, VideoToolId } from '@breatic/shared/mini-tools';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';

const projectId = 'erase-project'; const spaceId = 'erase-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
const frameTable = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 125, step: 4, duration: 4 }] };
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
 * @param options.onRunVideo - The execution entry.
 * @returns Nothing.
 */
function mount(toolId: Extract<VideoToolId, 'video.erase' | 'video.expand'>, params: Record<string, unknown>,
  options: { erase?: object; expand?: object; transparent?: boolean; onRunVideo?: () => Promise<unknown> } = {}): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const initial = createVideoToolDraft(toolId, source);
  commitVideoToolDraft(doc, nodeId, toolId, { ...initial, params: { ...initial.params, ...params } } as VideoToolDraftById[typeof toolId]);
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params: {} });
  const presentation = { frameTable, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0, ...(options.transparent ? { transparent: true } : {}) } as VideoToolPresentation;
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
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

describe('erase limits on Track selection (execution design §10.2, §10.4)', () => {
  it('lets a 3 s range anchored inside it be tracked', () => {
    mount('video.erase', { ...REGION, range: { start: 0, end: 3 }, anchor: { frameIndex: 25, pts: 1 } });
    expect(track()).not.toHaveAttribute('aria-disabled', 'true');
  });

  it.each([
    ['shorter than 1 s', { start: 0, end: 0.8 }],
    ['longer than 5 s on the model grid', { start: 0, end: 5 }],
  ] as const)('refuses a range %s and names the allowed length', (_case, range) => {
    // 5 s at 25 fps is 125 grid frames, exactly 5 s; the config's maximum below it refuses the same range.
    mount('video.erase', { ...REGION, range, anchor: { frameIndex: 0, pts: 0 } }, range.end === 5 ? { erase: { ...ERASE, maxSeconds: 4.9 } } : {});
    const max = range.end === 5 ? 4.9 : 5;
    expectRefused(track(), t('canvas.miniTool.videoUI.eraseRange', { min: 1, max }));
  });

  it('refuses an anchor outside the range', () => {
    mount('video.erase', { ...REGION, range: { start: 0, end: 3 }, anchor: { frameIndex: 100, pts: 4 } });
    expectRefused(track(), t('canvas.miniTool.videoUI.anchorOutsideRange'));
  });

  it('refuses a transparent source', () => {
    mount('video.erase', { ...REGION, range: { start: 0, end: 3 }, anchor: { frameIndex: 0, pts: 0 } }, { transparent: true });
    expectRefused(track(), t('canvas.miniTool.videoUI.transparentSource'));
  });
});

describe('expand limits on Run (execution design §10.5)', () => {
  const WIDER = { frame: { x: -0.25, y: 0, width: 1.5, height: 1 }, ratio: 'free' };

  it('runs a 1440x540 target of a 5 s source', () => {
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

  it('refuses a target whose long side passes maxTargetSide', () => {
    mount('video.expand', { frame: { x: -2, y: 0, width: 5, height: 1 }, ratio: 'free' });
    expectRefused(screen.getByTestId('mini-tool-run'), t('canvas.miniTool.videoUI.expandTooLarge', { max: 4096 }));
  });

  it('refuses a transparent source', () => {
    mount('video.expand', WIDER, { transparent: true });
    expectRefused(screen.getByTestId('mini-tool-run'), t('canvas.miniTool.videoUI.transparentSource'));
  });
});
