// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Opening a video tool writes the user nothing to undo: the draft it seeds on a node with none, and the anchor an automatic
 * lip-sync people analysis freezes, stay off the canvas undo stack, so the user's next undo takes back their own last edit.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import type { VideoToolId } from '@breatic/shared/mini-tools';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { CanvasContext } from '../../canvas-context';
import { addNode, getCanvasUndoManager, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';

const projectId = 'open-undo-project'; const spaceId = 'open-undo-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
// The selected version's grid at 25 fps.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
const name = docName.canvasSpace(projectId, spaceId);

/**
 * Mounts a tool panel on a node with no draft, after one undoable edit of the user's.
 * @param toolId - The tool.
 * @returns The undo stack's depth before the panel opened.
 */
function open(toolId: VideoToolId, onRunVideo = vi.fn()): number {
  const doc = getDoc(name);
  const undo = getCanvasUndoManager(doc, name);
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const before = undo.undoStack.length;
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params: {} });
  const presentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0,
    presentationRef: { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } } } as VideoToolPresentation;
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId={toolId} node={node} nodes={[node]} presentation={presentation} onRunVideo={onRunVideo} lipSync={{ models: [], tracking: { minDurationSeconds: 0.5, maxDurationSeconds: 600 } }} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
  return before;
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { destroyDoc(name); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('opening a video tool leaves the canvas undo stack alone', () => {
  it('seeds the draft of a node that has none without an undo step', async () => {
    const before = open('video.split');
    await waitFor(() => expect(readVideoToolDraft(getDoc(name), nodeId, 'video.split').state).toBe('supported'));
    expect(getCanvasUndoManager(getDoc(name), name).undoStack).toHaveLength(before);
  });

  it('freezes the automatic lip-sync people anchor without an undo step', async () => {
    const start = vi.spyOn(miniToolAnalysesApi, 'start').mockReturnValue(new Promise(() => undefined));
    const before = open('video.lip-sync');
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(getCanvasUndoManager(getDoc(name), name).undoStack).toHaveLength(before);
  });
});

// Canvas design §3.3 undo row: a run's created nodes and edges are one undo batch, so the frame Current freezes at the press
// is no undo step of its own.
describe('running extract frames in Current mode', () => {
  it('freezes the presented grid frame without an undo step of its own', async () => {
    const onRunVideo = vi.fn().mockResolvedValue(undefined);
    const doc = getDoc(name);
    addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
    const seeded = createVideoToolDraft('video.extract-frames', { nodeId, canonicalURL: sourceURL, mediaInfo });
    commitVideoToolDraft(doc, nodeId, 'video.extract-frames', { ...seeded, params: { mode: 'current', frameIndex: 25 } }, false);
    const before = open('video.extract-frames', onRunVideo);
    const run = screen.getByTestId('mini-tool-run');
    await waitFor(() => expect(run).not.toBeDisabled());
    fireEvent.click(run);
    await waitFor(() => expect(onRunVideo).toHaveBeenCalledOnce());
    // The presented mediaTime 0 is grid frame 0 (frames-split §4.3).
    expect((onRunVideo.mock.calls[0]![2] as { params: { frameIndex: number } }).params.frameIndex).toBe(0);
    expect(getCanvasUndoManager(doc, name).undoStack).toHaveLength(before);
  });
});
