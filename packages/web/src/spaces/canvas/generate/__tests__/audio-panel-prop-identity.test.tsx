// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The audio container hands its memoized panel the same slot list while the
 * slots it draws are unchanged.
 *
 * The view model behind the panel rebuilds on every canvas mutation — every
 * frame of any node drag — and the slots a song model draws depend on its
 * stored params (Mureka V9.5 Song's compose-from setting, breatic#1393). Read
 * off the params as rebuilt, the list is a fresh array per frame and the
 * panel's React.memo never bails. Asserted on the array handed down, as
 * `video-panel-prop-identity.test.tsx` does, because identity is what the memo
 * compares.
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

/** Every `slots` array the panel has been handed, newest last. */
const seenSlots: unknown[] = [];

// Not wrapped in React.memo: a memo here would hide the re-render measured.
vi.mock('@web/spaces/canvas/generate/AudioGeneratePanel', () => ({
  AudioGeneratePanel: (props: { slots: unknown }): null => {
    seenSlots.push(props.slots);
    return null;
  },
}));

import { AudioGeneratePanelContainer } from '@web/spaces/canvas/generate/AudioGeneratePanelContainer';
import { addNode } from '@web/data/yjs/canvas-space';
import { _resetForTests } from '@web/data/yjs/manager';
import { CanvasContext, type CanvasContextValue } from '@web/spaces/canvas/canvas-context';
import { modelsApi } from '@web/data/api';
import { canvasSessions } from '@web/stores/canvas-session';

const LAST_WRITE_LOCAL = (): boolean => true;

const CANVAS: CanvasContextValue = {
  projectId: 'p',
  spaceId: 's',
  readOnly: false,
  myRole: 'editor',
  caretProvider: null,
};

const MODEL = 'mureka-v9.5-generate-song';

/** A source place drawn on one side of the compose-from setting. */
const on = (side: string): ModelEntry['params'][string] => ({
  description: '',
  default: null,
  fill: 'canvas',
  accepts: 'audio',
  optional: true,
  modes: ['a2m'],
  when: { equals: { compose_from: side } },
});

/** Mureka V9.5 Song, as far as the slots it draws read it. */
const SONG: ModelEntry = {
  name: MODEL,
  display_name: 'Mureka V9.5 Song',
  modality: 'audio',
  mode: ['t2m', 'a2m'],
  description: '',
  guide: '',
  tier: 'recommended',
  generation_time: 300,
  takes_prompt: true,
  prompt_when: { equals: { compose_from: 'references' } },
  params: {
    compose_from: { description: '', label: 'Compose from', default: 'references', values: ['references', 'melody'], modes: ['a2m'], fill: 'panel' },
    lyrics: { description: '', default: null, fill: 'editor' },
    song: on('references'),
    melody: on('melody'),
    vocal: on('references'),
  },
  source_groups: [{ mode: 'a2m', any_of: ['song', 'vocal', 'melody'] }],
  providers: [],
};

/**
 * A catalog serving the song model alone.
 * @returns The catalog.
 */
function catalog(): ModelCatalog {
  return { image: [], video: [], audio: [SONG], tts: [], three_d: [], total: 1, credit_multiplier: 1 };
}

/**
 * The container's node list, freshly built each call, as the canvas hands it down.
 * @param composeFrom - The setting stored for the model.
 * @returns One audio node in Reference to Music.
 */
function nodes(composeFrom: string): Parameters<typeof AudioGeneratePanelContainer>[0]['nodes'] {
  return [
    {
      id: 'target',
      type: 'audio',
      data: { handling: false, mode: 'a2m', model: MODEL, paramsByModel: { [MODEL]: { compose_from: composeFrom } } },
    },
  ] as Parameters<typeof AudioGeneratePanelContainer>[0]['nodes'];
}

/**
 * The panel tree around one audio node.
 * @param composeFrom - The setting stored for the model.
 * @returns The element.
 */
function tree(composeFrom: string): React.ReactElement {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReactFlow nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]} edges={[]}>
        <CanvasContext.Provider value={CANVAS}>
          <AudioGeneratePanelContainer
            projectId='p'
            spaceId='s'
            edges={[]}
            nodes={nodes(composeFrom)}
            getLastWriteWasLocal={LAST_WRITE_LOCAL}
            placeTemplate={() => undefined}
          />
        </CanvasContext.Provider>
      </ReactFlow>
    </QueryClientProvider>
  );
}

describe('the audio container keeps its memoized panel bail-able', () => {
  beforeEach(() => {
    seenSlots.length = 0;
    _resetForTests();
    canvasSessions.of('s').setState({ panelHostId: null, panelKind: null, pickSession: null });
    addNode('p', 's', {
      id: 'target',
      type: 'audio',
      position: { x: 0, y: 0 },
      data: { name: 'A', createdAt: 1000, createdBy: 'u1', locked: false, attachments: [], mode: 'a2m', model: MODEL, paramsByModel: { [MODEL]: { compose_from: 'references' } } },
    } as Parameters<typeof addNode>[2]);
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Mounts the panel and waits for the catalog to land.
   * @returns The render result.
   */
  async function open(): Promise<ReturnType<typeof render>> {
    const view = render(tree('references'));
    act(() => {
      canvasSessions.of('s').getState().openGeneratePanel('target', 'audio');
    });
    await waitFor(() => expect(seenSlots.at(-1)).toEqual(['musicSong', 'musicVocal']));
    return view;
  }

  it('hands down the SAME slots array while the stored params are unchanged', async () => {
    const { rerender } = await open();
    const before = seenSlots.at(-1);
    const rendersBefore = seenSlots.length;

    // A board mutation: a brand-new nodes array carrying the same params.
    rerender(tree('references'));

    expect(seenSlots.length).toBeGreaterThan(rendersBefore);
    expect(Object.is(before, seenSlots.at(-1))).toBe(true);
  });

  it('hands down a DIFFERENT slots array once the setting really changes', async () => {
    const { rerender } = await open();
    const before = seenSlots.at(-1);

    rerender(tree('melody'));

    expect(Object.is(before, seenSlots.at(-1))).toBe(false);
    expect(seenSlots.at(-1)).toEqual(['musicMelody']);
  });
});
