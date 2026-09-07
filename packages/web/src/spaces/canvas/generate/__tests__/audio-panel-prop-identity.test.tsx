// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The audio container's props for its memoized children keep their identity
 * while their content is unchanged.
 *
 * `AudioGeneratePanel` is `React.memo`, and the view model behind it rebuilds
 * on every canvas mutation — every frame of any node drag. A prop rebuilt with
 * it defeats the memo, which is the same as not having one. The image panel
 * shipped exactly that and had to be repaired; the video one carries the same
 * case for its slot objects.
 *
 * Asserted on the object the container hands down rather than on a render
 * count: a count would also rise for unrelated reasons and pass for the wrong
 * reason, while identity is exactly what `React.memo` compares.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import type { ModelCatalog, ModelEntry } from '@breatic/shared';
import type { ReactNode } from 'react';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({
    provider: null,
    synced: false,
    status: 'connecting' as const,
    authFailedReason: null,
  })),
}));

vi.mock('@web/data/api/voices', () => ({
  voicesApi: {
    list: () => Promise.resolve({ voices: [], hasMore: false }),
    get: () => Promise.resolve({ id: 'Aria', name: 'Aria' }),
  },
}));

/** Every `promptSlot` the panel has been handed, newest last. */
const seenPromptSlots: unknown[] = [];
/** Every `params` object the panel has been handed, newest last. */
const seenParams: unknown[] = [];
/** Every `references` array it has been handed, newest last. */
const seenReferences: unknown[] = [];

// Standing in for the real panel is what lets the case read the prop objects
// themselves. Deliberately NOT wrapped in React.memo: a memo here would hide
// the very re-render being measured.
vi.mock('@web/spaces/canvas/generate/AudioGeneratePanel', () => ({
  AudioGeneratePanel: (props: {
    params: unknown;
    references: unknown;
    promptSlot: unknown;
  }): null => {
    seenParams.push(props.params);
    seenReferences.push(props.references);
    seenPromptSlots.push(props.promptSlot);
    return null;
  },
}));

import { AudioGeneratePanelContainer } from '@web/spaces/canvas/generate/AudioGeneratePanelContainer';
import { addNode } from '@web/data/yjs/canvas-space';
import { _resetForTests } from '@web/data/yjs/manager';
import {
  CanvasContext,
  type CanvasContextValue,
} from '@web/spaces/canvas/canvas-context';
import { modelsApi } from '@web/data/api';
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


const CANVAS: CanvasContextValue = {
  projectId: 'p',
  spaceId: 's',
  readOnly: false,
  caretProvider: null,
};

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
  sourcesByMode: {},
};

/**
 * A catalog holding the one text-to-speech model this case needs.
 * @returns The catalog.
 */
function catalog(): ModelCatalog {
  return {
    image: [],
    video: [],
    audio: [],
    tts: [ELEVEN],
    three_d: [],
    understand: [],
    total: 1,
  };
}

/**
 * The container's node list, freshly built each call.
 *
 * A new array every time is what the canvas really hands down — ReactFlow
 * rebuilds it on every board mutation — so this is the input that must not
 * reach the memoized panel as a new params or references object.
 * @returns One audio node and one text node feeding it.
 */
function nodes(
  stability = 1,
): Parameters<typeof AudioGeneratePanelContainer>[0]['nodes'] {
  return [
    {
      id: 'target',
      data: {
        kind: 'audio',
        status: 'idle',
        model: 'elevenlabs-v3',
        paramsByModel: { 'elevenlabs-v3': { stability } },
      },
    },
    { id: 'src', data: { kind: 'text', status: 'idle', name: 'The script' } },
  ] as Parameters<typeof AudioGeneratePanelContainer>[0]['nodes'];
}

/**
 * The whole tree, so a case can re-render it with different node content.
 * @param stability - The stored param value the node carries.
 * @returns The element to render.
 */
function tree(stability = 1): React.ReactElement {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ReactFlow
        nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
        edges={[]}
        panOnDrag={false}
      >
        <CanvasContext.Provider value={CANVAS}>
          <AudioGeneratePanelContainer
            projectId='p'
            spaceId='s'
            edges={[{ id: 'e1', source: 'src', target: 'target' }]}
            nodes={nodes(stability)}
            getLastWriteWasLocal={returnsTrue}
          />
        </CanvasContext.Provider>
      </ReactFlow>
    </QueryClientProvider>
  );
}

/**
 * Mounts the container around that node, with one incoming text edge.
 * @returns The render result, so the case can force a re-render.
 */
function mount(): ReturnType<typeof render> {
  return render(tree());
}

describe('the audio container keeps its memoized panel bail-able', () => {
  beforeEach(() => {
    seenParams.length = 0;
    seenReferences.length = 0;
    seenPromptSlots.length = 0;
    _resetForTests();
    useCanvasStore.setState({
      panelHostId: null,
      panelKind: null,
      pickSession: null,
    });
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
        model: 'elevenlabs-v3',
        paramsByModel: { 'elevenlabs-v3': { stability: 1 } },
      },
    } as Parameters<typeof addNode>[2]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands down the prompt editor on the very first render', async () => {
    // A null promptSlot is how the panel is told the node has no prompt
    // container, and it then renders one sentence saying the node is too old.
    // Resolving the fragment after the first commit makes every modern node
    // paint that sentence first.
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    mount();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'audio');
    });
    await waitFor(() => {
      expect(seenPromptSlots.length).toBeGreaterThan(0);
    });
    expect(seenPromptSlots[0]).not.toBeNull();
  });

  it('hands down the SAME params and references while their content is unchanged', async () => {
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    const { rerender } = mount();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'audio');
    });
    await waitFor(() => {
      expect(seenParams.length).toBeGreaterThan(0);
    });
    const paramsBefore = seenParams.at(-1);
    const referencesBefore = seenReferences.at(-1);

    // What a node drag does: the same board, a new nodes array.
    rerender(tree());

    await waitFor(() => {
      expect(seenParams.length).toBeGreaterThan(1);
    });
    expect(seenParams.at(-1)).toBe(paramsBefore);
    expect(seenReferences.at(-1)).toBe(referencesBefore);
  });

  it('hands down a NEW params object once the content changes', async () => {
    // The other half of the identity contract: holding on when the content
    // moved would leave the picker showing a value the node no longer holds,
    // which is what a key frozen to a constant would do.
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    const { rerender } = mount();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'audio');
    });
    await waitFor(() => {
      expect(seenParams.length).toBeGreaterThan(0);
    });
    const before = seenParams.at(-1);

    // What the params picker's write looks like from up here: the canvas hands
    // down a node carrying a different stored value.
    rerender(tree(0));

    await waitFor(() => {
      expect(seenParams.at(-1)).not.toBe(before);
    });
    expect(seenParams.at(-1)).toEqual(expect.objectContaining({ stability: 0 }));
  });
});
