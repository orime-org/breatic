// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap v2 (inner#1790 v2 web spec E-10, SB-01, SB-02, RQ-16): the
 * video panel's undo batches (model switch with re-split, mode switch into
 * the shots, param edit with re-split) are refused at `full` with the add
 * toast, since both `edit` and `add` are; and Generate on the existing node
 * sends no task when the Space cannot take an add.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import type { ModelCatalog, ModelEntry } from '@breatic/shared';
import type { ReactNode } from 'react';
import * as Y from 'yjs';

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
import { canvasApi } from '@web/data/api/canvas';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { addNode, getPromptFragment, nodeDataMap, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { enterStoryboardShots, readShots } from '@web/data/yjs/node-storyboard';
import type { VideoNodeView } from '@web/data/yjs/node-view';
import { CanvasContext, type CanvasContextValue } from '@web/spaces/canvas/canvas-context';
import { VideoGeneratePanelContainer } from '@web/spaces/canvas/generate/VideoGeneratePanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import {
  SIZE_COPY_EN,
  enterSize,
  expectSizeToast,
  type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

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
  availability: { upstreams: [{ upstream: 'wavespeed', weight: 1, configured: false, envVar: 'WAVESPEED_API_KEY' }] },
  pricing_rules: undefined,
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
 * panel, then puts the Space in one size state.
 * @param mode - The mode v1 stores.
 * @param code - The size state.
 * @param params - Kling's stored params.
 * @param prompt - Words typed into the mode's prompt box, when given.
 * @throws {Error} When the panel does not open.
 */
async function openAt(mode: 't2v' | 'multi_shot', code: SizeCode, params: Record<string, unknown> = {}, prompt?: string): Promise<void> {
  vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
  const data = { mode, model: 'kling-v3', modelByMode: { [mode]: 'kling-v3' }, paramsByModel: { 'kling-v3': params } };
  addNode('p', 's', {
    id: 'v1',
    type: 'video',
    position: { x: 0, y: 0 },
    data: { name: 'V', createdAt: 1, createdBy: 'u1', locked: false, attachments: [], ...data },
  } as Parameters<typeof addNode>[2]);
  if (mode === 'multi_shot') enterStoryboardShots('p', 's', 'v1', 5);
  if (prompt !== undefined) {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(prompt)]);
    getPromptFragment('p', 's', 'v1', mode)!.insert(0, [paragraph]);
  }
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
  enterSize(NAME, code);
  vi.mocked(toast.warning).mockClear();
}

/**
 * Asserts the one add-blocked warning and no error.
 * @throws {AssertionError} When the toasts differ.
 */
async function expectAddBlockedOnce(): Promise<void> {
  await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
  expectSizeToast(SIZE_COPY_EN.T_ADD);
}

beforeEach(() => {
  vi.spyOn(canvasApi, 'createTask').mockResolvedValue({ id: 't1' } as Awaited<ReturnType<typeof canvasApi.createTask>>);
  canvasSessions.of('s').setState({ panelHostId: null, panelKind: null, pickSession: null });
});

afterEach(() => {
  resetRunOnceForTests();
  clearAllDocSizes();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('E-10 switching the model and re-splitting the shots is one batch', () => {
  it('E-10 [F] keeps the model, the params and the shots', async () => {
    await openAt('multi_shot', 'F');
    const before = stored();
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    await userEvent.click(await screen.findByTestId('generate-model-option-wan-3'));
    await expectAddBlockedOnce();
    expect(stored()).toEqual(before);
    expect(stored().model).toBe('kling-v3');
    expect(shotSeconds()).toEqual([2, 3]);
  });

  it('E-10 [W] switches and re-splits', async () => {
    await openAt('multi_shot', 'W');
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    await userEvent.click(await screen.findByTestId('generate-model-option-wan-3'));
    await waitFor(() => expect(shotSeconds()).toEqual([4, 6]));
    expect(stored().model).toBe('wan-3');
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('SB-01 switching into the shots is one add batch', () => {
  it('SB-01 [F] keeps the mode and lays out no shot', async () => {
    await openAt('t2v', 'F');
    fireEvent.click(screen.getByTestId('generate-video-mode-trigger'));
    await userEvent.click(await screen.findByTestId('generate-video-mode-multi-shot'));
    await expectAddBlockedOnce();
    expect(stored().mode).toBe('t2v');
    expect(readShots('p', 's', 'v1')).toHaveLength(0);
  });

  it('SB-01 [W] enters the mode with shots', async () => {
    await openAt('t2v', 'W');
    fireEvent.click(screen.getByTestId('generate-video-mode-trigger'));
    await userEvent.click(await screen.findByTestId('generate-video-mode-multi-shot'));
    await waitFor(() => expect(stored().mode).toBe('multi_shot'));
    expect(readShots('p', 's', 'v1')!.length).toBeGreaterThanOrEqual(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('SB-02 editing the total and re-splitting the shots is one batch', () => {
  it('SB-02 [F] keeps the params and the shots', async () => {
    await openAt('multi_shot', 'F');
    const before = stored().paramsByModel;
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    fireEvent.click(await screen.findByTestId('generate-video-duration-option-10'));
    await expectAddBlockedOnce();
    expect(stored().paramsByModel).toEqual(before);
    expect(shotSeconds()).toEqual([2, 3]);
  });

  it('SB-02 [F] refuses a shorter total too: an edit is refused at full', async () => {
    await openAt('multi_shot', 'F', { duration: 10 });
    const before = stored().paramsByModel;
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    fireEvent.click(await screen.findByTestId('generate-video-duration-option-5'));
    await expectAddBlockedOnce();
    expect(stored().paramsByModel).toEqual(before);
  });

  it('SB-02 [W] writes the new total', async () => {
    await openAt('multi_shot', 'W');
    fireEvent.click(screen.getByTestId('generate-video-params-trigger'));
    fireEvent.click(await screen.findByTestId('generate-video-duration-option-10'));
    await waitFor(() => expect((stored().paramsByModel as Record<string, Record<string, unknown>>)['kling-v3']?.duration).toBe(10));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('RQ-16 Generate on an existing video node sends no task when the Space cannot take an add', () => {
  it.each([
    ['F', SIZE_COPY_EN.T_ADD],
    ['O', SIZE_COPY_EN.T_OVER],
    ['Z', null],
  ] as const)('RQ-16 [%s] video: createTask is not called and the node is unchanged', async (code, sentence) => {
    await openAt('t2v', code, {}, 'a drone shot over a canyon');
    const doc = getDoc(NAME);
    const before = Y.encodeStateAsUpdate(doc);
    const execute = screen.getByTestId('generate-video-execute');
    await waitFor(() => expect(execute).not.toBeDisabled());
    fireEvent.click(execute);
    await act(async () => {
      await Promise.resolve();
    });
    expect(canvasApi.createTask).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expectSizeToast(sentence);
  });

  it('RQ-16 [W] video: Generate sends the task once (control)', async () => {
    await openAt('t2v', 'W', {}, 'a drone shot over a canyon');
    const execute = screen.getByTestId('generate-video-execute');
    await waitFor(() => expect(execute).not.toBeDisabled());
    fireEvent.click(execute);
    await waitFor(() => expect(canvasApi.createTask).toHaveBeenCalledTimes(1));
    expectSizeToast(null);
  });
});
