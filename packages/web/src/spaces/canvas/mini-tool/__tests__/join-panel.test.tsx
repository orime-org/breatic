// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The join panel against the canvas session (inner#1825 §6.5): one numbered
 * tile per clip in list order, removal by node, an add tile that disappears at
 * the cap `/canvas/limits` serves, a crossfade no longer than half the
 * shortest clip, and a Run that sends the list's first clip as the source and
 * the rest as `clips`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/data/api/request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/api/request')>();
  return { ...actual, apiGet: vi.fn() };
});

import { t, type ModelCatalog } from '@breatic/shared';
import type { MiniToolSlotValue } from '@breatic/shared/mini-tools';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';
import { canvasApi, type CanvasLimits } from '@web/data/api/canvas';
import { apiGet } from '@web/data/api/request';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { MiniToolPanelContainer } from '@web/spaces/canvas/mini-tool/MiniToolPanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';

const CATALOG = {
  image: [], video: [], audio: [], tts: [], three_d: [], total: 0, credit_multiplier: 1,
} as unknown as ModelCatalog;

/** The canvas knobs, with a join cap of three clips. */
const LIMITS = {
  referencePoolCap: 10,
  nodeHistoryPageSize: 20,
  understandMaxBytes: 1,
  understandLongMediaMaxBytes: 1,
  waveformMaxSeconds: 1,
  waveformMaxBytes: 1,
  waveformPeaksRetryMs: 1,
  waveformPeaksRetryMaxMs: 1,
  joinMaxClips: 3,
} as CanvasLimits;

/**
 * A clip as a pick or the selection prefills it.
 * @param id - Its node id; also the stem of its name and file.
 * @param duration - Its length in seconds.
 * @param url - Its address, when two clips share one.
 * @returns The slot value.
 */
function clip(id: string, duration: number, url = `https://cdn/${id}.mp3`): MiniToolSlotValue {
  return { url, duration, nodeId: id, name: id.toUpperCase() } as MiniToolSlotValue;
}

/**
 * The audio nodes on the canvas, one per clip id.
 * @param ids - Node ids.
 * @returns Their views.
 */
function nodes(ids: readonly string[]): CanvasNodeView[] {
  return ids.map((id, i) => ({
    id,
    type: 'audio',
    position: { x: i * 400, y: 0 },
    data: { handling: false, name: id.toUpperCase(), content: `https://cdn/${id}.mp3`, duration: 10 },
  })) as CanvasNodeView[];
}

let client: QueryClient;

/**
 * Mounts the open panel.
 * @param onRun - The run handler.
 */
function mount(onRun: () => Promise<void> = () => Promise.resolve()): void {
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <div data-region='space'>
          <ReactFlow nodes={[{ id: 'a', position: { x: 0, y: 0 }, data: {} }]} edges={[]}>
            <MiniToolPanelContainer nodes={nodes(['a', 'b', 'c', 'd'])} getLastWriteWasLocal={() => true} onRun={onRun} />
          </ReactFlow>
        </div>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/**
 * The tile ids on screen, in order.
 * @returns The node ids the tiles stand for.
 */
function tiles(): string[] {
  return [...document.querySelectorAll('[data-testid^="join-tile-"]')].map((el) => (el.getAttribute('data-testid') ?? '').slice('join-tile-'.length));
}

/**
 * Presses a tile's remove button.
 * @param id - The clip's node id.
 */
function removeTile(id: string): void {
  fireEvent.click(within(screen.getByTestId(`join-tile-${id}`)).getByRole('button'));
}

const session = (): ReturnType<ReturnType<typeof canvasSessions.of>['getState']> => canvasSessions.of('').getState();

beforeEach(async () => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(modelCatalogQuery().queryKey, CATALOG);
  vi.mocked(apiGet).mockImplementation((path: string) =>
    path === '/canvas/limits' ? Promise.resolve(LIMITS) : Promise.reject(new Error(`unexpected GET ${path}`)),
  );
  canvasApi.resetLimitsCache();
  await canvasApi.fetchLimits();
  session().closeActivePanel();
});

describe('the join panel (inner#1825 §6.5)', () => {
  it('shows one tile per clip in list order, each with the clip’s name', () => {
    session().openJoinPanel('audio.join', [clip('a', 10), clip('b', 4), clip('c', 8)]);
    mount();
    expect(screen.getByTestId('join-panel')).toBeInTheDocument();
    expect(tiles()).toEqual(['a', 'b', 'c']);
    expect(screen.getByTestId('join-tile-b')).toHaveTextContent('B');
  });

  it('removes the clip of the tile pressed and leaves another clip holding the same file', () => {
    session().openJoinPanel('audio.join', [clip('a', 10), clip('b', 4, 'https://cdn/same.mp3'), clip('c', 8, 'https://cdn/same.mp3')]);
    mount();
    act(() => removeTile('b'));
    expect(tiles()).toEqual(['a', 'c']);
    expect((session().miniTool?.slots.clips as readonly { nodeId?: string }[]).map((value) => value.nodeId)).toEqual(['a', 'c']);
  });

  it('removes the host’s own clip without moving the panel, and takes it back at the end of the list', () => {
    session().openJoinPanel('audio.join', [clip('a', 10), clip('b', 4), clip('c', 8)]);
    mount();
    act(() => removeTile('a'));
    expect(tiles()).toEqual(['b', 'c']);
    expect(session().panelHostId).toBe('a');
    expect(session().panelKind).toBe('miniTool');

    act(() => session().fillMiniToolSlot('clips', clip('a', 10), true));
    expect(tiles()).toEqual(['b', 'c', 'a']);
  });

  it('holds every remove button once only two clips are left', () => {
    session().openJoinPanel('audio.join', [clip('a', 10), clip('b', 4)]);
    mount();
    for (const id of ['a', 'b']) expect(within(screen.getByTestId(`join-tile-${id}`)).getByRole('button')).toBeDisabled();
  });

  it('holds Run with one clip and lets it go at two', () => {
    const onRun = vi.fn(() => Promise.resolve());
    session().openJoinPanel('audio.join', [clip('a', 10)]);
    mount(onRun);
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).not.toHaveBeenCalled();

    act(() => session().fillMiniToolSlot('clips', clip('b', 4), true));
    expect(screen.getByTestId('mini-tool-run')).not.toBeDisabled();
  });

  it('offers the add tile until the list holds the cap /canvas/limits serves', () => {
    session().openJoinPanel('audio.join', [clip('a', 10), clip('b', 4)]);
    mount();
    expect(screen.getByTestId('join-add')).toBeInTheDocument();
    act(() => session().fillMiniToolSlot('clips', clip('c', 8), true));
    expect(screen.queryByTestId('join-add')).toBeNull();
  });

  it('refuses Run past the cap with a toast naming it, and says the same under the row (inner#1825 §6.5)', () => {
    const onRun = vi.fn(() => Promise.resolve());
    // A selection of four opens the panel past the cap of three.
    session().openJoinPanel('audio.join', [clip('a', 10), clip('b', 4), clip('c', 8), clip('d', 6)]);
    mount(onRun);
    const said = t('canvas.miniTool.panel.joinTooMany', { n: 3 });
    expect(said).toContain('3');
    expect(screen.getByTestId('join-too-many')).toHaveTextContent(said);
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(said);
  });

  it.each([
    ['half the shortest clip when that is shorter', [10, 4, 8], '2'],
    ['the tool’s own maximum when every clip is long', [10, 12], '3'],
  ] as const)('caps the crossfade at %s', (_what, lengths, max) => {
    session().openJoinPanel('audio.join', lengths.map((length, i) => clip(['a', 'b', 'c'][i] ?? 'x', length)));
    mount();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuemax', max);
  });

  it('heads the row saying the clips join in order and drag to reorder', () => {
    session().openJoinPanel('audio.join', [clip('a', 10), clip('b', 4)]);
    mount();
    expect(screen.getByTestId('join-panel')).toHaveTextContent(t('canvas.miniTool.panel.joinClips'));
  });

  it('says under the crossfade how far the shortest clip lets it go, and nothing when no clip holds it back', () => {
    session().openJoinPanel('audio.join', [clip('a', 10), clip('b', 4), clip('c', 8)]);
    mount();
    expect(screen.getByTestId('join-crossfade-cap')).toHaveTextContent(t('canvas.miniTool.panel.joinCrossfadeCap', { cap: '2', shortest: '4' }));
    act(() => removeTile('b'));
    expect(screen.queryByTestId('join-crossfade-cap')).toBeNull();
  });

  it('starts the bottom line with the joined length, following the crossfade, and drops it while a clip has no length', () => {
    session().openJoinPanel('audio.join', [clip('a', 10), clip('b', 4), clip('c', 8)]);
    mount();
    expect(screen.getByTestId('join-total')).toHaveTextContent(t('canvas.miniTool.panel.joinTotal', { seconds: '22' }));
    const footer = screen.getByTestId('mini-tool-credit').parentElement as HTMLElement;
    expect(footer.firstElementChild).toBe(screen.getByTestId('join-total'));
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(screen.getByTestId('join-total')).toHaveTextContent(t('canvas.miniTool.panel.joinTotal', { seconds: '21.8' }));
    act(() => session().fillMiniToolSlot('clips', { url: 'https://cdn/d.mp3', nodeId: 'd', name: 'D' } as MiniToolSlotValue, true));
    expect(screen.queryByTestId('join-total')).toBeNull();
  });

  it('sends the list’s first clip as the source and the rest as clips, so reordering changes the source', () => {
    const onRun = vi.fn(() => Promise.resolve());
    session().openJoinPanel('audio.join', [clip('a', 10), clip('b', 4), clip('c', 8)]);
    mount(onRun);
    act(() => session().moveMiniToolSlotItem('clips', 'c', 0));
    expect(tiles()).toEqual(['c', 'a', 'b']);
    fireEvent.click(screen.getByTestId('mini-tool-run'));

    expect(onRun).toHaveBeenCalledTimes(1);
    const [, spec, snapshot] = onRun.mock.calls[0] as unknown as [string, { id: string }, { source: unknown; slots: Record<string, unknown> }];
    expect(spec.id).toBe('audio.join');
    expect(snapshot.source).toEqual({ url: 'https://cdn/c.mp3', duration: 8 });
    expect(snapshot.slots.clips).toEqual([clip('a', 10), clip('b', 4)]);
  });
});
