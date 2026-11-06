// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec W-58 to W-60: the video panel's three
 * undo batches (model switch with re-split, mode switch into the shots,
 * param edit with re-split) are each one add through the size gateway.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import type { ModelCatalog, ModelEntry } from '@breatic/shared';
import type * as ProviderModule from '@hocuspocus/provider';
import type { ReactNode } from 'react';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
// Real Radix Tooltip throws without the app-level provider; not under test here.
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock('@web/data/api/assets', () => ({
  assetsApi: { reportDeleted: vi.fn(() => Promise.resolve()) },
}));
// The panel never opens its own WebSocket in a component test.
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({ provider: null, synced: false, status: 'connecting', authFailedReason: null })),
}));

import { toast } from '@web/lib/toast';
import { modelsApi } from '@web/data/api';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { addNode, nodeDataMap, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { enterStoryboardShots, readShots } from '@web/data/yjs/node-storyboard';
import type { VideoNodeView } from '@web/data/yjs/node-view';
import { CanvasContext, type CanvasContextValue } from '@web/spaces/canvas/canvas-context';
import { VideoGeneratePanelContainer } from '@web/spaces/canvas/generate/VideoGeneratePanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import { COPY_EN, F_FULL, F_WARNING, type DocSizePush } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const NAME = docName.canvasSpace('p', 's');

/** A model whose shots ride in a field of their own (total 3, 5 or 10 s). */
const KLING: ModelEntry = {
  name: 'kling-v3',
  display_name: 'Kling v3',
  modality: 'video',
  mode: ['t2v', 'multi_shot'],
  description: '',
  guide: '',
  tier: 'recommended',
  generation_time: 120,
  takes_prompt: true,
  params: {
    duration: { description: '', values: [3, 5, 10], default: 5, fill: 'panel' },
    multi_prompt: {
      description: '',
      default: null,
      type: 'items',
      max_items: 6,
      modes: ['multi_shot'],
      fill: 'storyboard',
      fields: { prompt: { type: 'text', max_chars: 512 }, duration: { values: [1, 2, 3, 4, 5] } },
    },
  },
  providers: [],
};

/** A model with a 10-second default total, so switching to it re-splits the shots. */
const WAN: ModelEntry = {
  ...KLING,
  name: 'wan-3',
  display_name: 'Wan 3',
  params: {
    duration: { description: '', values: [5, 10], default: 10, fill: 'panel' },
    shots: {
      description: '',
      default: null,
      type: 'items',
      modes: ['multi_shot'],
      into_prompt: 'Shot {n} [{start}-{end}s]: {prompt}',
      fill: 'storyboard',
      fields: { prompt: { type: 'text' }, duration: { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } },
    },
  },
};

/**
 * The catalog the panel loads.
 * @returns The catalog payload `modelsApi.list()` resolves to.
 */
function catalog(): ModelCatalog {
  return { image: [], video: [KLING, WAN], audio: [], tts: [], three_d: [], total: 2, credit_multiplier: 1 } as ModelCatalog;
}

/**
 * The stored data of the panel's node v1.
 * @returns Its model, mode and per-model params.
 */
function stored(): { model: unknown; mode: unknown; paramsByModel: unknown } {
  const data = nodeDataMap(getDoc(NAME), 'v1');
  return { model: data?.get('model'), mode: data?.get('mode'), paramsByModel: data?.get('paramsByModel') };
}

/**
 * Each shot's seconds, in order.
 * @returns The durations.
 */
function shotSeconds(): number[] | undefined {
  return readShots('p', 's', 'v1')?.map((shot) => shot.duration);
}

/**
 * Seeds v1 on Kling in a mode (with two shots when in multi_shot), opens its
 * panel, then delivers the push.
 * @param mode - The mode v1 stores.
 * @param push - The size push.
 * @param params - Kling's stored params.
 * @throws {Error} When the panel does not open.
 */
async function openAt(mode: 't2v' | 'multi_shot', push: DocSizePush, params: Record<string, unknown> = {}): Promise<void> {
  vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
  const { provider } = openSizedDoc(NAME);
  const data = { mode, model: 'kling-v3', modelByMode: { [mode]: 'kling-v3' }, paramsByModel: { 'kling-v3': params } };
  addNode('p', 's', {
    id: 'v1',
    type: 'video',
    position: { x: 0, y: 0 },
    data: { name: 'V', createdAt: 1, createdBy: 'u1', locked: false, attachments: [], ...data },
  } as Parameters<typeof addNode>[2]);
  if (mode === 'multi_shot') enterStoryboardShots('p', 's', 'v1', 5);
  const canvas: CanvasContextValue = { projectId: 'p', spaceId: 's', readOnly: false, myRole: 'editor', caretProvider: null };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReactFlow nodes={[{ id: 'v1', position: { x: 0, y: 0 }, data: {} }]} edges={[]} panOnDrag={false}>
        <CanvasContext.Provider value={canvas}>
          <VideoGeneratePanelContainer
            projectId='p'
            spaceId='s'
            edges={[]}
            nodes={[{ id: 'v1', type: 'video', data: { handling: false, ...data } as VideoNodeView }]}
            getLastWriteWasLocal={() => true}
            placeTemplate={() => ({ nodeIds: [], rects: [] })}
          />
        </CanvasContext.Provider>
      </ReactFlow>
    </QueryClientProvider>,
  );
  act(() => {
    canvasSessions.of('s').getState().openGeneratePanel('v1', 'video');
  });
  await screen.findByTestId('generate-video-execute');
  pushSize(provider, push);
  vi.mocked(toast.warning).mockClear();
}

/**
 * Asserts the one add-blocked warning and no error.
 * @throws {AssertionError} When the toasts differ.
 */
async function expectAddBlockedOnce(): Promise<void> {
  await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
  expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
  expect(toast.error).not.toHaveBeenCalled();
}

beforeEach(() => {
  sizeGateProviders.length = 0;
  canvasSessions.of('s').setState({ panelHostId: null, panelKind: null, pickSession: null });
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('W-58 switching the model and re-splitting the shots is one add', () => {
  it('keeps the model, the params and the shots once the Space is full', async () => {
    await openAt('multi_shot', F_FULL);
    const before = stored();
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    await userEvent.click(await screen.findByTestId('generate-model-option-wan-3'));
    await expectAddBlockedOnce();
    expect(stored()).toEqual(before);
    expect(stored().model).toBe('kling-v3');
    expect(shotSeconds()).toEqual([2, 3]);
  });

  it('switches and re-splits while the Space is only near full', async () => {
    await openAt('multi_shot', F_WARNING);
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    await userEvent.click(await screen.findByTestId('generate-model-option-wan-3'));
    await waitFor(() => expect(shotSeconds()).toEqual([4, 6]));
    expect(stored().model).toBe('wan-3');
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-59 switching into the shots is one add', () => {
  it('keeps the mode and lays out no shot once the Space is full', async () => {
    await openAt('t2v', F_FULL);
    fireEvent.click(screen.getByTestId('generate-video-mode-trigger'));
    await userEvent.click(await screen.findByTestId('generate-video-mode-multi-shot'));
    await expectAddBlockedOnce();
    expect(stored().mode).toBe('t2v');
    expect(readShots('p', 's', 'v1')).toHaveLength(0);
  });

  it('enters the mode with shots while the Space is only near full', async () => {
    await openAt('t2v', F_WARNING);
    fireEvent.click(screen.getByTestId('generate-video-mode-trigger'));
    await userEvent.click(await screen.findByTestId('generate-video-mode-multi-shot'));
    await waitFor(() => expect(stored().mode).toBe('multi_shot'));
    expect(readShots('p', 's', 'v1')!.length).toBeGreaterThanOrEqual(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-60 editing the total and re-splitting the shots is one add', () => {
  it('keeps the params and the shots once the Space is full', async () => {
    await openAt('multi_shot', F_FULL);
    const before = stored().paramsByModel;
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    fireEvent.click(await screen.findByTestId('generate-video-duration-option-10'));
    await expectAddBlockedOnce();
    expect(stored().paramsByModel).toEqual(before);
    expect(shotSeconds()).toEqual([2, 3]);
  });

  it('writes a total no longer than the stored one at full, as an overwrite', async () => {
    await openAt('multi_shot', F_FULL, { duration: 10 });
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    fireEvent.click(await screen.findByTestId('generate-video-duration-option-5'));
    await waitFor(() => expect((stored().paramsByModel as Record<string, Record<string, unknown>>)['kling-v3']?.duration).toBe(5));
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('writes the new total while the Space is only near full', async () => {
    await openAt('multi_shot', F_WARNING);
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    fireEvent.click(await screen.findByTestId('generate-video-duration-option-10'));
    await waitFor(() => expect((stored().paramsByModel as Record<string, Record<string, unknown>>)['kling-v3']?.duration).toBe(10));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
