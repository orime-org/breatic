// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import type { ReactNode } from 'react';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Pass through the tooltip primitives: real Radix Tooltip throws without the
// app-level TooltipProvider (App.tsx mounts it); tooltip behavior is pinned
// in GenerateToolbar.test — not this file's concern.
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: ReactNode }) => children,
}));

// The container acquires the canvas-space doc's shared provider for the
// collaborator-caret awareness channel (batch-2 item 14) — mocked so the
// component test never opens a real WebSocket. Provider null = the caret
// extension simply doesn't mount (its pre-connect state).
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

import { GeneratePanelContainer } from '@web/spaces/canvas/generate/GeneratePanelContainer';
import { useSocket } from '@web/data/yjs/use-socket';
import { docName } from '@web/data/yjs/manager';
import { modelsApi } from '@web/data/api';
import { useCanvasStore } from '@web/stores';

/**
 * Mounts the container under a fresh QueryClient (no retries — the failure
 * path resolves in one round trip).
 * @returns The render result.
 */
function mountContainer(): ReturnType<typeof render> {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {/* A REAL ReactFlow with the target node: GeneratePanelBody mounts
          inside a NodeToolbar, which renders its children only when the node
          exists in ReactFlow's store — a bare provider never mounts the
          body (caught wiring the caret-awareness test). */}
      <ReactFlow
        nodes={[
          { id: 'target', position: { x: 0, y: 0 }, data: {} },
        ]}
        edges={[]}
      >
        <GeneratePanelContainer
          projectId='p'
          spaceId='s'
          nodes={[
            {
              id: 'target',
              data: { kind: 'image', status: 'idle' },
            },
          ]}
          edges={[]}
        />
      </ReactFlow>
    </QueryClientProvider>,
  );
}

// Model-catalog failure gate (spec §9.3, user-ratified): a failed catalog
// fetch must EXPLAIN itself (toast) and not open the Generate panel — the old
// behavior silently rendered a dead panel (blank model pill, hidden ratio
// picker, permanently disabled execute) with zero feedback.
describe('GeneratePanelContainer — catalog failure gate', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    useCanvasStore.setState({
      generatePanelNodeId: null,
      pickSession: null,
    });
  });

  it('on catalog fetch failure: toasts, closes the panel intent, renders nothing', async () => {
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockRejectedValue(new Error('boom'));
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target');
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
    expect(useCanvasStore.getState().generatePanelNodeId).toBeNull();
    expect(
      screen.queryByTestId('generate-prompt-editor'),
    ).not.toBeInTheDocument();
    listSpy.mockRestore();
  });

  // Collaborator carets (batch-2 item 14): the prompt fragment lives in the
  // CANVAS-SPACE doc, so the caret awareness channel must be that exact
  // doc's shared provider — acquiring any other doc name would publish carets
  // into the wrong awareness (or open a second socket).
  it('acquires the canvas-space doc provider for the caret awareness channel', async () => {
    const listSpy = vi.spyOn(modelsApi, 'list').mockResolvedValue({
      image: [],
      video: [],
      audio: [],
      tts: [],
      three_d: [],
      understand: [],
      total: 0,
    });
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target');
    });
    await waitFor(() => {
      expect(vi.mocked(useSocket)).toHaveBeenCalled();
    });
    const call = vi.mocked(useSocket).mock.calls.at(-1)?.[0];
    expect(call?.name).toBe(docName.canvasSpace('p', 's'));
    listSpy.mockRestore();
  });

  // Pick ends on a t2i switch (adversarial round-2): t2i ignores references
  // and disables the reference button, so a pick left running after the mode
  // flips to t2i is a zombie session (its Exit trigger disabled = the stranded
  // focus). vm.mode drives it, so a collaborator's setNodeMode ends it too.
  it('ends a running reference pick when the node mode becomes t2i', async () => {
    const emptyCatalog = {
      image: [],
      video: [],
      audio: [],
      tts: [],
      three_d: [],
      understand: [],
      total: 0,
    };
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockResolvedValue(emptyCatalog);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    /**
     * Renders the container with the target node in the given mode.
     * @param mode - The node's generation sub-mode.
     * @returns The render tree.
     */
    const tree = (mode: 'i2i' | 't2i'): React.JSX.Element => (
      <QueryClientProvider client={client}>
        <ReactFlow
          nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
          edges={[]}
        >
          <GeneratePanelContainer
            projectId='p'
            spaceId='s'
            nodes={[{ id: 'target', data: { kind: 'image', status: 'idle', mode } }]}
            edges={[]}
          />
        </ReactFlow>
      </QueryClientProvider>
    );
    const { rerender } = render(tree('i2i'));
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target');
      useCanvasStore.getState().startReferencePick('target');
    });
    await waitFor(() =>
      expect(useCanvasStore.getState().pickSession?.nodeId).toBe('target'),
    );
    // Mode flips to t2i (local toggle or a collaborator's setNodeMode).
    rerender(tree('t2i'));
    await waitFor(() =>
      expect(useCanvasStore.getState().pickSession).toBeNull(),
    );
    listSpy.mockRestore();
  });

  // Same zombie guard for the STYLE pick (adversarial 2026-07-16): a model
  // switch to one WITHOUT style capability disables the Style trigger, so a
  // running style pick would strand its banner + focus exactly like the t2i
  // reference case. vm.styleSupported drives it, so a collaborator's
  // setNodeModel ends it too.
  it('ends a running style pick when the model loses style capability', async () => {
    /**
     * Builds a minimal catalog image model.
     * @param name - Model id.
     * @param withStyle - Whether the model declares the style_images param.
     * @returns A catalog ModelEntry.
     */
    const model = (name: string, withStyle: boolean): Record<string, unknown> => ({
      name,
      display_name: name,
      modality: 'image',
      mode: 't2i',
      description: '',
      guide: '',
      tier: 'optional',
      cost_per_call: 5,
      generation_time: 10,
      params: {
        aspect_ratio: { description: '', values: ['1:1'], default: '1:1' },
        ...(withStyle
          ? { style_images: { description: '', type: 'list', max_items: 1, default: null } }
          : {}),
      },
      providers: [],
      sourcesByMode: { t2i: [] },
    });
    const listSpy = vi.spyOn(modelsApi, 'list').mockResolvedValue({
      image: [
        model('styled', true),
        model('plain', false),
      ] as unknown as Awaited<ReturnType<typeof modelsApi.list>>['image'],
      video: [],
      audio: [],
      tts: [],
      three_d: [],
      understand: [],
      total: 2,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    /**
     * Renders the container with the target node storing the given model.
     * @param storedModel - The node's stored model id.
     * @returns The render tree.
     */
    const tree = (storedModel: string): React.JSX.Element => (
      <QueryClientProvider client={client}>
        <ReactFlow
          nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
          edges={[]}
        >
          <GeneratePanelContainer
            projectId='p'
            spaceId='s'
            nodes={[
              {
                id: 'target',
                data: { kind: 'image', status: 'idle', model: storedModel },
              },
            ]}
            edges={[]}
          />
        </ReactFlow>
      </QueryClientProvider>
    );
    const { rerender } = render(tree('styled'));
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target');
    });
    // Wait for the catalog to resolve (Style button enabled = capability read).
    await waitFor(() =>
      expect(
        screen.getByTestId('generate-tool-style').hasAttribute('disabled'),
      ).toBe(false),
    );
    act(() => {
      useCanvasStore.getState().startStylePick('target');
    });
    expect(useCanvasStore.getState().pickSession?.purpose).toBe('style');
    // The model flips to one without style capability (local pick or a
    // collaborator's setNodeModel).
    rerender(tree('plain'));
    await waitFor(() =>
      expect(useCanvasStore.getState().pickSession).toBeNull(),
    );
    listSpy.mockRestore();
  });
});
