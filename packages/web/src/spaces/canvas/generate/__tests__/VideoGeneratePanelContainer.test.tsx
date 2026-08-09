// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import type { ModelCatalog, ModelEntry } from '@breatic/shared';
import type { ReactNode } from 'react';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Real Radix Tooltip throws without the app-level provider (App.tsx mounts
// it); tooltip behaviour is pinned in its own suite, not here.
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: ReactNode }) => children,
}));

// So the component test never opens a real WebSocket.
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(
    (): {
      provider: null;
      synced: boolean;
      status: 'connecting';
      authFailedReason: null;
    } => ({
      provider: null,
      synced: false,
      status: 'connecting',
      authFailedReason: null,
    }),
  ),
}));

import { toast } from 'sonner';

import { VideoGeneratePanelContainer } from '@web/spaces/canvas/generate/VideoGeneratePanelContainer';
import {
  CanvasContext,
  type CanvasContextValue,
} from '@web/spaces/canvas/canvas-context';
import { modelsApi } from '@web/data/api';
import { useCanvasStore } from '@web/stores';

/** A text-to-video model, the one kind this slice offers. */
const T2V: ModelEntry = {
  name: 'veo-3.1',
  display_name: 'VEO 3.1',
  modality: 'video',
  mode: 't2v',
  description: '',
  guide: '',
  tier: 'recommended',
  cost_per_call: 88,
  generation_time: 120,
  params: {
    aspect_ratio: { description: '', values: ['16:9'], default: '16:9' },
    duration: { description: '', values: [4, 8], default: 8 },
  },
  providers: [],
  sourcesByMode: { t2v: [] },
};

/** An image model, so "the video panel offers video models" is a real claim. */
const T2I: ModelEntry = {
  ...T2V,
  name: 'nano-banana',
  display_name: 'Nano Banana',
  modality: 'image',
  mode: 't2i',
  sourcesByMode: { t2i: [] },
};

/**
 * A catalog carrying both buckets.
 * @returns The catalog payload `modelsApi.list()` resolves to.
 */
function catalog(): ModelCatalog {
  return {
    image: [T2I],
    video: [T2V],
    audio: [],
    tts: [],
    three_d: [],
    understand: [],
    total: 2,
  };
}

/**
 * Mounts the container under a fresh QueryClient (no retries — the failure
 * path resolves in one round trip) inside a real ReactFlow carrying the node,
 * since the panel mounts inside a NodeToolbar which renders children only for
 * a node ReactFlow knows about.
 * @param kind - The node's modality.
 * @returns The render result.
 */
function mountContainer(kind: 'video' | 'image' = 'video'): ReturnType<
  typeof render
> {
  const canvas: CanvasContextValue = {
    projectId: 'p',
    spaceId: 's',
    readOnly: false,
    caretProvider: null,
  };
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
        <CanvasContext.Provider value={canvas}>
          <VideoGeneratePanelContainer
            projectId='p'
            spaceId='s'
            nodes={[{ id: 'target', data: { kind, status: 'idle' } }]}
          />
        </CanvasContext.Provider>
      </ReactFlow>
    </QueryClientProvider>,
  );
}

describe('VideoGeneratePanelContainer', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    useCanvasStore.setState({
      panelHostId: null,
      panelKind: null,
      pickSession: null,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens for a video node', async () => {
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    mountContainer('video');
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'video');
    });
    await waitFor(() => {
      expect(screen.getByTestId('generate-video-execute')).toBeInTheDocument();
    });
  });

  it('stays shut while the image panel is the one open', async () => {
    // The two panels share `panelHostId`; only the kind tells them apart, and
    // getting that wrong would put both on the same node at once.
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    mountContainer('image');
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    await waitFor(() => {
      expect(useCanvasStore.getState().panelKind).toBe('generate');
    });
    expect(screen.queryByTestId('generate-video-execute')).toBeNull();
  });

  it('offers the video models, not the image ones', async () => {
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    mountContainer('video');
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'video');
    });
    await waitFor(() => {
      expect(screen.getByTestId('generate-model-trigger')).toHaveTextContent(
        'VEO 3.1',
      );
    });
  });

  it('closes itself when the target node is deleted', async () => {
    // A collaborator deleting the node must not leave a panel anchored to
    // nothing.
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    const view = mountContainer('video');
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'video');
    });
    await waitFor(() => {
      expect(screen.getByTestId('generate-video-execute')).toBeInTheDocument();
    });
    view.rerender(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ReactFlow nodes={[]} edges={[]}>
          <CanvasContext.Provider
            value={{
              projectId: 'p',
              spaceId: 's',
              readOnly: false,
              caretProvider: null,
            }}
          >
            <VideoGeneratePanelContainer projectId='p' spaceId='s' nodes={[]} />
          </CanvasContext.Provider>
        </ReactFlow>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(useCanvasStore.getState().panelHostId).toBeNull();
    });
    expect(screen.queryByTestId('generate-video-execute')).toBeNull();
  });

  it('on catalog fetch failure: toasts, drops the panel intent, renders nothing', async () => {
    // A panel with no catalog is a dead end — blank model pill, no params,
    // execute permanently disabled — so it explains itself instead of opening.
    vi.spyOn(modelsApi, 'list').mockRejectedValue(new Error('boom'));
    mountContainer('video');
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'video');
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
    expect(useCanvasStore.getState().panelHostId).toBeNull();
    expect(screen.queryByTestId('generate-video-execute')).toBeNull();
  });
});
