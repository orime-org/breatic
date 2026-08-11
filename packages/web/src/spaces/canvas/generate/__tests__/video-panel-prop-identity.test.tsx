// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The container's props for its memoized children keep their identity while
 * their content is unchanged.
 *
 * `VideoGeneratePanel` and `VideoGenerateToolbar` are both `React.memo`, and
 * the view model behind them rebuilds on every canvas mutation — every frame
 * of any node drag. A prop rebuilt with it defeats both memos, which is the
 * same as not having them — the image panel shipped exactly that and had to be
 * repaired. Here the first-frame URL travelled as a string and bailed on its
 * own until #1904 collected the slots into one object, which is a fresh object
 * per render; this case is what keeps the container stabilising it.
 *
 * Asserted on the object the container hands down rather than on a render
 * count: a render count would also go up for an unrelated reason and pass for
 * the wrong reason, while identity is exactly what `React.memo` compares.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import type { ModelCatalog } from '@breatic/shared';
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
    status: 'connecting',
    authFailedReason: null,
  })),
}));

/** Every `slotUrls` object the panel has been handed, newest last. */
const seenSlotUrls: unknown[] = [];

// The real panel renders a tree this case has no use for; standing in for it
// is what lets the case read the prop object itself, which is the thing under
// test. It is NOT wrapped in React.memo on purpose — a memo here would hide
// the very re-render the case is measuring.
vi.mock('@web/spaces/canvas/generate/VideoGeneratePanel', () => ({
  VideoGeneratePanel: (props: { slotUrls: unknown }): null => {
    seenSlotUrls.push(props.slotUrls);
    return null;
  },
}));

import { VideoGeneratePanelContainer } from '@web/spaces/canvas/generate/VideoGeneratePanelContainer';
import { addNode } from '@web/data/yjs/canvas-space';
import { _resetForTests } from '@web/data/yjs/manager';
import {
  CanvasContext,
  type CanvasContextValue,
} from '@web/spaces/canvas/canvas-context';
import { modelsApi } from '@web/data/api';
import { useCanvasStore } from '@web/stores';

const CANVAS: CanvasContextValue = {
  projectId: 'p',
  spaceId: 's',
  readOnly: false,
  caretProvider: null,
};

/**
 * An empty catalog — the panel still mounts and still gets its slot props,
 * and no model has to be resolved for the identity question.
 * @returns A catalog with no models.
 */
function catalog(): ModelCatalog {
  return {
    image: [],
    video: [],
    audio: [],
    tts: [],
    three_d: [],
    understand: [],
    total: 0,
  };
}

/**
 * The container's node list, freshly built each call.
 *
 * A new array every time is what the canvas really hands down — ReactFlow
 * rebuilds it on every board mutation — so this is the input that must not
 * reach the memoized children as a new slot object.
 * @returns One video node carrying both slots filled.
 */
function nodes(): Parameters<
  typeof VideoGeneratePanelContainer
>[0]['nodes'] {
  return [
    {
      id: 'target',
      data: {
        kind: 'video',
        status: 'idle',
        firstFrameUrl: 'https://cdn/first.png',
        endFrameUrl: 'https://cdn/end.png',
      },
    },
    { id: 'other', data: { kind: 'video', status: 'idle' } },
  ] as Parameters<typeof VideoGeneratePanelContainer>[0]['nodes'];
}

/**
 * Mounts the container around one video node with both slots filled.
 * @returns The render result, so the case can force a re-render.
 */
function mount(): ReturnType<typeof render> {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ReactFlow
        nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
        edges={[]}
      >
        <CanvasContext.Provider value={CANVAS}>
          <VideoGeneratePanelContainer
            projectId='p'
            spaceId='s'
            edges={[]}
            nodes={nodes()}
          />
        </CanvasContext.Provider>
      </ReactFlow>
    </QueryClientProvider>,
  );
}

describe('the container keeps its memoized children bail-able', () => {
  beforeEach(() => {
    seenSlotUrls.length = 0;
    _resetForTests();
    useCanvasStore.setState({
      panelHostId: null,
      panelKind: null,
      pickSession: null,
    });
    addNode('p', 's', {
      id: 'target',
      type: 'video',
      position: { x: 0, y: 0 },
      data: {
        name: 'V',
        createdAt: 1000,
        createdBy: 'u1',
        locked: false,
        state: 'idle',
        attachments: [],
        mode: 'first_last',
        firstFrameUrl: 'https://cdn/first.png',
        endFrameUrl: 'https://cdn/end.png',
      },
    } as Parameters<typeof addNode>[2]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands down the SAME slotUrls object while the picked URLs are unchanged', async () => {
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    const { rerender } = mount();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'video');
    });
    await waitFor(() => {
      expect(seenSlotUrls.length).toBeGreaterThan(0);
    });
    const before = seenSlotUrls.at(-1);
    // Counted HERE, not from mount: by now the panel has already rendered
    // more than once (mount, then the catalog query settling), so an absolute
    // `length > 1` below would be satisfied before the rerender it is meant to
    // witness — and the case would pass while comparing one render against
    // itself, which `Object.is` says are the same however unstable the prop is.
    const rendersBefore = seenSlotUrls.length;

    // What a board mutation looks like from here: a brand-new nodes array
    // carrying identical slot URLs.
    rerender(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ReactFlow
          nodes={[{ id: 'target', position: { x: 1, y: 1 }, data: {} }]}
          edges={[]}
        >
          <CanvasContext.Provider value={CANVAS}>
            <VideoGeneratePanelContainer
              projectId='p'
              spaceId='s'
              edges={[]}
              nodes={nodes()}
            />
          </CanvasContext.Provider>
        </ReactFlow>
      </QueryClientProvider>,
    );

    const after = seenSlotUrls.at(-1);
    expect(seenSlotUrls.length).toBeGreaterThan(rendersBefore);
    expect(Object.is(before, after)).toBe(true);
  });

  it('hands down a DIFFERENT slotUrls object once a slot really changes', async () => {
    // The other half of the invariant: a memo that never re-renders is just as
    // broken as one that always does. Without this the fix could be a frozen
    // constant and the first case would still pass.
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    const { rerender } = mount();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'video');
    });
    await waitFor(() => {
      expect(seenSlotUrls.length).toBeGreaterThan(0);
    });
    const before = seenSlotUrls.at(-1);

    rerender(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ReactFlow
          nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
          edges={[]}
        >
          <CanvasContext.Provider value={CANVAS}>
            <VideoGeneratePanelContainer
              projectId='p'
              spaceId='s'
              edges={[]}
              nodes={
                [
                  {
                    id: 'target',
                    data: {
                      kind: 'video',
                      status: 'idle',
                      firstFrameUrl: 'https://cdn/first.png',
                      endFrameUrl: 'https://cdn/OTHER.png',
                    },
                  },
                  { id: 'other', data: { kind: 'video', status: 'idle' } },
                ] as Parameters<
                  typeof VideoGeneratePanelContainer
                >[0]['nodes']
              }
            />
          </CanvasContext.Provider>
        </ReactFlow>
      </QueryClientProvider>,
    );

    const after = seenSlotUrls.at(-1);
    expect(Object.is(before, after)).toBe(false);
    expect(after).toEqual({
      firstFrame: 'https://cdn/first.png',
      endFrame: 'https://cdn/OTHER.png',
    });
  });
});
