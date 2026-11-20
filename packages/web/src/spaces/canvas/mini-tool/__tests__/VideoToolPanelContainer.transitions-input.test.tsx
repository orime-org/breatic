// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 canvas design §4 transitions row and §28: the panel has one video input slot. While no video is picked Run is
 * `aria-disabled` and a click says to pick a video first; picking one opens the timeline Dialog; picking again replaces the
 * input clip's video and resets its in and out, so the timeline keeps exactly the current video and one input.
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
// The track editor and the GL preview are not under test; jsdom cannot draw either.
vi.mock('@xzdarcy/react-timeline-editor', async () => ({ Timeline: (await import('react')).forwardRef(() => null) }));
vi.mock('@web/spaces/canvas/mini-tool/video/VideoTimelinePreview', () => ({ VideoTimelinePreview: () => null }));
// Picked videos whose nodes store no length: one whose registered source has one, one with no length anywhere, one unreadable,
// one still being prepared on its first read, and one whose first read fails in transport.
const reads = vi.hoisted(() => ({ count: new Map<string, number>() }));
vi.mock('@web/spaces/canvas/video-presentation/video-presentation-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/spaces/canvas/video-presentation/video-presentation-query')>();
  const lengths: Record<string, number | null> = { 'https://assets.example.test/registered.webm': 6, 'https://assets.example.test/unknown.webm': null };
  const answer = (duration: number | null, pollAfterMs: number | null): object => ({ sourceBinding: { mediaInfo: { width: null, height: null, duration, mimeType: 'video/webm' } }, presentation: null, preparation: null, ledger: null, pollAfterMs });
  return { ...actual, videoPresentationQuery: (input: { projectId: string; canonicalURL: string; active: boolean }) => {
    const options = actual.videoPresentationQuery(input);
    const read = (): number => { const count = (reads.count.get(input.canonicalURL) ?? 0) + 1; reads.count.set(input.canonicalURL, count); return count; };
    if (input.canonicalURL === 'https://assets.example.test/broken.webm') return { ...options, queryFn: async () => { throw new Error('unreadable'); } };
    if (input.canonicalURL === 'https://assets.example.test/preparing.webm') return { ...options, queryFn: async () => (read() === 1 ? answer(null, 20) : answer(7, null)) };
    if (input.canonicalURL === 'https://assets.example.test/flaky.webm') return { ...options, queryFn: async () => { if (read() === 1) throw new Error('offline'); return answer(5, null); } };
    const length = lengths[input.canonicalURL];
    return length === undefined ? options : { ...options, queryFn: async () => answer(length, null) };
  } };
});

import { t } from '@breatic/shared';
import type { VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';

const projectId = 'transitions-project'; const spaceId = 'transitions-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.webm';
const mediaInfo = { width: 160, height: 240, duration: 4, mimeType: 'video/webm' };
// The selected version's grid at 25 fps.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 100 };
const ready: VideoToolPresentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0 };
const name = docName.canvasSpace(projectId, spaceId);

/**
 * Mounts the transitions panel on a committed draft.
 * @param picked - An input already picked, with its trimmed clip, or none.
 * @returns The Run entry.
 */
function mount(picked?: { url: string; duration: number; in: number; out: number }, others: readonly CanvasNodeView[] = []): ReturnType<typeof vi.fn> {
  const doc = getDoc(name);
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const initial = createVideoToolDraft('video.transitions', { nodeId, canonicalURL: sourceURL, mediaInfo });
  const input = picked === undefined ? null : { inputId: '60000000-0000-4000-8000-000000000002', url: picked.url, mediaInfo: { ...mediaInfo, duration: picked.duration } };
  commitVideoToolDraft(doc, nodeId, 'video.transitions', input === null || picked === undefined ? initial : { ...initial, inputs: [...initial.inputs, input],
    params: { clips: [...initial.params.clips, { clipId: '50000000-0000-4000-8000-000000000002', inputId: input.inputId, in: picked.in, out: picked.out, transition: { kind: 'cut', duration: 0 } }] } });
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.transitions', { sourceContent: sourceURL, params: {} });
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.transitions' node={node} nodes={[node, ...others]} presentation={ready} onRunVideo={onRunVideo} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
  return onRunVideo;
}

/**
 * The committed transitions draft.
 * @returns The draft.
 */
function held(): VideoToolDraftById['video.transitions'] {
  const reading = readVideoToolDraft(getDoc(name), nodeId, 'video.transitions');
  if (reading.state !== 'supported') throw new Error('No transitions draft');
  return reading.draft;
}

/**
 * Picks a video on the canvas into the input slot.
 * @param url - The picked video.
 * @param duration - Its length in seconds.
 * @returns Nothing.
 */
function pick(url: string, duration: number, nodeId?: string): void {
  act(() => canvasSessions.of(spaceId).getState().fillMiniToolSlot('timeline', { url, duration, ...(nodeId === undefined ? {} : { nodeId }) }, false));
}

beforeEach(() => { vi.clearAllMocks(); reads.count.clear(); });
afterEach(() => { destroyDoc(name); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('the transitions input slot (canvas design §4, §28)', () => {
  it('keeps Run pressable while no video is picked and says to pick one first', () => {
    const onRunVideo = mount();
    const run = screen.getByTestId('mini-tool-run');
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(run).not.toBeDisabled();
    act(() => run.click());
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(t('canvas.generatePanel.errorNoSourceVideo'));
    expect(onRunVideo).not.toHaveBeenCalled();
  });

  it('opens the timeline Dialog once a video is picked', async () => {
    mount();
    expect(screen.queryByTestId('video-timeline-dialog')).toBeNull();
    pick('https://assets.example.test/second.webm', 3);
    await waitFor(() => expect(screen.getByTestId('video-timeline-dialog')).toBeInTheDocument());
    expect(held().params.clips.map((clip) => [clip.in, clip.out])).toEqual([[0, 4], [0, 3]]);
  });

  it('replaces the picked input on a second pick and resets its in and out', async () => {
    mount({ url: 'https://assets.example.test/second.webm', duration: 3, in: 1, out: 2.5 });
    const host = held().params.clips[0]!;
    pick('https://assets.example.test/third.webm', 5);
    await waitFor(() => expect(held().inputs.map((input) => input.url)).toEqual([sourceURL, 'https://assets.example.test/third.webm']));
    const { clips } = held().params;
    expect(clips).toHaveLength(2);
    expect(clips[0]).toEqual(host);
    expect(clips[1]).toMatchObject({ clipId: '50000000-0000-4000-8000-000000000002', inputId: held().inputs[1]!.inputId, in: 0, out: 5 });
  });

  it('names the input after the clicked node when two nodes hold the same video (inner#1306 #14)', async () => {
    const shared = 'https://assets.example.test/shared.webm';
    const twin = (id: string, label: string): CanvasNodeView => ({ id, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: shared, name: label, ...mediaInfo } });
    mount(undefined, [twin('20000000-0000-4000-8000-000000000001', 'First copy'), twin('20000000-0000-4000-8000-000000000002', 'Second copy')]);
    pick(shared, 3, '20000000-0000-4000-8000-000000000002');
    await waitFor(() => expect(held().inputs[1]?.sourceNodeId).toBe('20000000-0000-4000-8000-000000000002'));
    expect(screen.getAllByText('Second copy').length).toBeGreaterThan(0);
    expect(screen.queryByText('First copy')).toBeNull();
  });

  it('takes the length of a picked video whose node stores none from its registered source, in the input clip\'s place', async () => {
    mount({ url: 'https://assets.example.test/second.webm', duration: 3, in: 1, out: 2.5 });
    const host = held().params.clips[0]!;
    act(() => canvasSessions.of(spaceId).getState().fillMiniToolSlot('timeline', { url: 'https://assets.example.test/registered.webm' }, false));
    await waitFor(() => expect(held().inputs.map((input) => input.url)).toEqual([sourceURL, 'https://assets.example.test/registered.webm']));
    expect(held().params.clips).toEqual([host, expect.objectContaining({ clipId: '50000000-0000-4000-8000-000000000002', inputId: held().inputs[1]!.inputId, in: 0, out: 6 })]);
    expect(held().inputs[1]!.mediaInfo?.duration).toBe(6);
  });

  it('refuses a picked video with no length anywhere and keeps the timeline as it was', async () => {
    mount({ url: 'https://assets.example.test/second.webm', duration: 3, in: 1, out: 2.5 });
    const before = held();
    act(() => canvasSessions.of(spaceId).getState().fillMiniToolSlot('timeline', { url: 'https://assets.example.test/unknown.webm' }, false));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(t('canvas.miniTool.videoUI.ledgerUnsupported')));
    expect(held().inputs).toEqual(before.inputs);
    expect(held().params.clips).toEqual(before.params.clips);
    expect(canvasSessions.of(spaceId).getState().miniTool?.slots?.timeline).toBeUndefined();
  });

  it('says the media is unavailable when a picked video\'s source cannot be read, and keeps the timeline as it was', async () => {
    mount({ url: 'https://assets.example.test/second.webm', duration: 3, in: 1, out: 2.5 });
    const before = held();
    act(() => canvasSessions.of(spaceId).getState().fillMiniToolSlot('timeline', { url: 'https://assets.example.test/broken.webm' }, false));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(t('canvas.miniTool.videoUI.mediaError')));
    expect(held().params.clips).toEqual(before.params.clips);
  });

  it('keeps a picked video held while its source is still being prepared, then places it once its length arrives', async () => {
    mount({ url: 'https://assets.example.test/second.webm', duration: 3, in: 1, out: 2.5 });
    const host = held().params.clips[0]!;
    act(() => canvasSessions.of(spaceId).getState().fillMiniToolSlot('timeline', { url: 'https://assets.example.test/preparing.webm' }, false));
    await waitFor(() => expect(reads.count.get('https://assets.example.test/preparing.webm')).toBe(1));
    expect(canvasSessions.of(spaceId).getState().miniTool?.slots?.timeline).toBeDefined();
    expect(toast.warning).not.toHaveBeenCalled();
    await waitFor(() => expect(held().inputs.map((input) => input.url)).toEqual([sourceURL, 'https://assets.example.test/preparing.webm']));
    expect(held().params.clips).toEqual([host, expect.objectContaining({ in: 0, out: 7 })]);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('reads a picked video again on a re-pick after its first read failed in transport', async () => {
    mount({ url: 'https://assets.example.test/second.webm', duration: 3, in: 1, out: 2.5 });
    const flaky = 'https://assets.example.test/flaky.webm';
    act(() => canvasSessions.of(spaceId).getState().fillMiniToolSlot('timeline', { url: flaky }, false));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(t('canvas.miniTool.videoUI.mediaError')));
    expect(canvasSessions.of(spaceId).getState().miniTool?.slots?.timeline).toBeUndefined();
    act(() => canvasSessions.of(spaceId).getState().fillMiniToolSlot('timeline', { url: flaky }, false));
    await waitFor(() => expect(held().inputs.map((input) => input.url)).toEqual([sourceURL, flaky]));
    expect(held().params.clips[1]).toMatchObject({ in: 0, out: 5 });
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it('turns a junction transition the re-picked input is too short for into a Cut (inner#1306 #15)', async () => {
    mount({ url: 'https://assets.example.test/second.webm', duration: 4, in: 0, out: 4 });
    const draft = held();
    act(() => { commitVideoToolDraft(getDoc(name), nodeId, 'video.transitions', { ...draft, revision: '70000000-0000-4000-8000-000000000001', params: { clips: [{ ...draft.params.clips[0]!, transition: { kind: 'fade', duration: 1.5 } }, draft.params.clips[1]!] } }); });
    pick('https://assets.example.test/short.webm', 1);
    await waitFor(() => expect(screen.getByTestId('video-timeline-dialog')).toBeInTheDocument());
    expect(held().params.clips.map((clip) => [clip.in, clip.out])).toEqual([[0, 4], [0, 1]]);
    expect(held().params.clips[0]!.transition).toEqual({ kind: 'cut', duration: 0 });
  });
});
