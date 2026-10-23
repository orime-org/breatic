// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transcribe panel (inner#856 T10): one switch for filler words, a hint
 * that follows it, a choice the page keeps, and a Run that hands the choice
 * over.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { readingIntent } from '@web/spaces/canvas/start-understand-run';
import { TranscribePanelContainer } from '@web/spaces/canvas/transcribe/TranscribePanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';
import { runOnce } from '@web/stores/task-actions-in-flight';
import { useTranscribePreference } from '@web/stores/transcribe-preference';

const NODES: CanvasNodeView[] = [
  {
    id: 'src',
    type: 'audio',
    position: { x: 0, y: 0 },
    data: { handling: false, content: 'https://cdn.example/a.mp3' },
  } as unknown as CanvasNodeView,
];

/**
 * The tree under test.
 * @param onRun - The run handler.
 * @param spaceId - The Space whose panel is open.
 * @param projectId - The Project holding that Space.
 * @returns The element.
 */
function tree(
  onRun: (nodeId: string, keepFillers: boolean) => void,
  spaceId = '',
  projectId = 'project',
): React.JSX.Element {
  return (
    <TooltipProvider>
      {/* Escape is the space region's, as on the real page. */}
      <div data-region='space'>
        <CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'owner', caretProvider: null }}>
          <ReactFlow nodes={[{ id: 'src', position: { x: 0, y: 0 }, data: {} }]} edges={[]}>
            <TranscribePanelContainer nodes={NODES} onRun={onRun} />
          </ReactFlow>
        </CanvasContext.Provider>
      </div>
    </TooltipProvider>
  );
}

beforeEach(() => {
  setLocale('en');
  useTranscribePreference.setState({ keepFillers: true });
  canvasSessions.of('').getState().closeActivePanel();
  canvasSessions.of('').getState().openTranscribePanel('src');
  canvasSessions.of('other').getState().closeActivePanel();
});

describe('TranscribePanelContainer', () => {
  it('opens with filler words kept and says what that writes', () => {
    render(tree(vi.fn()));
    expect(screen.getByTestId('transcribe-panel-title')).toHaveTextContent('Transcribe');
    expect(screen.getByTestId('transcribe-keep-fillers')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('transcribe-hint')).toHaveTextContent('Writes um, uh and the like as spoken');
    expect(screen.getByTestId('transcribe-credit')).toHaveTextContent('Billed by usage');
  });

  it('turns the hint with the switch', () => {
    render(tree(vi.fn()));
    fireEvent.click(screen.getByTestId('transcribe-keep-fillers'));
    expect(screen.getByTestId('transcribe-keep-fillers')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('transcribe-hint')).toHaveTextContent(
      'Leaves out um, uh and the like, and may reword a few others',
    );
  });

  it.each(['project', 'another-project'])('keeps the last choice in another Space of %s', (projectId) => {
    const first = render(tree(vi.fn()));
    fireEvent.click(screen.getByTestId('transcribe-keep-fillers'));
    act(() => canvasSessions.of('').getState().closeActivePanel());
    expect(screen.queryByTestId('transcribe-panel')).toBeNull();
    first.unmount();
    // Another Space's session starts empty; the choice is the page's.
    expect(canvasSessions.of('other').getState().panelKind).toBeNull();
    act(() => canvasSessions.of('other').getState().openTranscribePanel('src'));
    render(tree(vi.fn(), 'other', projectId));
    expect(screen.getByTestId('transcribe-keep-fillers')).toHaveAttribute('aria-checked', 'false');
  });

  it('hands Run the node and the switch as it stands', () => {
    const onRun = vi.fn();
    render(tree(onRun));
    fireEvent.click(screen.getByTestId('transcribe-keep-fillers'));
    fireEvent.click(screen.getByTestId('transcribe-run'));
    expect(onRun).toHaveBeenCalledWith('src', false);
  });

  it('holds Run while a press on this node still waits', () => {
    let release: (() => void) | undefined;
    void runOnce(readingIntent('transcribe', '', 'src'), {
      scope: 'transcribe',
      prepare: () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
      send: vi.fn(),
    });
    const onRun = vi.fn();
    render(tree(onRun));
    const run = screen.getByTestId('transcribe-run');
    expect(run).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(run);
    expect(onRun).not.toHaveBeenCalled();
    act(() => release?.());
  });

  it('is not held by an Understand press on the same node', () => {
    let release: (() => void) | undefined;
    void runOnce(readingIntent('understand', '', 'src'), {
      scope: 'understand',
      prepare: () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
      send: vi.fn(),
    });
    render(tree(vi.fn()));
    expect(screen.getByTestId('transcribe-run')).not.toHaveAttribute('aria-busy');
    act(() => release?.());
  });

  it('closes on Escape and on its close button', () => {
    render(tree(vi.fn()));
    fireEvent.keyDown(screen.getByTestId('transcribe-panel-title'), { key: 'Escape' });
    expect(canvasSessions.of('').getState().panelKind).toBeNull();
    act(() => canvasSessions.of('').getState().openTranscribePanel('src'));
    fireEvent.click(screen.getByTestId('transcribe-panel-close'));
    expect(canvasSessions.of('').getState().panelKind).toBeNull();
  });

  it('shows nothing while another panel holds the node', () => {
    act(() => canvasSessions.of('').getState().openAnnotationPanel('src'));
    render(tree(vi.fn()));
    expect(screen.queryByTestId('transcribe-panel')).toBeNull();
  });
});
