// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The transcribe panel (inner#856 T10): one switch for filler words, a hint
 * that follows it, a choice the page keeps, and a Run that hands the choice
 * over.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import type { KeyPlan } from '@web/data/api/byok';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { readingIntent } from '@web/spaces/canvas/start-understand-run';
import { TranscribePanelContainer } from '@web/spaces/canvas/transcribe/TranscribePanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';
import { runOnce } from '@web/stores/task-actions-in-flight';
import { useTranscribePreference } from '@web/stores/transcribe-preference';

const keyPlan = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@web/data/api/byok', async (importOriginal) => {
  const real = await importOriginal<typeof import('@web/data/api/byok')>();
  return { ...real, byokApi: { ...real.byokApi, keyPlan: async () => keyPlan.current ?? { payer: 'self', llm: { usesAccountKey: false }, models: {}, upstreamNames: {} } } };
});

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
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
    </QueryClientProvider>
  );
}

beforeEach(() => {
  setLocale('en');
  keyPlan.current = undefined;
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

  it.each([
    ['self', 'Your key'],
    ['admin', 'Studio key'],
  ] as const)('says whose key runs it when the %s payer\'s OpenRouter key does (inner#1953)', async (payer, words) => {
    keyPlan.current = { payer, payerUserId: null, llm: { usesAccountKey: true }, models: {}, upstreamNames: {} } satisfies KeyPlan;
    render(tree(vi.fn()));
    expect(await screen.findByText(words)).toBeInTheDocument();
    const line = screen.getByTestId('transcribe-credit');
    expect(line).not.toHaveTextContent('Billed by usage');
    // The key mark stands in for the credits star, and the full sentence is on hover.
    expect(line.querySelector('[data-icon="key"]')).not.toBeNull();
    expect(line.querySelector('[data-icon="credits"]')).toBeNull();
    await userEvent.setup().hover(line);
    expect((await screen.findAllByText(/no credits/)).length).toBeGreaterThan(0);
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
