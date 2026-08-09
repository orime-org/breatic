// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import type { ModelCatalog, ModelEntry } from '@breatic/shared';
import type { ReactNode } from 'react';

vi.mock('sonner', () => ({
  // `warning` is the node gate's outlet (a locked or mid-generation node),
  // so it has to be stubbed alongside the failure and success channels.
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
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

import * as Y from 'yjs';
import { toast } from 'sonner';

import { VideoGeneratePanelContainer } from '@web/spaces/canvas/generate/VideoGeneratePanelContainer';
import { addNode, getPromptFragment } from '@web/data/yjs/canvas-space';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { canvasApi } from '@web/data/api/canvas';

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

/**
 * Seeds a real video node in the canvas-space doc so the panel gets a prompt
 * fragment and the collaborative editor actually mounts. Without this the
 * container renders no editor, the prompt stays empty and execute is
 * unreachable — which is exactly how the submit path went untested.
 * @param over - Node data overrides (e.g. `locked`).
 */
function seedVideoNode(over: Record<string, unknown> = {}): void {
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
      // A non-zero lease so the gen fence assertion can tell a real read from
      // a hardcoded 0 — with an absent lease both produce gen 1 and the
      // assertion proves nothing.
      leaseGen: 3,
      ...over,
    },
  } as Parameters<typeof addNode>[2]);
}

/**
 * Writes a prompt into the seeded node's fragment. The editor is bound to it,
 * so this is what a collaborator typing would produce.
 * @param text - The prompt body.
 */
function typePrompt(text: string): void {
  const fragment = getPromptFragment('p', 's', 'target');
  if (!fragment) throw new Error('seedVideoNode must run first');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(0, [paragraph]);
}

describe('VideoGeneratePanelContainer', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
    _resetForTests();
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

  it('explains itself on a node that predates prompt containers', async () => {
    // Video nodes made before this feature shipped carry no prompt container,
    // and #1880 ratified that they are not repaired — creating one on open is
    // the very race that decision removed. So the panel opens without an
    // editor and a dead arrow; without a line saying why, that reads as the
    // feature being broken.
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
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
      },
    } as Parameters<typeof addNode>[2]);
    // Strip the container the way a pre-#1880 node has it: absent entirely.
    const doc = getDoc(docName.canvasSpace('p', 's'));
    const node = doc.getMap<Y.Map<unknown>>('nodesMap').get('target');
    (node?.get('data') as Y.Map<unknown>).delete('prompt');

    mountContainer('video');
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'video');
    });
    const notice = await screen.findByTestId('generate-video-no-prompt');
    expect(notice).toBeVisible();
    expect(screen.queryByTestId('generate-prompt-editor')).toBeNull();
    expect(screen.getByTestId('generate-video-execute')).toBeDisabled();
  });

  describe('submit', () => {
    /**
     * Opens the panel on a seeded node with a prompt already in it and waits
     * for the submit arrow to become live.
     * @returns The submit button.
     */
    async function openReadyPanel(): Promise<HTMLElement> {
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      seedVideoNode();
      typePrompt('a drone shot over a canyon at dawn');
      mountContainer('video');
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      const execute = await screen.findByTestId('generate-video-execute');
      await waitFor(() => expect(execute).not.toBeDisabled());
      return execute;
    }

    it('sends a VIDEO task carrying the model, params, prompt and gen fence', async () => {
      // The one path the whole panel exists to reach. Every field here is one
      // a mutation could quietly change with no other test noticing: the task
      // type routes to the worker pipeline, duration must stay a number, and
      // the gen fence is what stops a stale panel overwriting a newer result.
      const create = vi
        .spyOn(canvasApi, 'createTask')
        .mockResolvedValue({ id: 't1' } as Awaited<
          ReturnType<typeof canvasApi.createTask>
        >);
      const execute = await openReadyPanel();
      fireEvent.click(execute);
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const payload = create.mock.calls[0]![0];
      expect(payload.task_type).toBe('video');
      expect(payload.model).toBe('veo-3.1');
      expect(payload.params.prompt).toBe('a drone shot over a canyon at dawn');
      expect(payload.params.duration).toBe(8);
      expect(typeof payload.params.duration).toBe('number');
      expect(payload.target_node_id).toBe('target');
      expect(payload.mode).toBe('overwrite');
      expect(payload.node_gens).toEqual({ target: 4 });
    });

    it('closes the panel once the task is accepted', async () => {
      vi.spyOn(canvasApi, 'createTask').mockResolvedValue({ id: 't1' } as Awaited<
        ReturnType<typeof canvasApi.createTask>
      >);
      const execute = await openReadyPanel();
      fireEvent.click(execute);
      await waitFor(() =>
        expect(useCanvasStore.getState().panelHostId).toBeNull(),
      );
    });

    it('submits once however fast the arrow is double-clicked', async () => {
      // The button's disabled state lags a frame behind the click, so the
      // latch has to be a synchronous ref. A second task here means the user
      // is charged twice for one generation.
      type Task = Awaited<ReturnType<typeof canvasApi.createTask>>;
      let release: (task: Task) => void = () => {};
      const create = vi
        .spyOn(canvasApi, 'createTask')
        .mockImplementation(
          () =>
            new Promise<Task>((resolve) => {
              release = resolve;
            }),
        );
      const execute = await openReadyPanel();
      // Both clicks in ONE act batch: React flushes state at the end of a
      // batch, so `isSubmitting` has not disabled the button yet when the
      // second click lands. That is the real race — dispatching them
      // separately lets React grey the button in between and the handler is
      // never re-entered, so the latch would look covered while being absent.
      act(() => {
        execute.click();
        execute.click();
        execute.click();
      });
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create).toHaveBeenCalledTimes(1);
      await act(async () => {
        release({ id: 't1' } as Task);
      });
    });

    it('refuses to submit against a locked node and says why', async () => {
      // The button stays clickable on a locked node on purpose: a greyed
      // control explains nothing. The gate blocks the submit and toasts the
      // reason instead.
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const create = vi.spyOn(canvasApi, 'createTask');
      seedVideoNode({ locked: true });
      typePrompt('a drone shot over a canyon at dawn');
      mountContainer('video');
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      const execute = await screen.findByTestId('generate-video-execute');
      await waitFor(() => expect(execute).not.toBeDisabled());
      fireEvent.click(execute);
      await waitFor(() => expect(toast.warning).toHaveBeenCalled());
      expect(create).not.toHaveBeenCalled();
      expect(useCanvasStore.getState().panelHostId).toBe('target');
    });

    it('explains a rejected submit and lets the user try again', async () => {
      // A refused task (no credits, node already busy, upstream down) must
      // both say so and release the latch — otherwise the arrow stays dead
      // for the rest of the panel's life.
      const create = vi
        .spyOn(canvasApi, 'createTask')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ id: 't1' } as Awaited<
          ReturnType<typeof canvasApi.createTask>
        >);
      const execute = await openReadyPanel();
      fireEvent.click(execute);
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      expect(useCanvasStore.getState().panelHostId).toBe('target');
      await waitFor(() => expect(execute).not.toBeDisabled());
      fireEvent.click(execute);
      await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    });
  });
});
