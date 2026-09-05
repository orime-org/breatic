// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import en from '@locales/en.json';
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
  getLyricsFragment,
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

/**
 * Stands in for the canvas's "who made the newest write" getter.
 *
 * Module-level so its identity is stable across renders: the container lists
 * it in an effect's dependencies, and a fresh function each render would run
 * that effect every time.
 * @returns Always true — these cases never assert on the message it picks.
 */
function returnsTrue(): boolean {
  return true;
}


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
    // The shape elevenlabs.yaml declares: a continuous range, rendered as a
    // slider with the vendor's three named stops beneath it.
    stability: { description: '', min: 0, max: 1, step: 0.05, default: 0.5 },
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

/** The voice-cloning model: no voice catalog, one audio source (#1960 PR2). */
const CLONE: ModelEntry = {
  ...ELEVEN,
  name: 'qwen3-tts-voice-clone',
  display_name: 'Qwen3 Voice Clone',
  mode: 'voice_clone',
  params: { audio: { description: '', default: null } },
  sourcesByMode: { voice_clone: ['audio'] },
  rate: { credits: 5, per: 1000, unit: 'characters' },
};

/** The sound-effect model, as `config/models/audio/sonilo.yaml` declares it. */
const SFX: ModelEntry = {
  ...ELEVEN,
  name: 'sonilo-sfx-v1',
  display_name: 'Sonilo SFX',
  modality: 'audio',
  mode: 'sfx',
  params: {
    duration: {
      description: '',
      values: [1, 2, 5, 10, 15, 20, 30, 60, 120, 180],
      default: 5,
    },
    audio_format: { description: '', default: 'mp3' },
  },
  sourcesByMode: { sfx: [] },
  // $0.002 a second at 1 credit = 1 cent, so five seconds is one credit.
  rate: { credits: 1, per: 5, unit: 'seconds' },
};

/** Text to music, as `config/models/audio/minimax.yaml` declares it (#1960). */
const T2M: ModelEntry = {
  ...ELEVEN,
  name: 'minimax-music-3.0',
  display_name: 'MiniMax Music 3.0',
  modality: 'audio',
  mode: 't2m',
  params: {
    lyrics: { description: '', default: null },
    is_instrumental: { description: '', default: false },
  },
  sourcesByMode: { t2m: [] },
  cost_per_call: 15,
  rate: undefined,
};

/** Reference to music: three audio slots, and lyrics the gateway insists on. */
const A2M: ModelEntry = {
  ...T2M,
  name: 'minimax-music-01',
  display_name: 'MiniMax Music 01',
  mode: 'a2m',
  params: {
    lyrics: { description: '', default: null },
    song: { description: '', default: null },
    voice: { description: '', default: null },
    instrumental: { description: '', default: null },
  },
  sourcesByMode: { a2m: ['audio'] },
  cost_per_call: 35,
};

/**
 * A catalog holding both tts models — the two buckets this panel reads.
 * @returns A model catalog.
 */
function catalog(): ModelCatalog {
  return {
    image: [],
    video: [],
    // The audio bucket really does hold models outside text to speech today
    // (`config/models/audio/`), and this panel reads both buckets.
    audio: [SFX, T2M, A2M],
    tts: [ELEVEN, FISH, CLONE],
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
 * Writes lines into one of the node's fragments — what typing produces.
 *
 * One paragraph per line, because that is the only document the editor can
 * make: its schema is Document / Paragraph / Text with no hard break, so Enter
 * splits a block and nothing else creates a line. A single paragraph holding a
 * raw newline reads back through `getText` verbatim, which would make an
 * assertion about line shape pass against any serializer at all.
 * @param fragment - The fragment to write into.
 * @param lines - The lines, in order.
 */
function typeInto(fragment: Y.XmlFragment | null, lines: string[]): void {
  if (!fragment) throw new Error('seedAudioNode must run first');
  fragment.insert(
    0,
    lines.map((line) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(line)]);
      return paragraph;
    }),
  );
}

/**
 * Writes a prompt into the seeded node's fragment — what typing produces.
 * @param lines - The lines to speak.
 */
function typePrompt(...lines: string[]): void {
  typeInto(getPromptFragment('p', 's', 'target'), lines);
}

/**
 * Writes words into the seeded node's lyrics fragment (#1960).
 * @param lines - The words to sing, one line per paragraph.
 */
function typeLyrics(...lines: string[]): void {
  typeInto(getLyricsFragment('p', 's', 'target'), lines);
}

/**
 * The panel tree, with the canvas context and query client it needs.
 * @param nodeData - Extra fields on the target node's view data.
 * @returns The element to render.
 */
function panelTree(
  nodeData: Record<string, unknown> = {},
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  lastWriteWasLocal: () => boolean = returnsTrue,
): React.ReactElement {
  const canvas: CanvasContextValue = {
    projectId: 'p',
    spaceId: 's',
    readOnly: false,
    caretProvider: null,
  };
  return (
    <QueryClientProvider client={client}>
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
            getLastWriteWasLocal={lastWriteWasLocal}
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
 * @param lastWriteWasLocal - Who made the newest document write.
 * @returns The render result.
 */
async function openPanel(
  nodeData: Record<string, unknown> = {},
  lastWriteWasLocal: () => boolean = returnsTrue,
): Promise<ReturnType<typeof render>> {
  vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
  seedAudioNode(nodeData);
  const view = render(panelTree(nodeData, undefined, lastWriteWasLocal));
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
    // text to speech offers a pick the panel then silently reverts.
    await openPanel({ model: 'elevenlabs-v3' });
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    expect(screen.getByTestId('generate-model-option-elevenlabs-v3')).toBeInTheDocument();
    expect(screen.getByTestId('generate-model-option-fish-s2-pro')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-model-option-sonilo-sfx-v1')).toBeNull();
  });

  it('opens a node with no prompt container on the sentence alone', async () => {
    // A node built before generation reached audio has nowhere to put the
    // lines, and nothing the panel offers can change that. It says so once and
    // leaves the way out.
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    seedAudioNode({ model: 'elevenlabs-v3' });
    nodeDataMap(getDoc(docName.canvasSpace('p', 's')), 'target')?.delete('prompt');
    render(panelTree({ model: 'elevenlabs-v3' }));
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'audio');
    });

    await screen.findByTestId('generate-audio-legacy');
    expect(screen.getByTestId('generate-audio-exit')).toBeInTheDocument();
    for (const gone of [
      'generate-audio-execute',
      'generate-model-trigger',
      'generate-voice-trigger',
      'generate-audio-params-trigger',
      'generate-audio-tool-reference',
      'generate-audio-rate',
    ]) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
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

  it('asks for a sound under the sound-effect mode, not for lines to speak', async () => {
    // One placeholder across all three modes would tell someone writing a
    // sound effect to write the lines a voice will read (#2088 A3).
    await openPanel({ mode: 'sfx', model: 'sonilo-sfx-v1' });
    const placeholder = screen
      .getByTestId('generate-prompt-editor')
      .querySelector('[data-placeholder]')
      ?.getAttribute('data-placeholder');
    expect(placeholder).toBe(t('canvas.generatePanel.sfxPromptPlaceholder'));
    expect(placeholder).not.toBe(t('canvas.generatePanel.audioPromptPlaceholder'));
  });

  it('prices a sound effect by the length on the node, not by the description', async () => {
    // The model bills per second, so the figure reads off the length the node
    // holds rather than the prompt (#2088 A6). $0.002 a second at 1 credit =
    // 1 cent: five seconds is one credit, thirty is six.
    const { unmount } = await openPanel({
      mode: 'sfx',
      model: 'sonilo-sfx-v1',
      paramsByModel: { 'sonilo-sfx-v1': { duration: 5 } },
    });
    expect(screen.getByTestId('generate-audio-rate')).toHaveTextContent('1');
    unmount();

    await openPanel({
      mode: 'sfx',
      model: 'sonilo-sfx-v1',
      paramsByModel: { 'sonilo-sfx-v1': { duration: 30 } },
    });
    expect(screen.getByTestId('generate-audio-rate')).toHaveTextContent('6');
  });

  it('costs nothing on a panel whose prompt is still empty', async () => {
    // The figure follows the prompt, so a panel just opened on an empty one
    // reads zero. What it does as text arrives is `estimateAudioCredits`, and
    // its own tests cover the two vendors' units.
    await openPanel({ model: 'fish-s2-pro' });
    expect(screen.getByTestId('generate-audio-rate').textContent).toBe('0');
  });
});

describe('AudioGeneratePanelContainer — the mode comes off the node', () => {
  it('opens on the mode the node stores, not on the first one offered', async () => {
    await openPanel({ model: 'qwen3-tts-voice-clone', mode: 'voice_clone' });
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    expect(
      screen.getByTestId('generate-model-option-qwen3-tts-voice-clone'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('generate-model-option-elevenlabs-v3')).toBeNull();
  });

  it('writes a switched mode onto the node, with a model that mode can run', async () => {
    await openPanel({ model: 'elevenlabs-v3' });
    fireEvent.click(screen.getByTestId('generate-audio-mode-trigger'));
    fireEvent.click(await screen.findByTestId('generate-audio-mode-voice-clone'));

    await waitFor(() => {
      const node = readCanvasGraph('p', 's').nodes.find((n) => n.id === 'target');
      const data = node?.data as { mode?: string; model?: string };
      expect(data.mode).toBe('voice_clone');
      expect(data.model).toBe('qwen3-tts-voice-clone');
    });
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

  it('keeps the name off the row it was clicked on, sparing a round trip', async () => {
    // The trigger shows a name while the record holds an id, and the query
    // that turns one into the other is keyed by both. Seeding it from the
    // clicked row spares that query a request whose whole job is to fetch back
    // what the user just saw — and which, until it lands or if it fails,
    // leaves a raw id on the trigger.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    seedAudioNode({ model: 'elevenlabs-v3' });
    render(panelTree({ model: 'elevenlabs-v3' }, client));
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'audio');
    });
    await screen.findByTestId('generate-audio-execute');
    fireEvent.click(screen.getByTestId('generate-voice-trigger'));
    await screen.findByTestId('generate-voice-option-Aria');
    fireEvent.click(screen.getByTestId('generate-voice-option-Aria'));

    await waitFor(() => {
      expect(client.getQueryData(['voice', 'elevenlabs-v3', 'Aria'])).toEqual({
        id: 'Aria',
        name: 'Aria',
      });
    });
  });

  it('refuses a voice whose model is no longer the one on the node', async () => {
    // A collaborator switched the model while this picker was open. The id in
    // hand belongs to the outgoing model's domain; writing it into the
    // incoming model's record submits a value that vendor never issued.
    await openPanel({ model: 'elevenlabs-v3' });
    fireEvent.click(screen.getByTestId('generate-voice-trigger'));
    await screen.findByTestId('generate-voice-option-Aria');
    nodeDataMap(getDoc(docName.canvasSpace('p', 's')), 'target')?.set(
      'model',
      'fish-s2-pro',
    );
    fireEvent.click(screen.getByTestId('generate-voice-option-Aria'));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled();
    });
    const node = readCanvasGraph('p', 's').nodes.find((n) => n.id === 'target');
    const records = (
      node?.data as {
        paramsByModel?: Record<string, Record<string, unknown>>;
      }
    ).paramsByModel;
    expect(records?.['fish-s2-pro']?.reference_id).toBeUndefined();
  });

  it('stores a changed param on that same record', async () => {
    await openPanel({ model: 'elevenlabs-v3' });
    fireEvent.click(screen.getByTestId('generate-audio-params-trigger'));
    fireEvent.click(screen.getByTestId('generate-audio-stability-stop-1'));

    await waitFor(() => {
      const node = readCanvasGraph('p', 's').nodes.find((n) => n.id === 'target');
      const record = (node?.data as { paramsByModel?: Record<string, Record<string, unknown>> })
        .paramsByModel?.['elevenlabs-v3'];
      expect(record?.stability).toBe(1);
    });
  });
});

describe('AudioGeneratePanelContainer — what the trigger says', () => {
  it('names the stored voice, rather than leaving its raw id on the trigger', async () => {
    // The record holds an id; the trigger shows a name. The two must differ
    // here, or the trigger's own id fallback satisfies the assertion and the
    // wiring under test could be severed without a word.
    getVoice.mockResolvedValue({ id: '21m00Tcm4Tlv', name: 'Rachel' });
    await openPanel({
      model: 'elevenlabs-v3',
      paramsByModel: { 'elevenlabs-v3': { voice_id: '21m00Tcm4Tlv' } },
    });

    await waitFor(() => {
      expect(screen.getByTestId('generate-voice-trigger').textContent).toContain(
        'Rachel',
      );
    });
    expect(getVoice).toHaveBeenCalledWith('elevenlabs-v3', '21m00Tcm4Tlv');
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
    // The sentence, not just that one appeared: both refusals a click can
    // reach warn, so "a toast fired" would survive the container naming the
    // prompt one here.
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Choose a voice', expect.anything()),
    );
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

  it('spins and greys the button while the submit is out', async () => {
    // The container's own render-time gate call: severing it leaves the button
    // live and arrow-shaped through the whole POST, so a second click lands on
    // a latch that drops it without a word.
    let settle: (() => void) | undefined;
    vi.spyOn(canvasApi, 'createTask').mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({} as never);
        }),
    );
    await openPanel({
      model: 'elevenlabs-v3',
      paramsByModel: { 'elevenlabs-v3': { voice_id: 'Aria' } },
    });
    typePrompt('Good evening.');
    fireEvent.click(screen.getByTestId('generate-audio-execute'));

    await screen.findByTestId('generate-audio-execute-pending');
    expect(screen.getByTestId('generate-audio-execute')).toBeDisabled();

    settle?.();
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

describe('AudioGeneratePanelContainer — a mode switch that takes the slot away', () => {
  it('ends the running pick and says so', async () => {
    // The slot list comes from the mode, and a collaborator can write the
    // mode. Without the message the canvas simply stops dimming candidates
    // mid-pick and nothing says why.
    const view = await openPanel({ mode: 'voice_clone', model: 'qwen3-tts-voice-clone' });
    fireEvent.click(await screen.findByTestId('generate-audio-tool-ref-audio'));
    expect(useCanvasStore.getState().pickSession?.purpose).toBe('refAudio');
    vi.mocked(toast.warning).mockClear();

    const moved = { mode: 'tts', model: 'elevenlabs-v3' };
    seedAudioNode(moved);
    view.rerender(panelTree(moved));

    await waitFor(() => expect(useCanvasStore.getState().pickSession).toBeNull());
    expect(vi.mocked(toast.warning).mock.calls.at(-1)?.[0]).toBe(
      en.canvas.generatePanel.pickEnded,
    );
  });

  it('names the collaborator when the mode change was theirs', async () => {
    // Same ending, other author. Only the first wording was pinned before
    // this case, so the call site could have passed a constant and stayed
    // green.
    const byPeer = (): boolean => false;
    const view = await openPanel(
      { mode: 'voice_clone', model: 'qwen3-tts-voice-clone' },
      byPeer,
    );
    fireEvent.click(await screen.findByTestId('generate-audio-tool-ref-audio'));
    expect(useCanvasStore.getState().pickSession?.purpose).toBe('refAudio');
    vi.mocked(toast.warning).mockClear();

    const moved = { mode: 'tts', model: 'elevenlabs-v3' };
    seedAudioNode(moved);
    view.rerender(panelTree(moved, undefined, byPeer));

    await waitFor(() => expect(useCanvasStore.getState().pickSession).toBeNull());
    expect(vi.mocked(toast.warning).mock.calls.at(-1)?.[0]).toBe(
      en.canvas.generatePanel.pickEndedByPeer,
    );
  });
});

/**
 * The two music modes (#1960).
 *
 * The surface they add is a second editor: a style brief above, the words to
 * sing below. Both boxes are live views of their own Yjs fragment, which is
 * why the container owns them and the panel takes them as slots.
 *
 * Measured against the WaveSpeed gateway on 2026-09-05: both models refuse a
 * run without lyrics — music-3.0 unless the track is marked instrumental,
 * music-01 unconditionally, since it declares no such switch.
 */
describe('AudioGeneratePanelContainer — the music modes', () => {
  it('opens a second box for the words to sing', async () => {
    await openPanel({ mode: 't2m', model: 'minimax-music-3.0' });
    expect(screen.getByTestId('generate-prompt-editor')).toBeInTheDocument();
    expect(screen.getByTestId('generate-lyrics-editor')).toBeInTheDocument();
  });

  it('opens one box on a mode that collects no lyrics', async () => {
    await openPanel({ mode: 'sfx', model: 'sonilo-sfx-v1' });
    expect(screen.queryByTestId('generate-lyrics-editor')).toBeNull();
  });

  it('refuses text to music while the lyrics box is empty, and says which', async () => {
    const create = vi.spyOn(canvasApi, 'createTask').mockResolvedValue({} as never);
    await openPanel({ mode: 't2m', model: 'minimax-music-3.0' });
    typePrompt('warm indie folk, 90 BPM');
    fireEvent.click(screen.getByTestId('generate-audio-execute'));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Write the lyrics first',
        expect.anything(),
      ),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses reference to music on the same empty box', async () => {
    // It has no instrumental switch, so nothing lifts the requirement here.
    const create = vi.spyOn(canvasApi, 'createTask').mockResolvedValue({} as never);
    await openPanel({
      mode: 'a2m',
      model: 'minimax-music-01',
      musicSong: { url: 'https://x/y.mp3' },
    });
    typePrompt('same mood, slower');
    fireEvent.click(screen.getByTestId('generate-audio-execute'));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Write the lyrics first',
        expect.anything(),
      ),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the style and the words as two separate fields', async () => {
    const create = vi.spyOn(canvasApi, 'createTask').mockResolvedValue({} as never);
    await openPanel({ mode: 't2m', model: 'minimax-music-3.0' });
    typePrompt('warm indie folk, 90 BPM');
    typeLyrics('[Verse]', 'morning light');
    fireEvent.click(screen.getByTestId('generate-audio-execute'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0]?.[0];
    expect(payload?.task_type).toBe('audio');
    expect(payload?.model).toBe('minimax-music-3.0');
    expect(payload?.params.prompt).toBe('warm indie folk, 90 BPM');
    // One newline per line the user pressed Enter on. The style box keeps
    // the prompt default (a blank line between blocks); lyrics are the field
    // whose line structure IS the content.
    expect(payload?.params.lyrics).toBe('[Verse]\nmorning light');
  });

  it('carries a picked reference under the name its vendor reads', async () => {
    const create = vi.spyOn(canvasApi, 'createTask').mockResolvedValue({} as never);
    await openPanel({
      mode: 'a2m',
      model: 'minimax-music-01',
      musicSong: { url: 'https://x/y.mp3' },
    });
    typePrompt('same mood, slower');
    typeLyrics('la la la');
    fireEvent.click(screen.getByTestId('generate-audio-execute'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]?.params.song).toBe('https://x/y.mp3');
  });

  // The switch and the box are one statement: with no vocals there are no
  // words to write, so the box says so by going read-only rather than sitting
  // there taking typing the run will not use. What is already in it stays —
  // turning the switch back off must return the user's own lyrics.
  it('locks the lyrics box while the track is marked instrumental', async () => {
    await openPanel({
      mode: 't2m',
      model: 'minimax-music-3.0',
      paramsByModel: { 'minimax-music-3.0': { is_instrumental: true } },
    });
    typeLyrics('morning light');
    const box = await screen.findByTestId('generate-lyrics-editor');
    await waitFor(() =>
      expect(box.querySelector('.ProseMirror')).toHaveAttribute(
        'contenteditable',
        'false',
      ),
    );
    expect(box.textContent).toContain('morning light');
  });

  // The extension hides its placeholder on a read-only editor by default,
  // which would leave a dimmed box with nothing in it at all — no words, no
  // prompt, nothing saying what it is for.
  it('keeps the lyrics box saying what it asks for while it is locked', async () => {
    await openPanel({
      mode: 't2m',
      model: 'minimax-music-3.0',
      paramsByModel: { 'minimax-music-3.0': { is_instrumental: true } },
    });
    const box = await screen.findByTestId('generate-lyrics-editor');
    await waitFor(() =>
      expect(box.querySelector('.ProseMirror')).toHaveAttribute(
        'contenteditable',
        'false',
      ),
    );
    expect(box.querySelector('[data-placeholder]')).toHaveAttribute(
      'data-placeholder',
      'Write the lyrics',
    );
  });

  it('leaves it writable while the track has vocals', async () => {
    await openPanel({ mode: 't2m', model: 'minimax-music-3.0' });
    const box = await screen.findByTestId('generate-lyrics-editor');
    await waitFor(() =>
      expect(box.querySelector('.ProseMirror')).toHaveAttribute(
        'contenteditable',
        'true',
      ),
    );
  });

  // The box says those words are not used and refuses typing; the request has
  // to say the same. Measured 2026-09-05, `is_instrumental: true` with an
  // empty `lyrics` is accepted and completes — that combination is the one
  // this sends. The words stay on the node, so turning the switch back off
  // returns them.
  it('sends no words for a track the user marked vocal-free', async () => {
    const create = vi.spyOn(canvasApi, 'createTask').mockResolvedValue({} as never);
    await openPanel({
      mode: 't2m',
      model: 'minimax-music-3.0',
      paramsByModel: { 'minimax-music-3.0': { is_instrumental: true } },
    });
    typePrompt('rain on a tin roof');
    typeLyrics('morning light');
    fireEvent.click(screen.getByTestId('generate-audio-execute'));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]?.params.lyrics).toBe('');
    // Still on the node: the fragment is untouched.
    expect(getLyricsFragment('p', 's', 'target')?.toString()).toContain(
      'morning light',
    );
  });

  it('runs an instrumental track with the lyrics box empty', async () => {
    const create = vi.spyOn(canvasApi, 'createTask').mockResolvedValue({} as never);
    await openPanel({
      mode: 't2m',
      model: 'minimax-music-3.0',
      paramsByModel: { 'minimax-music-3.0': { is_instrumental: true } },
    });
    typePrompt('rain on a tin roof');
    fireEvent.click(screen.getByTestId('generate-audio-execute'));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]?.params.is_instrumental).toBe(true);
  });
});
