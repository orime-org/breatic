// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import type { ModelCatalog, ModelEntry, VoicePage } from '@breatic/shared';
import type { ReactNode } from 'react';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

// Real Radix Tooltip throws without the app-level provider (App.tsx mounts it);
// tooltip behaviour is pinned in its own suite.
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: ReactNode }) => children,
}));

// So the component test never opens a real WebSocket.
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({
    provider: null,
    synced: false,
    status: 'connecting' as const,
    authFailedReason: null,
  })),
}));

const listVoices = vi.fn();
const getVoice = vi.fn();
vi.mock('@web/data/api/voices', () => ({
  voicesApi: {
    list: (...args: unknown[]) => listVoices(...args),
    get: (...args: unknown[]) => getVoice(...args),
  },
}));

import * as Y from 'yjs';
import { toast } from 'sonner';
import { t } from '@breatic/shared';

import { AudioGeneratePanelContainer } from '@web/spaces/canvas/generate/AudioGeneratePanelContainer';
import {
  addNode,
  getPromptFragment,
  nodeDataMap,
  readCanvasGraph,
} from '@web/data/yjs/canvas-space';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { canvasApi } from '@web/data/api/canvas';
import { modelsApi } from '@web/data/api';
import {
  CanvasContext,
  type CanvasContextValue,
} from '@web/spaces/canvas/canvas-context';
import { useCanvasStore } from '@web/stores';

const ELEVEN: ModelEntry = {
  name: 'elevenlabs-v3',
  display_name: 'ElevenLabs V3',
  modality: 'tts',
  mode: 'tts',
  description: '',
  guide: '',
  tier: 'recommended',
  cost_per_call: 10,
  generation_time: 30,
  takes_prompt: true,
  params: {
    voice_id: { description: '', default: 'Alice', remote_source: 'voices' },
    stability: { description: '', values: [0, 0.5, 1], default: 0.5 },
  },
  providers: [],
  sourcesByMode: { tts: [] },
  rate: { credits: 10, per: 1000, unit: 'characters' },
};

const FISH: ModelEntry = {
  ...ELEVEN,
  name: 'fish-s2-pro',
  display_name: 'Fish S2 Pro',
  params: {
    reference_id: { description: '', default: null, remote_source: 'voices' },
    speed: { description: '', min: 0.5, max: 2, step: 0.05, default: 1 },
  },
  rate: { credits: 1.5, per: 1000, unit: 'utf8_bytes' },
};

/** A sound-effect model, as `config/models/audio/` holds one today. */
const SFX: ModelEntry = {
  ...ELEVEN,
  name: 'elevenlabs-sfx-v2',
  display_name: 'ElevenLabs SFX V2',
  modality: 'audio',
  mode: 'sfx',
  params: {},
  sourcesByMode: { sfx: [] },
};

/**
 * A catalog holding both tts models — the two buckets this panel reads.
 * @returns A model catalog.
 */
function catalog(): ModelCatalog {
  return {
    image: [],
    video: [],
    // The audio bucket really does hold non-voiceover models today
    // (`config/models/audio/`), and this panel reads both buckets.
    audio: [SFX],
    tts: [ELEVEN, FISH],
    three_d: [],
    understand: [],
    total: 2,
  };
}

/**
 * A page of voices.
 * @param ids - The voice ids.
 * @returns A voice page.
 */
function voicePage(ids: string[]): VoicePage {
  return { voices: ids.map((id) => ({ id, name: id })), hasMore: false };
}

/**
 * Seeds a real audio node so the panel gets a prompt fragment and the
 * collaborative editor mounts.
 * @param over - Node data overrides.
 */
function seedAudioNode(over: Record<string, unknown> = {}): void {
  addNode('p', 's', {
    id: 'target',
    type: 'audio',
    position: { x: 0, y: 0 },
    data: {
      name: 'A',
      createdAt: 1000,
      createdBy: 'u1',
      locked: false,
      state: 'idle',
      attachments: [],
      // A non-zero lease so the gen fence assertion tells a real read from a
      // hardcoded 0.
      leaseGen: 3,
      ...over,
    },
  } as Parameters<typeof addNode>[2]);
}

/**
 * Writes a prompt into the seeded node's fragment — what typing produces.
 * @param text - The lines to speak.
 */
function typePrompt(text: string): void {
  const fragment = getPromptFragment('p', 's', 'target');
  if (!fragment) throw new Error('seedAudioNode must run first');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(0, [paragraph]);
}

/**
 * The panel tree, with the canvas context and query client it needs.
 * @param nodeData - Extra fields on the target node's view data.
 * @returns The element to render.
 */
function panelTree(nodeData: Record<string, unknown> = {}): React.ReactElement {
  const canvas: CanvasContextValue = {
    projectId: 'p',
    spaceId: 's',
    readOnly: false,
    caretProvider: null,
  };
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* panOnDrag off: a pointer sequence in the panel bubbles to ReactFlow's
          d3-zoom, which reads `event.view.document` — null in jsdom. */}
      <ReactFlow
        nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
        edges={[]}
        panOnDrag={false}
      >
        <CanvasContext.Provider value={canvas}>
          <AudioGeneratePanelContainer
            projectId='p'
            spaceId='s'
            edges={[]}
            nodes={[
              {
                id: 'target',
                data: { kind: 'audio', status: 'idle', ...nodeData } as Parameters<
                  typeof AudioGeneratePanelContainer
                >[0]['nodes'][number]['data'],
              },
            ]}
          />
        </CanvasContext.Provider>
      </ReactFlow>
    </QueryClientProvider>
  );
}

/**
 * Opens the panel on a seeded node, once the catalog has landed.
 * @param nodeData - Extra node data (model, paramsByModel, locked, …).
 * @returns The render result.
 */
async function openPanel(
  nodeData: Record<string, unknown> = {},
): Promise<ReturnType<typeof render>> {
  vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
  seedAudioNode(nodeData);
  const view = render(panelTree(nodeData));
  act(() => {
    useCanvasStore.getState().openGeneratePanel('target', 'audio');
  });
  await screen.findByTestId('generate-audio-execute');
  return view;
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
  listVoices.mockReset();
  listVoices.mockResolvedValue(voicePage(['Alice', 'Aria']));
  getVoice.mockReset();
  getVoice.mockResolvedValue({ id: 'Aria', name: 'Aria' });
  _resetForTests();
  useCanvasStore.setState({ panelHostId: null, panelKind: null, pickSession: null });
});

describe('AudioGeneratePanelContainer — what it offers', () => {
  it('shows the panel with the model, voice and params controls', async () => {
    await openPanel({ model: 'elevenlabs-v3' });
    expect(screen.getByTestId('generate-model-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('generate-voice-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('generate-audio-params-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('generate-audio-tool-reference')).toBeInTheDocument();
  });

  it('offers only the models this mode can run', async () => {
    // The panel reads two catalog buckets, and the audio one holds sound
    // effect, music and vocal-remover models. Listing one of those under
    // voiceover offers a pick the panel then silently reverts.
    await openPanel({ model: 'elevenlabs-v3' });
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    expect(screen.getByTestId('generate-model-option-elevenlabs-v3')).toBeInTheDocument();
    expect(screen.getByTestId('generate-model-option-fish-s2-pro')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-model-option-elevenlabs-sfx-v2')).toBeNull();
  });

  it('offers no way to submit a node that has no prompt container', async () => {
    // A node built before generation reached audio has nowhere to put the
    // lines. The panel says so where the editor would be — and a live submit
    // button beside that sentence invites a click whose only answer is "write
    // the lines" into a box that is not there.
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    seedAudioNode({ model: 'elevenlabs-v3' });
    nodeDataMap(getDoc(docName.canvasSpace('p', 's')), 'target')?.delete('prompt');
    render(panelTree({ model: 'elevenlabs-v3' }));
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'audio');
    });

    await screen.findByTestId('generate-audio-legacy');
    expect(screen.queryByTestId('generate-audio-execute')).toBeNull();
  });

  it('asks for lines to speak, not for a picture', async () => {
    // The prompt box carries the panel's only instruction on what to type. The
    // image panel's copy asks for a picture, which is the wrong thing to write
    // into a box whose text a voice will read out.
    await openPanel({ model: 'elevenlabs-v3' });
    const placeholder = screen
      .getByTestId('generate-prompt-editor')
      .querySelector('[data-placeholder]')
      ?.getAttribute('data-placeholder');
    expect(placeholder).toBe(t('canvas.generatePanel.audioPromptPlaceholder'));
    expect(placeholder).not.toBe(t('canvas.generatePanel.promptPlaceholder'));
  });

  it('states the rate of the model it is on, in that vendor\'s unit', async () => {
    await openPanel({ model: 'fish-s2-pro' });
    expect(screen.getByTestId('generate-audio-rate').textContent).toContain('1.5');
  });
});

describe('AudioGeneratePanelContainer — picking writes to the node', () => {
  it('stores a picked voice on the model\'s own record', async () => {
    await openPanel({ model: 'elevenlabs-v3' });
    fireEvent.click(screen.getByTestId('generate-voice-trigger'));
    await screen.findByTestId('generate-voice-option-Aria');
    fireEvent.click(screen.getByTestId('generate-voice-option-Aria'));

    await waitFor(() => {
      const node = readCanvasGraph('p', 's').nodes.find((n) => n.id === 'target');
      const record = (node?.data as { paramsByModel?: Record<string, Record<string, unknown>> })
        .paramsByModel?.['elevenlabs-v3'];
      expect(record?.voice_id).toBe('Aria');
    });
  });

  it('stores a changed param on that same record', async () => {
    await openPanel({ model: 'elevenlabs-v3' });
    fireEvent.click(screen.getByTestId('generate-audio-params-trigger'));
    fireEvent.click(screen.getByTestId('generate-audio-stability-option-1'));

    await waitFor(() => {
      const node = readCanvasGraph('p', 's').nodes.find((n) => n.id === 'target');
      const record = (node?.data as { paramsByModel?: Record<string, Record<string, unknown>> })
        .paramsByModel?.['elevenlabs-v3'];
      expect(record?.stability).toBe(1);
    });
  });
});

describe('AudioGeneratePanelContainer — submitting', () => {
  it('refuses when no voice has been chosen, and says which', async () => {
    // The catalog's default voice is not a value every deployment accepts, so
    // an untouched picker means no voice — and the submit says so rather than
    // sending one the user never saw.
    const create = vi.spyOn(canvasApi, 'createTask').mockResolvedValue({} as never);
    await openPanel({ model: 'elevenlabs-v3' });
    typePrompt('Good evening.');
    fireEvent.click(screen.getByTestId('generate-audio-execute'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the task once a voice and lines are in place', async () => {
    const create = vi.spyOn(canvasApi, 'createTask').mockResolvedValue({} as never);
    await openPanel({
      model: 'elevenlabs-v3',
      paramsByModel: { 'elevenlabs-v3': { voice_id: 'Aria' } },
    });
    typePrompt('Good evening.');
    fireEvent.click(screen.getByTestId('generate-audio-execute'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]?.[0];
    expect(payload?.task_type).toBe('tts');
    expect(payload?.model).toBe('elevenlabs-v3');
    expect(payload?.params.prompt).toBe('Good evening.');
    expect(payload?.params.voice_id).toBe('Aria');
    // Read off the node, not hardcoded: the seeded lease is 3.
    expect(payload?.node_gens).toEqual({ target: 4 });
  });

  it('refuses on a locked node', async () => {
    const create = vi.spyOn(canvasApi, 'createTask').mockResolvedValue({} as never);
    await openPanel({
      model: 'elevenlabs-v3',
      paramsByModel: { 'elevenlabs-v3': { voice_id: 'Aria' } },
      locked: true,
    });
    typePrompt('Good evening.');
    fireEvent.click(screen.getByTestId('generate-audio-execute'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
  });
});
