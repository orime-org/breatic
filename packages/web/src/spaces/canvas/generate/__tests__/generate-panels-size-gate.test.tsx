// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap v2 (inner#1790 v2 web spec RQ-16, the image and audio
 * panels; the video panel is in `video-panel-size-gate.test.tsx`): Generate on
 * an existing node is a server write into that node, so the panel asks
 * `canAdd` before `canvasApi.createTask`; when the Space cannot take an add no
 * task is sent, no credits are spent and the node is unchanged.
 */

import { Activity } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import * as Y from 'yjs';
import type { ModelCatalog, ModelEntry, VoicePage } from '@breatic/shared';
import type { ReactNode } from 'react';

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
// The panels never open their own WebSocket in a component test.
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({ provider: null, synced: false, status: 'connecting', authFailedReason: null })),
}));
vi.mock('@web/data/api/voices', () => ({
  voicesApi: {
    list: vi.fn((): Promise<VoicePage> => Promise.resolve({ voices: [{ id: 'Aria', name: 'Aria' }], hasMore: false })),
    get: vi.fn(() => Promise.resolve({ id: 'Aria', name: 'Aria' })),
  },
}));

import { toast } from '@web/lib/toast';
import { modelsApi } from '@web/data/api';
import { canvasApi } from '@web/data/api/canvas';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { addNode, getPromptFragment, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { CanvasContext, type CanvasContextValue } from '@web/spaces/canvas/canvas-context';
import { AudioGeneratePanelContainer } from '@web/spaces/canvas/generate/AudioGeneratePanelContainer';
import { GeneratePanelContainer } from '@web/spaces/canvas/generate/GeneratePanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import {
  SIZE_COPY_EN,
  enterSize,
  expectSizeToast,
  type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const NAME = docName.canvasSpace('p', 's');

/** A text-to-image model that runs without a prompt, so Generate is ready at once. */
const T2I: ModelEntry = {
  name: 'nano-banana',
  display_name: 'Nano Banana',
  modality: 'image',
  mode: 't2i',
  description: '',
  guide: '',
  tier: 'recommended',
  generation_time: 10,
  takes_prompt: false,
  params: { aspect_ratio: { description: '', values: ['1:1', '16:9'], default: '1:1' } },
  availability: { upstreams: [{ upstream: 'wavespeed', weight: 1, configured: false, envVar: 'WAVESPEED_API_KEY' }] },
  pricing_rules: undefined,
};

/** A text-to-speech model with a voice catalog. */
const ELEVEN: ModelEntry = {
  name: 'elevenlabs-v3',
  display_name: 'ElevenLabs V3',
  modality: 'tts',
  mode: 'tts',
  description: '',
  guide: '',
  tier: 'recommended',
  generation_time: 30,
  takes_prompt: true,
  params: { voice_id: { description: '', default: 'Aria', remote_source: 'voices' } },
  availability: { upstreams: [{ upstream: 'wavespeed', weight: 1, configured: false, envVar: 'WAVESPEED_API_KEY' }] },
  pricing_rules: undefined,
};

/**
 * The catalog both panels load.
 * @returns The catalog payload `modelsApi.list()` resolves to.
 */
function catalog(): ModelCatalog {
  return { image: [T2I], video: [], audio: [], tts: [ELEVEN], three_d: [], total: 2, credit_multiplier: 1 };
}

const CANVAS: CanvasContextValue = { projectId: 'p', spaceId: 's', readOnly: false, myRole: 'editor', caretProvider: null };

/**
 * Who made the newest document write; these cases never read it.
 * @returns Always true.
 */
function lastWriteLocal(): boolean {
  return true;
}

/**
 * Seeds the target node of one modality.
 * @param type - The modality.
 * @param data - Extra node data.
 */
function seed(type: 'image' | 'audio', data: Record<string, unknown>): void {
  addNode('p', 's', {
    id: 'target',
    type,
    position: { x: 0, y: 0 },
    data: { name: 'T', createdAt: 1000, createdBy: 'u1', locked: false, attachments: [], ...data },
  });
}

/**
 * Mounts the image panel on a seeded image node, puts the Space in one size
 * state, and returns the ready Generate button.
 * @param code - The size state.
 * @returns The button.
 */
async function openImage(code: SizeCode): Promise<HTMLElement> {
  vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
  seed('image', { mode: 't2i', model: 'nano-banana' });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Activity mode='visible'>
        <ReactFlow nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]} edges={[]}>
          <CanvasContext.Provider value={CANVAS}>
            <GeneratePanelContainer
              projectId='p'
              spaceId='s'
              nodes={[{ id: 'target', type: 'image', data: { handling: false, mode: 't2i', model: 'nano-banana' } }] as Parameters<typeof GeneratePanelContainer>[0]['nodes']}
              edges={[]}
              getLastWriteWasLocal={lastWriteLocal}
              placeTemplate={() => ({ nodeIds: [], rects: [] })}
            />
          </CanvasContext.Provider>
        </ReactFlow>
      </Activity>
    </QueryClientProvider>,
  );
  act(() => {
    canvasSessions.of('s').getState().openGeneratePanel('target', 'image');
  });
  const button = await screen.findByTestId('generate-execute');
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  enterSize(NAME, code);
  vi.mocked(toast.warning).mockClear();
  return button;
}

/**
 * Mounts the audio panel on a seeded text-to-speech node with a voice and a
 * line, puts the Space in one size state, and returns the Generate button.
 * @param code - The size state.
 * @returns The button.
 */
async function openAudio(code: SizeCode): Promise<HTMLElement> {
  vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
  const data = { mode: 'tts', model: 'elevenlabs-v3', paramsByModel: { 'elevenlabs-v3': { voice_id: 'Aria' } } };
  seed('audio', data);
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText('Good evening.')]);
  getPromptFragment('p', 's', 'target', 'tts')!.insert(0, [paragraph]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReactFlow nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]} edges={[]} panOnDrag={false}>
        <CanvasContext.Provider value={CANVAS}>
          <AudioGeneratePanelContainer
            projectId='p'
            spaceId='s'
            getLastWriteWasLocal={lastWriteLocal}
            placeTemplate={() => ({ nodeIds: [], rects: [] })}
            edges={[]}
            nodes={[{ id: 'target', type: 'audio', data: { handling: false, ...data } }]}
          />
        </CanvasContext.Provider>
      </ReactFlow>
    </QueryClientProvider>,
  );
  act(() => {
    canvasSessions.of('s').getState().openGeneratePanel('target', 'audio');
  });
  const button = await screen.findByTestId('generate-audio-execute');
  enterSize(NAME, code);
  vi.mocked(toast.warning).mockClear();
  return button;
}

const PANELS = [
  ['image', openImage],
  ['audio', openAudio],
] as const;

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

describe('RQ-16 Generate on an existing node sends no task when the Space cannot take an add', () => {
  describe.each(PANELS)('%s panel', (_panel, open) => {
    it.each([
      ['F', SIZE_COPY_EN.T_ADD],
      ['O', SIZE_COPY_EN.T_OVER],
      ['Z', null],
    ] as const)('RQ-16 [%s] createTask is not called and the node is unchanged', async (code, sentence) => {
      const button = await open(code);
      const doc = getDoc(NAME);
      const before = Y.encodeStateAsUpdate(doc);
      fireEvent.click(button);
      await act(async () => {
        await Promise.resolve();
      });
      expect(canvasApi.createTask).not.toHaveBeenCalled();
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expectSizeToast(sentence);
    });

    it('RQ-16 [W] Generate sends the task once (control)', async () => {
      const button = await open('W');
      fireEvent.click(button);
      await waitFor(() => expect(canvasApi.createTask).toHaveBeenCalledTimes(1));
      expectSizeToast(null);
    });
  });
});
