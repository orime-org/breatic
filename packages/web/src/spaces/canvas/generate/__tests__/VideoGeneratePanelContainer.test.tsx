// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import {
  addEdge,
  addNode,
  getPromptFragment,
  readCanvasGraph,
  removeNode,
} from '@web/data/yjs/canvas-space';
import { _resetForTests } from '@web/data/yjs/manager';
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
    // Declared because every real video model declares it (kling, seedance,
    // veo and wan all do) — and since #1935 the panel reads this key to decide
    // whether to demand a prompt. A fixture without it would put these cases
    // in a state the catalog never ships.
    prompt: { description: '', default: null },
    aspect_ratio: { description: '', values: ['16:9'], default: '16:9' },
    duration: { description: '', values: [4, 8], default: 8 },
  },
  providers: [],
  sourcesByMode: { t2v: [] },
};

/** A second text-to-video model, so a stored pick can differ from the default. */
const T2V_LITE: ModelEntry = {
  ...T2V,
  name: 'veo-3.1-lite',
  display_name: 'VEO 3.1 Lite',
  cost_per_call: 21,
};

/**
 * An image-to-video model. Its `sourcesByMode` says the mode needs an image,
 * which is what turns on the first-frame slot and the execute-time gate.
 */
const I2V: ModelEntry = {
  ...T2V,
  name: 'kling-i2v',
  display_name: 'Kling I2V',
  // Both modes, as config/models/video/kling.yaml declares them since #1904:
  // the same model runs image-to-video and first-last frame.
  mode: ['i2v', 'first_last'],
  sourcesByMode: { i2v: ['image'], first_last: ['image'] },
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
 * A reference-to-video model (#1927). Its sources come from the reference
 * rail rather than a slot, and its `images` param states how many it takes.
 */
const REF: ModelEntry = {
  ...T2V,
  name: 'kling-o3-pro-ref',
  display_name: 'Kling O3 Pro Ref',
  mode: 'ref',
  sourcesByMode: { ref: ['image'] },
  params: {
    ...T2V.params,
    images: { description: '', type: 'list', max_items: 2, default: null },
  },
};

/**
 * A talking-head model (#1935), shaped like `omnihuman-1.5`: it takes a
 * portrait and an audio track, and declares no prompt and none of the four
 * params the toolbar's pill edits. Both absences are load-bearing here, so
 * the fixture states them by leaving `params` empty rather than spreading
 * `T2V.params`. The real entry also declares a seed, which neither decision
 * reads.
 */
const TALKING_HEAD: ModelEntry = {
  ...T2V,
  name: 'omnihuman-1.5',
  display_name: 'OmniHuman 1.5',
  mode: 'talking_head',
  sourcesByMode: { talking_head: ['image', 'audio'] },
  params: {},
};

/**
 * A second talking-head model that DOES declare a prompt.
 *
 * Nothing in the real catalog looks like this today — `talking_head` offers
 * one model and it declares none. The fixture exists because the criterion
 * under test is «ask the model, not the mode name» (§4.1): without a model
 * that answers differently from its mode, a mode-keyed implementation and a
 * model-keyed one are indistinguishable, and the test asserting the criterion
 * would pass on both.
 */
const TALKING_HEAD_WITH_PROMPT: ModelEntry = {
  ...TALKING_HEAD,
  name: 'omnihuman-scripted',
  display_name: 'OmniHuman Scripted',
  params: { prompt: { description: '', default: null } },
};

/**
 * A catalog carrying both buckets.
 * @returns The catalog payload `modelsApi.list()` resolves to.
 */
function catalog(): ModelCatalog {
  return {
    image: [T2I],
    video: [T2V, T2V_LITE, I2V, REF, TALKING_HEAD, TALKING_HEAD_WITH_PROMPT],
    audio: [],
    tts: [],
    three_d: [],
    understand: [],
    total: 7,
  };
}

/** Extra board nodes + edges a case needs (reference sources and their wires). */
interface BoardOverrides {
  /** Nodes to put on the board beside the target and `other`. */
  nodes?: ReadonlyArray<
    Parameters<typeof VideoGeneratePanelContainer>[0]['nodes'][number]
  >;
  /** Edges the container derives the reference rail from. */
  edges?: Parameters<typeof VideoGeneratePanelContainer>[0]['edges'];
}

/**
 * Mounts the container under a fresh QueryClient (no retries — the failure
 * path resolves in one round trip) inside a real ReactFlow carrying the node,
 * since the panel mounts inside a NodeToolbar which renders children only for
 * a node ReactFlow knows about.
 * @param kind - The node's modality.
 * @param reactNodeData - Extra data on the target's REACT view (which a case
 *   can deliberately let disagree with Yjs).
 * @param board - Extra reference-source nodes and the edges wiring them in.
 * @returns The element tree.
 */
function panelTree(
  kind: 'video' | 'image' = 'video',
  reactNodeData?: Record<string, unknown>,
  board: BoardOverrides = {},
): React.ReactElement {
  const canvas: CanvasContextValue = {
    projectId: 'p',
    spaceId: 's',
    readOnly: false,
    caretProvider: null,
  };
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {/* panOnDrag off: a pointer sequence anywhere in the panel bubbles to
          ReactFlow's d3-zoom, whose d3-drag reads `event.view.document` —
          null in jsdom, so a real click on any control throws an unhandled
          error. The canvas here exists only so NodeToolbar renders. */}
      <ReactFlow
        nodes={[{ id: 'target', position: { x: 0, y: 0 }, data: {} }]}
        edges={[]}
        panOnDrag={false}
      >
        <CanvasContext.Provider value={canvas}>
          <VideoGeneratePanelContainer
            projectId='p'
            spaceId='s'
            edges={board.edges ?? []}
            nodes={[
              {
                id: 'target',
                data: { kind, status: 'idle', ...reactNodeData } as Parameters<
                  typeof VideoGeneratePanelContainer
                >[0]['nodes'][number]['data'],
              },
              // A second node on the board, so a case that moves the panel
              // elsewhere does not trip the node-is-gone close first.
              { id: 'other', data: { kind: 'video', status: 'idle' } },
              ...(board.nodes ?? []),
            ]}
          />
        </CanvasContext.Provider>
      </ReactFlow>
    </QueryClientProvider>
  );
}

/**
 * Renders the panel tree. Split from {@link panelTree} so a case that needs the
 * node's data to change WITHOUT remounting (a mode switch is a data change, not
 * a remount) can rerender the same tree with different data.
 * @param kind - The target node's modality.
 * @param reactNodeData - Extra fields on the target node's view data.
 * @param board - Extra board nodes and edges.
 * @returns The render result, whose `rerender` takes another `panelTree`.
 */
function mountContainer(
  kind: 'video' | 'image' = 'video',
  reactNodeData?: Record<string, unknown>,
  board: BoardOverrides = {},
): ReturnType<typeof render> {
  return render(panelTree(kind, reactNodeData, board));
}

/**
 * Opens the panel on a node seeded with a mode and model, past the frame where
 * the catalog has not arrived.
 *
 * The mode goes into the node data rather than through the switch: the
 * container reads it off the `nodes` prop, and this harness passes a static
 * array — clicking the switch writes Yjs, the prop does not move, and the
 * rendered mode never changes.
 * @param mode - The generation sub-mode.
 * @param model - The model name to store on the node.
 * @param stored - Extra node fields (slot picks, and the like).
 * @param board - Extra board nodes and edges.
 * @returns The render result, for a case that switches mode by rerendering.
 */
async function openPanelInMode(
  mode: string,
  model: string,
  stored: Record<string, unknown> = {},
  board: BoardOverrides = {},
): Promise<ReturnType<typeof render>> {
  vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
  const data = { mode, model, ...stored };
  seedVideoNode(data);
  const view = mountContainer('video', data, board);
  act(() => {
    useCanvasStore.getState().openGeneratePanel('target', 'video');
  });
  await screen.findByTestId('generate-video-execute');
  // The panel renders one frame before the catalog resolves; until it does the
  // view model has no model to ask. Assert past that frame, or the subject is
  // the loading state rather than the mode (#1964).
  await waitFor(() =>
    expect(screen.getByTestId('generate-model-trigger').textContent).not.toBe(
      '',
    ),
  );
  return view;
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

/**
 * Writes a prompt whose text is followed by one `@` mention per source id —
 * what the editor produces when someone picks a reference out of the `@`
 * popup. The mention chips are what the reference gate and the payload read;
 * a connected image the prompt never mentions is not one of them.
 * @param text - The prompt body.
 * @param sourceIds - The source node ids to mention, in order.
 */
function typePromptMentioning(text: string, sourceIds: string[]): void {
  const fragment = getPromptFragment('p', 's', 'target');
  if (!fragment) throw new Error('seedVideoNode must run first');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  for (const id of sourceIds) {
    const chip = new Y.XmlElement('referenceMention');
    chip.setAttribute('sourceNodeId', id);
    chip.setAttribute('kind', 'image');
    paragraph.insert(paragraph.length, [chip]);
  }
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
            <VideoGeneratePanelContainer
              projectId='p'
              spaceId='s'
              nodes={[]}
              edges={[]}
            />
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

    it('builds the payload from live Yjs, not from the render closure', async () => {
      // The file's central claim is that every write-callback re-derives from
      // live Yjs at click time, because the render closure freezes the moment
      // onExecute is created and a collaborator's edit after that would be
      // clobbered. The other submit tests cannot see the difference: their
      // React node and their Yjs node say the same thing. Here they disagree
      // the way they do when someone else changed the model while my panel was
      // open — the payload must carry what Yjs says, not what my closure
      // captured.
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const create = vi
        .spyOn(canvasApi, 'createTask')
        .mockResolvedValue({ id: 't1' } as Awaited<
          ReturnType<typeof canvasApi.createTask>
        >);
      seedVideoNode({
        model: 'veo-3.1-lite',
        paramsByModel: { 'veo-3.1-lite': { duration: 4 } },
      });
      typePrompt('a drone shot over a canyon at dawn');
      // The React view still carries the pre-edit pick.
      mountContainer('video', {
        model: 'veo-3.1',
        paramsByModel: { 'veo-3.1': { duration: 8 } },
      });
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      const execute = await screen.findByTestId('generate-video-execute');
      await waitFor(() => expect(execute).not.toBeDisabled());
      fireEvent.click(execute);
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const payload = create.mock.calls[0]![0];
      expect(payload.model).toBe('veo-3.1-lite');
      expect(payload.params.duration).toBe(4);
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

    it('submits the prompt as of the click, not as of the last render', async () => {
      // A collaborator's keystroke can land between the render that created
      // onExecute and the click. React has not flushed it into state yet, but
      // the editor already reported it — so the ref carries it and the state
      // does not. Both writes happen in ONE act batch here, which is the only
      // way that window exists in a test.
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const create = vi
        .spyOn(canvasApi, 'createTask')
        .mockResolvedValue({ id: 't1' } as Awaited<
          ReturnType<typeof canvasApi.createTask>
        >);
      seedVideoNode();
      typePrompt('first draft');
      mountContainer('video');
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      const execute = await screen.findByTestId('generate-video-execute');
      await waitFor(() => expect(execute).not.toBeDisabled());
      act(() => {
        const fragment = getPromptFragment('p', 's', 'target');
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText(' and a second line')]);
        fragment?.insert(fragment.length, [paragraph]);
        execute.click();
      });
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0]![0].params.prompt).toContain('second line');
    });

    it('refuses to submit against a node a task is already writing', async () => {
      // The arrow stays clickable while a generation runs (a greyed control
      // explains nothing), so the gate is the only thing between a busy node
      // and a second overwrite task landing on it.
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const create = vi.spyOn(canvasApi, 'createTask');
      seedVideoNode({ state: 'handling' });
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
    });

    it('refuses to submit against a node a collaborator just deleted', async () => {
      // The node can go between the panel opening and the click. Reading the
      // React prop would still see it; only a fresh Yjs read does not.
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const create = vi.spyOn(canvasApi, 'createTask');
      seedVideoNode();
      typePrompt('a drone shot over a canyon at dawn');
      mountContainer('video');
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      const execute = await screen.findByTestId('generate-video-execute');
      await waitFor(() => expect(execute).not.toBeDisabled());
      // Gone from the document, still in this render's props — the exact
      // window the fresh read exists for.
      act(() => {
        removeNode('p', 's', 'target');
      });
      fireEvent.click(execute);
      await new Promise((r) => setTimeout(r, 0));
      expect(create).not.toHaveBeenCalled();
    });

    it('does not close a panel that has since moved to another node', async () => {
      // Submit, then open the panel on a different node before the request
      // settles. Closing on success without checking would shut the panel the
      // user is now looking at.
      type Task = Awaited<ReturnType<typeof canvasApi.createTask>>;
      let release: (task: Task) => void = () => {};
      vi.spyOn(canvasApi, 'createTask').mockImplementation(
        () =>
          new Promise<Task>((resolve) => {
            release = resolve;
          }),
      );
      const execute = await openReadyPanel();
      fireEvent.click(execute);
      act(() => {
        useCanvasStore.getState().openGeneratePanel('other', 'video');
      });
      await act(async () => {
        release({ id: 't1' } as Task);
      });
      expect(useCanvasStore.getState().panelHostId).toBe('other');
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

  describe('mode', () => {
    it('opens in the mode the node stored', async () => {
      // The mode is collaborative state on the node, not panel-local: reopening
      // — or a collaborator switching — has to land on the same mode, with that
      // mode's model.
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const stored = { mode: 'i2v', model: 'kling-i2v' };
      // Both sides of the same node: Yjs is what the write-callbacks re-read,
      // the React view is what production projects onto the board from it.
      seedVideoNode(stored);
      mountContainer('video', stored);
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('generate-video-mode-trigger'),
        ).toHaveTextContent('Image to Video');
      });
      // The model list narrows to the mode, so the pill can only name an
      // image-to-video model — and only once the catalog has resolved.
      await waitFor(() => {
        expect(screen.getByTestId('generate-model-trigger')).toHaveTextContent(
          'Kling I2V',
        );
      });
    });

    it('writes the switch to Yjs with the target mode’s model', async () => {
      // The outgoing mode's model must NOT ride along: `veo-3.1` belongs to
      // t2v alone, and submitting it under i2v would ignore the first frame
      // and generate from the prompt alone — the backend does not catch this
      // one (its source gate passes any model with a source-less mode).
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      seedVideoNode();
      mountContainer('video');
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      const trigger = await screen.findByTestId('generate-video-mode-trigger');
      // The panel renders one frame before the catalog resolves, and the
      // switch is disabled until it does (nothing to switch TO yet).
      await waitFor(() => expect(trigger).not.toBeDisabled());
      fireEvent.click(trigger);
      await userEvent.click(await screen.findByTestId('generate-video-mode-i2v'));
      await waitFor(() => {
        const data = readCanvasGraph('p', 's').nodes.find(
          (n) => n.id === 'target',
        )?.data;
        expect(data && 'mode' in data ? data.mode : undefined).toBe('i2v');
      });
      const data = readCanvasGraph('p', 's').nodes.find(
        (n) => n.id === 'target',
      )?.data;
      expect(data && 'model' in data ? data.model : undefined).toBe('kling-i2v');
    });
  });

  describe('reference rail', () => {
    /** An image node on the board, wired into the target as a reference. */
    const SOURCE = {
      id: 'src',
      data: {
        kind: 'image' as const,
        status: 'idle' as const,
        name: 'A still',
        content: 'https://cdn/a.png',
      },
    };
    const WIRE = [{ id: 'e1', source: 'src', target: 'target' }];

    it('shows one row per incoming edge', async () => {
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      seedVideoNode();
      mountContainer('video', undefined, { nodes: [SOURCE], edges: WIRE });
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      expect(await screen.findByTestId('generate-ref-e1')).toBeInTheDocument();
    });

    it('ignores an edge pointing at another node', async () => {
      // The rail is this node's incoming edges — not the board's.
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      seedVideoNode();
      mountContainer('video', undefined, {
        nodes: [SOURCE],
        edges: [{ id: 'e9', source: 'src', target: 'other' }],
      });
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      await screen.findByTestId('generate-video-execute');
      expect(screen.queryByTestId('generate-ref-e9')).toBeNull();
    });

    it('the row’s ✕ deletes the edge', async () => {
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      seedVideoNode();
      addEdge('p', 's', { id: 'e1', source: 'src', target: 'target' });
      mountContainer('video', undefined, { nodes: [SOURCE], edges: WIRE });
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      fireEvent.click(await screen.findByTestId('generate-ref-remove-e1'));
      await waitFor(() => {
        expect(readCanvasGraph('p', 's').edges).toEqual([]);
      });
    });

    it('“add reference” toggles the canvas pick on this node', async () => {
      // Mounted in `ref` because this suite's other reference cases are, not
      // because the tool is mode-gated — it is not, and must not be: this one
      // button starts every kind of reference pick, and a TEXT reference
      // works in every mode. The case below holds that.
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const stored = { mode: 'ref', model: 'kling-o3-pro-ref' };
      seedVideoNode(stored);
      mountContainer('video', stored);
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      const tool = await screen.findByTestId('generate-video-tool-reference');
      fireEvent.click(tool);
      expect(useCanvasStore.getState().pickSession).toEqual({
        nodeId: 'target',
        purpose: 'reference',
      });
      fireEvent.click(tool);
      expect(useCanvasStore.getState().pickSession).toBeNull();
    });
  });

  describe('first-last frame (#1904)', () => {
    /**
     * Opens the panel on a first-last frame node, waiting for both slots.
     * @param over - Node data overrides (e.g. picked frames).
     */
    async function openFirstLastPanel(
      over: Record<string, unknown> = {},
    ): Promise<void> {
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const stored = { mode: 'first_last', model: 'kling-i2v', ...over };
      seedVideoNode(stored);
      typePrompt('drift from dusk to dawn');
      mountContainer('video', stored);
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      await screen.findByTestId('generate-video-execute');
      await screen.findByTestId('generate-video-tool-end-frame');
    }

    it('offers both slots, and only in this mode', async () => {
      await openFirstLastPanel();
      expect(
        screen.getByTestId('generate-video-tool-first-frame'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('generate-video-tool-end-frame'),
      ).toBeInTheDocument();
    });

    it('each slot picks into its own field, neither overwriting the other', async () => {
      // The two are independent: either can be picked or replaced whenever,
      // and nothing waits for the other (user 2026-08-10). Sharing a write
      // would make the second pick replace the first.
      await openFirstLastPanel();
      fireEvent.click(screen.getByTestId('generate-video-tool-first-frame'));
      expect(useCanvasStore.getState().pickSession).toEqual({
        nodeId: 'target',
        purpose: 'firstFrame',
      });
      fireEvent.click(screen.getByTestId('generate-video-tool-end-frame'));
      expect(useCanvasStore.getState().pickSession).toEqual({
        nodeId: 'target',
        purpose: 'endFrame',
      });
    });

    it('each slot shows its own picture', async () => {
      await openFirstLastPanel({
        firstFrameUrl: 'https://cdn/first.png',
        endFrameUrl: 'https://cdn/last.png',
      });
      expect(
        screen.getByTestId('generate-video-first-frame-thumbnail'),
      ).toHaveAttribute('src', 'https://cdn/first.png');
      expect(
        screen.getByTestId('generate-video-end-frame-thumbnail'),
      ).toHaveAttribute('src', 'https://cdn/last.png');
    });

    it('refuses to submit with the end frame empty, and says which one', async () => {
      // Naming the missing slot is the whole point of refusing here: telling
      // someone who already picked a first frame to "pick a first frame"
      // sends them to check a control that is already filled.
      await openFirstLastPanel({ firstFrameUrl: 'https://cdn/first.png' });
      const createTask = vi.spyOn(canvasApi, 'createTask');
      fireEvent.click(screen.getByTestId('generate-video-execute'));
      // The wrapper adds a dedup id as a second argument, so assert the
      // message itself — which slot it names is the point of this case.
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe(
        'Pick an end frame',
      );
      expect(createTask).not.toHaveBeenCalled();
      createTask.mockRestore();
    });

    it('refuses to submit with the first frame empty, and says which one', async () => {
      await openFirstLastPanel({ endFrameUrl: 'https://cdn/last.png' });
      const createTask = vi.spyOn(canvasApi, 'createTask');
      fireEvent.click(screen.getByTestId('generate-video-execute'));
      // The wrapper adds a dedup id as a second argument, so assert the
      // message itself — which slot it names is the point of this case.
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe(
        'Pick a first frame',
      );
      expect(createTask).not.toHaveBeenCalled();
      createTask.mockRestore();
    });

    it('sends both frames under their own params once both are picked', async () => {
      await openFirstLastPanel({
        firstFrameUrl: 'https://cdn/first.png',
        endFrameUrl: 'https://cdn/last.png',
      });
      const createTask = vi
        .spyOn(canvasApi, 'createTask')
        .mockResolvedValue({ taskId: 't1' } as never);
      fireEvent.click(screen.getByTestId('generate-video-execute'));
      await waitFor(() => expect(createTask).toHaveBeenCalled());
      expect(createTask.mock.calls[0]?.[0]?.params).toMatchObject({
        image: 'https://cdn/first.png',
        end_image: 'https://cdn/last.png',
      });
      createTask.mockRestore();
    });
  });

  describe('first frame', () => {
    /**
     * Opens the panel on an image-to-video node.
     * @param over - Node data overrides (e.g. a picked first frame).
     */
    async function openI2vPanel(
      over: Record<string, unknown> = {},
    ): Promise<void> {
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const stored = { mode: 'i2v', model: 'kling-i2v', ...over };
      seedVideoNode(stored);
      typePrompt('make it drift toward the sea');
      mountContainer('video', stored);
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      await screen.findByTestId('generate-video-execute');
      // The first frame renders before the catalog resolves, and the slot only
      // appears once the model says this mode needs a source.
      await screen.findByTestId('generate-video-tool-first-frame');
    }

    it('offers the slot only in a mode that takes a source', async () => {
      // Text-to-video ignores a first frame, so a slot there would offer a
      // pick the submit then drops on the floor.
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      seedVideoNode();
      mountContainer('video');
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      await screen.findByTestId('generate-video-execute');
      expect(
        screen.queryByTestId('generate-video-tool-first-frame'),
      ).toBeNull();
    });

    it('shows the slot in image-to-video', async () => {
      await openI2vPanel();
      expect(
        screen.getByTestId('generate-video-tool-first-frame'),
      ).toBeInTheDocument();
    });

    it('the slot toggles a first-frame pick on this node', async () => {
      await openI2vPanel();
      const slot = screen.getByTestId('generate-video-tool-first-frame');
      fireEvent.click(slot);
      expect(useCanvasStore.getState().pickSession).toEqual({
        nodeId: 'target',
        purpose: 'firstFrame',
      });
      fireEvent.click(slot);
      expect(useCanvasStore.getState().pickSession).toBeNull();
    });

    it('shows the picked copy and clears it on ✕', async () => {
      await openI2vPanel({ firstFrameUrl: 'https://cdn/a.png' });
      expect(
        screen.getByTestId('generate-video-first-frame-thumbnail'),
      ).toHaveAttribute('src', 'https://cdn/a.png');
      fireEvent.click(screen.getByTestId('generate-video-first-frame-clear'));
      await waitFor(() => {
        const data = readCanvasGraph('p', 's').nodes.find(
          (n) => n.id === 'target',
        )?.data;
        expect(
          data && 'firstFrameUrl' in data ? data.firstFrameUrl : undefined,
        ).toBeUndefined();
      });
    });

    it('refuses to submit a source-needing mode with an empty slot, and says why', async () => {
      // The arrow stays clickable (a greyed control explains nothing, user
      // 2026-07-18): without this the submit reaches the provider, which
      // rejects it, and the user is left with an error from upstream about a
      // control they were never told to fill.
      const create = vi.spyOn(canvasApi, 'createTask');
      await openI2vPanel();
      const execute = screen.getByTestId('generate-video-execute');
      await waitFor(() => expect(execute).not.toBeDisabled());
      fireEvent.click(execute);
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      expect(create).not.toHaveBeenCalled();
      expect(useCanvasStore.getState().panelHostId).toBe('target');
    });

    it('sends the picked frame as the image param', async () => {
      const create = vi
        .spyOn(canvasApi, 'createTask')
        .mockResolvedValue({ id: 't1' } as Awaited<
          ReturnType<typeof canvasApi.createTask>
        >);
      await openI2vPanel({ firstFrameUrl: 'https://cdn/a.png' });
      const execute = screen.getByTestId('generate-video-execute');
      await waitFor(() => expect(execute).not.toBeDisabled());
      fireEvent.click(execute);
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const payload = create.mock.calls[0]![0];
      expect(payload.model).toBe('kling-i2v');
      expect(payload.params.image).toBe('https://cdn/a.png');
    });

    it('leaves the image param off the wire in text-to-video', async () => {
      // A stale copy from an earlier i2v session must not ride along: the
      // provider reads the key's PRESENCE, so an ignored first frame would
      // change what gets generated.
      const create = vi
        .spyOn(canvasApi, 'createTask')
        .mockResolvedValue({ id: 't1' } as Awaited<
          ReturnType<typeof canvasApi.createTask>
        >);
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      seedVideoNode({ firstFrameUrl: 'https://cdn/a.png' });
      typePrompt('a drone shot over a canyon at dawn');
      mountContainer('video');
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      const execute = await screen.findByTestId('generate-video-execute');
      await waitFor(() => expect(execute).not.toBeDisabled());
      fireEvent.click(execute);
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0]![0].params.image).toBeUndefined();
    });
  });
  describe('reference-to-video (#1927)', () => {
    /** Two image nodes on the board, both wired into the target. */
    const SOURCES = [
      {
        id: 'ref-a',
        data: {
          kind: 'image' as const,
          status: 'idle' as const,
          name: 'A',
          content: 'https://cdn/a.png',
        },
      },
      {
        id: 'ref-b',
        data: {
          kind: 'image' as const,
          status: 'idle' as const,
          name: 'B',
          content: 'https://cdn/b.png',
        },
      },
      {
        id: 'ref-c',
        data: {
          kind: 'image' as const,
          status: 'idle' as const,
          name: 'C',
          content: 'https://cdn/c.png',
        },
      },
    ];
    const WIRES = [
      { id: 'r-a', source: 'ref-a', target: 'target' },
      { id: 'r-b', source: 'ref-b', target: 'target' },
      { id: 'r-c', source: 'ref-c', target: 'target' },
    ];

    /**
     * Opens the panel on a reference-to-video node with both images connected
     * on the board AND in the doc — the submit path re-derives everything from
     * live Yjs at click time, so an edge that exists only as a prop would
     * vanish the moment execute is pressed.
     * @param mentioned - The source ids the prompt `@`-mentions.
     */
    async function openRefPanel(mentioned: string[]): Promise<void> {
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const stored = { mode: 'ref', model: 'kling-o3-pro-ref' };
      seedVideoNode(stored);
      for (const source of SOURCES) {
        addNode('p', 's', {
          id: source.id,
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            name: source.data.name,
            createdAt: 1000,
            createdBy: 'u1',
            locked: false,
            state: 'idle',
            attachments: [],
            content: source.data.content,
          },
        } as Parameters<typeof addNode>[2]);
      }
      for (const wire of WIRES) addEdge('p', 's', wire);
      typePromptMentioning('the two of them walk into frame', mentioned);
      mountContainer('video', stored, { nodes: SOURCES, edges: WIRES });
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      // The prompt reaches the container through the editor's change
      // callback, a tick after the button first renders — every case here
      // presses it, so waiting for the prompt to land belongs in one place.
      const execute = await screen.findByTestId('generate-video-execute');
      await waitFor(() => expect(execute).not.toBeDisabled());
    }

    it('offers no source slot — the sources come from the rail', async () => {
      await openRefPanel(['ref-a']);
      expect(screen.queryByTestId('generate-video-tool-first-frame')).toBeNull();
      expect(screen.queryByTestId('generate-video-tool-end-frame')).toBeNull();
      expect(
        screen.queryByTestId('generate-video-tool-character-image'),
      ).toBeNull();
      expect(screen.queryByTestId('generate-video-tool-driving-video')).toBeNull();
    });

    it('sends only the @-mentioned image, not everything connected', async () => {
      await openRefPanel(['ref-b']);
      const create = vi
        .spyOn(canvasApi, 'createTask')
        .mockResolvedValue({ id: 't1' } as Awaited<
          ReturnType<typeof canvasApi.createTask>
        >);
      fireEvent.click(screen.getByTestId('generate-video-execute'));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0]![0].params.images).toEqual([
        'https://cdn/b.png',
      ]);
    });

    it('stays clickable with nothing mentioned, and says what to do', async () => {
      // A greyed button explains nothing to someone who has already written a
      // prompt and connected their images (user 2026-08-11). The message names
      // the action — type @ — rather than reporting a failure.
      await openRefPanel([]);
      const create = vi.spyOn(canvasApi, 'createTask');
      const execute = screen.getByTestId('generate-video-execute');
      expect(execute).not.toBeDisabled();
      fireEvent.click(execute);
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      // The message must NOT instruct an action the user may already have
      // performed, and it must name the prerequisite the image panel's sibling
      // string carries ("connected") — without it, a user on a fresh node types
      // `@`, gets no popup at all, and has nowhere to go.
      expect(vi.mocked(toast.error).mock.calls[0]![0]).toBe(
        'This mode needs a reference image — connect one to this node and type @ in the prompt to use it',
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses more images than the model takes, and says how many', async () => {
      // Knowing the limit is the difference between removing one and guessing.
      // The model in this catalog takes two; the prompt mentions three.
      await openRefPanel(['ref-a', 'ref-b', 'ref-c']);
      const create = vi.spyOn(canvasApi, 'createTask');
      fireEvent.click(screen.getByTestId('generate-video-execute'));
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      expect(vi.mocked(toast.error).mock.calls[0]![0]).toContain('2');
      expect(create).not.toHaveBeenCalled();
    });

    it('dims the connected images under a mode that cannot use them', async () => {
      // The rail is shared across modes and a reference survives a switch, so
      // without this the panel would keep offering images the mode ignores.
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const stored = { mode: 't2v', model: 'veo-3.1' };
      seedVideoNode(stored);
      mountContainer('video', stored, { nodes: SOURCES, edges: WIRES });
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      const insert = await screen.findByTestId('generate-ref-insert-r-a');
      // #1945: the dim moved from the controls to the ROW, so it covers every
      // REFERENCE MATERIAL row instead of the image ones alone (a text row is
      // prompt material and stays lit), and the refusal is aria-disabled
      // rather than the HTML attribute (which would block click and hover).
      expect(
        screen.getByTestId('generate-ref-r-a').classList.contains('opacity-50'),
      ).toBe(true);
      expect(insert).toHaveAttribute('aria-disabled', 'true');
      // And it cannot be thrown away while it is dimmed: references are shared
      // across modes, so a ✕ pressed here would lose an image the user is
      // coming back for (design decision 2026-08-11).
      expect(screen.getByTestId('generate-ref-remove-r-a')).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });

    it('keeps offering to add a reference in every mode', async () => {
      // A video node also takes TEXT references, and a text reference works
      // in every mode — the rail keeps its row live and the @ popup keeps
      // offering it. This one button starts every kind of reference pick, so
      // gating it on "does this mode use reference IMAGES" took away the only
      // in-panel way to add one, which is why that gate was withdrawn.
      // (Audio and video rows are a separate matter: both halves ask
      // `canConnect(kind, 'image')`, which is false for them, so those rows
      // are inert in every mode including this one — tracked as #1930.)
      await openInMode('t2v', 'veo-3.1');
      expect(
        screen.getByTestId('generate-video-tool-reference'),
      ).not.toBeDisabled();
    });

    it('dims the prompt’s own image chips under a mode that cannot use them', async () => {
      // The second of the dimming signal's three outlets. The rail says "this
      // mode cannot use that image"; without this the chip already sitting in
      // the prompt would render at full strength and say the opposite.
      await openInMode('t2v', 'veo-3.1');
      // The dim rides the ScrollArea's VIEWPORT class, not the root that
      // carries the test id.
      expect(
        screen
          .getByTestId('generate-prompt-editor')
          .querySelector('[data-radix-scroll-area-viewport]')?.className ?? '',
      ).toContain('reference-mention[data-kind=image]');
    });

    it('leaves the prompt’s image chips alone in the mode that uses them', async () => {
      await openInMode('ref', 'kling-o3-pro-ref');
      expect(
        screen
          .getByTestId('generate-prompt-editor')
          .querySelector('[data-radix-scroll-area-viewport]')?.className ?? '',
      ).not.toContain('reference-mention[data-kind=image]');
    });

    it('tells the user @ is how a reference gets used', async () => {
      // Acceptance 11: the placeholder is where someone learns the rule before
      // being refused by it. One sentence for every mode, deliberately —
      // making it follow the mode put it in `useEditor`'s dependency list and
      // rebuilt the whole editor on each switch, undo history included.
      await openInMode('ref', 'kling-o3-pro-ref');
      await waitFor(() =>
        expect(
          screen
            .getByTestId('generate-prompt-editor')
            .querySelector('[data-placeholder]')
            ?.getAttribute('data-placeholder') ?? '',
        ).toContain('@'),
      );
    });

    it('leaves the connected images alone in the mode that uses them', async () => {
      await openRefPanel(['ref-a']);
      const insert = await screen.findByTestId('generate-ref-insert-r-a');
      expect(insert.classList.contains('opacity-50')).toBe(false);
      expect(insert).not.toBeDisabled();
      expect(screen.getByTestId('generate-ref-remove-r-a')).not.toBeDisabled();
    });

    it('offers the talking head a character image and an audio slot (#1935)', async () => {
      // Acceptance 1. The character image is the slot image animation already
      // collects; the audio slot is this slice's only new one.
      await openInMode('talking_head', 'omnihuman-1.5');
      expect(
        screen.getByTestId('generate-video-tool-character-image'),
      ).toBeVisible();
      expect(
        screen.getByTestId('generate-video-tool-driving-audio'),
      ).toBeVisible();
      // And nothing from the modes next to it.
      expect(
        screen.queryByTestId('generate-video-tool-driving-video'),
      ).toBeNull();
      expect(screen.queryByTestId('generate-video-tool-first-frame')).toBeNull();
    });

    it('lets the talking head execute with no prompt written (#1935)', async () => {
      // Acceptance 6. This model declares no `prompt` param at all, so asking
      // for one would be a demand about a model with nothing to do with the
      // answer. Seeded without a prompt fragment, so the editor's text really
      // is empty.
      //
      // Submits rather than only reading the button: the panel weighs this in
      // TWO places — once for the button's disabled state, once inside the
      // execute handler before it builds the task — and a case that only
      // reads the button leaves the second one unheld.
      await openInMode('talking_head', 'omnihuman-1.5', {
        characterImageUrl: 'https://cdn/portrait.png',
        drivingAudio: { url: 'https://cdn/speech.mp3' },
      });
      await waitFor(() =>
        expect(screen.getByTestId('generate-video-execute')).not.toBeDisabled(),
      );
      const createTask = vi
        .spyOn(canvasApi, 'createTask')
        .mockResolvedValue({ taskId: 't1' } as never);
      fireEvent.click(screen.getByTestId('generate-video-execute'));
      await waitFor(() => expect(createTask).toHaveBeenCalled());
      expect(createTask.mock.calls[0]?.[0]?.params).toMatchObject({
        image: 'https://cdn/portrait.png',
        audio: 'https://cdn/speech.mp3',
        prompt: '',
      });
      createTask.mockRestore();
    });

    it('still demands a prompt from the modes whose model takes one', async () => {
      // Acceptance 7, the other side of the same switch: dropping the demand
      // must not leak into the five modes that keep it. Seeded with no prompt
      // fragment, so the editor is empty from the start and this is exactly
      // the state the demand exists to refuse.
      await openInMode('t2v', 'veo-3.1');
      await waitFor(() =>
        expect(screen.getByTestId('generate-video-execute')).toBeDisabled(),
      );
    });

    it('shows no params pill for a model with nothing to edit (#1935)', async () => {
      // Acceptance 12. Each group inside the pill already vanishes when its
      // model declares no options; the pill itself did not, so this model —
      // which declares none of the four it edits — got an empty label opening
      // onto an empty popover.
      await openInMode('talking_head', 'omnihuman-1.5');
      // Wait for the row the pill belongs to, or "not there" would also be
      // true of a panel that has not drawn its toolbar yet.
      await screen.findByTestId('generate-video-mode-trigger');
      expect(screen.queryByTestId('generate-video-params-trigger')).toBeNull();
    });

    it('keeps the params pill for the models that have something in it', async () => {
      await openInMode('t2v', 'veo-3.1');
      await screen.findByTestId('generate-video-mode-trigger');
      expect(
        await screen.findByTestId('generate-video-params-trigger'),
      ).toBeVisible();
    });
    /**
     * Opens the panel with the rail's fixture board wired up.
     * @param mode - The generation sub-mode.
     * @param model - The model name to store on the node.
     * @param slots - Extra node fields (slot picks).
     */
    async function openInMode(
      mode: string,
      model: string,
      slots: Record<string, unknown> = {},
    ): Promise<void> {
      await openPanelInMode(mode, model, slots, {
        nodes: SOURCES,
        edges: WIRES,
      });
    }

  });

  describe('口播档不收提示词 (#1950 片6)', () => {
    /**
     * 开一个指定档位的面板，board 由用例自己给。
     * @param mode - 生成子模式。
     * @param model - 模型名。
     * @param board - 额外的画布节点与连线（参考轨道要用）。
     * @returns 渲染结果，切档的用例拿它 rerender。
     */
    async function openMode(
      mode: string,
      model: string,
      board: BoardOverrides = {},
    ): Promise<ReturnType<typeof render>> {
      return openPanelInMode(mode, model, {}, board);
    }

    it('5.5 口播档下点文本引用行，有拒绝语而不是静默无反应', async () => {
      // 文本引用行不受档位吃不吃引用的约束：`insertRefusal` 只对参考素材
      // 判定，文本行在它第一句就被无条件放行（reference-usability.ts 的
      // `if (!isReferenceMaterial(sourceNodeType)) return null`），所以它在
      // 这一档照样是亮的、可点的。
      // 而这一档没有提示词编辑器，插进去无处可去 —— 容器那句
      // `promptEditorRef.current?.insertReference(item)` 会被 `?.` 静默吞掉。
      await openMode('talking_head', 'omnihuman-1.5', {
        nodes: [
          {
            id: 'src',
            // 正文不进这个投影（node-view.ts:149），轨道那行的预览靠
            // `textById` 单独取，这一条不需要它。
            data: { kind: 'text', status: 'idle' },
          },
        ],
        edges: [{ id: 'e1', source: 'src', target: 'target' }],
      });
      fireEvent.click(await screen.findByTestId('generate-ref-insert-e1'));
      await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    });

    it('5.1 口播档不挂载提示词编辑器，那一格是这一档的说明', async () => {
      await openMode('talking_head', 'omnihuman-1.5');
      expect(
        await screen.findByTestId('generate-video-prompt-not-used'),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId('generate-prompt-editor'),
      ).not.toBeInTheDocument();
    });

    it('5.6 目录还在路上时，那一格照常挂编辑器 —— 不知道不等于不要', async () => {
      // 模型查不到时 `promptRequired` 兜底取 true（view-model）。这个兜底是
      // 给执行闸门定的：认不出的模型不该放松别的档都有的要求。渲染跟着它走，
      // 于是加载期六个档一律有提示词框，跟改动前一样。改成 false 会让另外五
      // 个档在那一帧失去输入框（#1950 第一轮试过，第二轮撤回）。
      let go: (v: unknown) => void = () => {};
      vi.spyOn(modelsApi, 'list').mockReturnValue(
        new Promise((r) => {
          go = r as (v: unknown) => void;
        }) as never,
      );
      const data = { mode: 'talking_head', model: 'omnihuman-1.5' };
      seedVideoNode(data);
      mountContainer('video', data);
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      expect(
        await screen.findByTestId('generate-prompt-editor'),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId('generate-video-prompt-not-used'),
      ).not.toBeInTheDocument();
      await act(async () => {
        go(catalog());
      });
      expect(
        await screen.findByTestId('generate-video-prompt-not-used'),
      ).toBeInTheDocument();
    });

    it('5.7 判据读模型的参数声明，不是模式名', async () => {
      // 同一档挂一个声明了 prompt 的模型，编辑器照常渲染。钉的是 §4.1
      // 那个复用决定：问模型，不问档位。用的模型必须是这一档真提供的
      // （`pickModelForMode` 会把不属于本档的存值丢掉回落到第一个），
      // 所以这里用同档的 TALKING_HEAD_WITH_PROMPT，不是别档的 veo-3.1。
      await openMode('talking_head', 'omnihuman-scripted');
      expect(
        screen.getByTestId('generate-prompt-editor'),
      ).toBeInTheDocument();
    });

    it('5.3 从口播档切回别的档，编辑器回来，之前打的字还在', async () => {
      // 这一档只是不显示、不发送，不删。字存在协作片段里，编辑器重新挂上
      // 就该原样读回来 —— 六档共用一份提示词（#1919 在追），切回去发现自己
      // 写的没了是数据损失。
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const t2v = { mode: 't2v', model: 'veo-3.1' };
      seedVideoNode(t2v);
      typePrompt('一段写给文生视频的描述');
      const view = mountContainer('video', t2v);
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      const before = await screen.findByTestId('generate-prompt-editor');
      expect(before.textContent).toContain('一段写给文生视频的描述');
      view.rerender(
        panelTree('video', { mode: 'talking_head', model: 'omnihuman-1.5' }),
      );
      await screen.findByTestId('generate-video-prompt-not-used');
      view.rerender(panelTree('video', t2v));
      const after = await screen.findByTestId('generate-prompt-editor');
      expect(after.textContent).toContain('一段写给文生视频的描述');
    });

    it('5.4 在别的档打过字之后切到口播档执行，载荷里的 prompt 是空串', async () => {
      // 提交路径的兜底是 `editor?.serializePrompt() ?? promptTextRef.current`
      // （容器 :537-538）。那个镜像只在 `handlePromptChange` 里写、从没人清，
      // 编辑器卸载时也不回调。所以「不挂载编辑器」本身达不成「不发送」，
      // 要一行显式判断。
      //
      // 档位在两处各读一次：渲染读 `nodes` prop，提交读 Yjs 的实时值。所以
      // Yjs 那份一开始就种成口播档带素材（提交要过素材门），prop 先给
      // 文生视频档让编辑器挂上、打完字再 rerender 换档 —— 这正是产品里的
      // 顺序，而且组件不重新挂载，镜像才留得住。
      const spy = vi
        .spyOn(canvasApi, 'createTask')
        .mockResolvedValue(undefined as never);
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      const talkingHead = {
        mode: 'talking_head',
        model: 'omnihuman-1.5',
        characterImageUrl: 'https://cdn/portrait.png',
        drivingAudio: { url: 'https://cdn/voice.m4a' },
      };
      seedVideoNode(talkingHead);
      // 写进协作片段，编辑器挂上时的回调会把它抄进那个镜像 —— 合成 input
      // 事件驱动不了 TipTap 的 onUpdate，镜像就不会脏，这条也就白测了。
      typePrompt('一段写给文生视频的描述');
      const view = mountContainer('video', {
        mode: 't2v',
        model: 'veo-3.1',
      });
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      await screen.findByTestId('generate-prompt-editor');
      view.rerender(panelTree('video', talkingHead));
      await screen.findByTestId('generate-video-prompt-not-used');
      fireEvent.click(screen.getByTestId('generate-video-execute'));
      await waitFor(() => expect(spy).toHaveBeenCalled());
      const body = spy.mock.calls[0]![0] as { params: Record<string, unknown> };
      expect(body.params.prompt).toBe('');
      spy.mockRestore();
    });

    it('参考轨道对图片引用行的既有拒绝语没被这一片改掉', async () => {
      // 这一条钉的是既有行为、不是这一片新加的：口播档在档位表里
      // `takesReferences: false`（video-mode-options.ts），参考轨道自己就在
      // `refuseInsert`（ReferenceRail.tsx:118）拦下并弹了拒绝语，压根走不到
      // 容器那句会静默吞掉的 `promptEditorRef.current?.insertReference`。
      // 留着它是因为编辑器在这一档不挂载了，那句吞掉的代码从此没有别的
      // 东西挡在前面。
      await openMode('talking_head', 'omnihuman-1.5', {
        nodes: [{ id: 'src', data: { kind: 'image', status: 'idle', content: 'https://cdn/a.png' } }],
        edges: [{ id: 'e1', source: 'src', target: 'target' }],
      });
      const row = await screen.findByTestId('generate-ref-insert-e1');
      fireEvent.click(row);
      await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    });
  });

  describe('参数编辑记在哪个模型名下 (#1948)', () => {
    it('记在面板正在渲染的模型名下，不是节点存着的那个', async () => {
      // 新建的节点根本没写过 model（node-factory 不写），而面板已经解析出
      // 第一个可用模型并渲染了它的控件。此时按存的那个记账等于记进空名下，
      // 控件下一帧就弹回默认值。
      //
      // 这一条钉的是容器传了哪个值。纯函数那侧钉的是「给对了模型名会怎样」，
      // 两者不是一件事：Gate 2 第 3 轮实测把这次修复整个回退回原 bug，
      // 3807 条测试没有一条变红。
      vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
      seedVideoNode(); // 没有 model，没有 paramsByModel
      mountContainer('video');
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      fireEvent.click(
        await screen.findByTestId('generate-video-params-trigger'),
      );
      // veo-3.1 的时长声明是 [4, 8]，默认 8 —— 选 4 是一次真的改动。
      fireEvent.click(
        await screen.findByTestId('generate-video-duration-option-4'),
      );
      await waitFor(() => {
        const data = readCanvasGraph('p', 's').nodes.find(
          (n) => n.id === 'target',
        )?.data;
        const records = (
          data as { paramsByModel?: Record<string, Record<string, unknown>> }
        ).paramsByModel;
        // veo-3.1 是 t2v 档的第一个模型，也就是面板此刻渲染的那个。
        expect(records).toEqual({ 'veo-3.1': { duration: 4 } });
      });
    });

    it('目标档解不出模型时整个写入放弃，已有的记录一条都不丢 (9.8)', async () => {
      // 这一片让这道防护要保的东西变多了：以前失守清掉的是一份参数，现在会
      // 把所有模型的记录一起清空。
      //
      // 防护写在容器的 `if (!model) return`，纯函数测试摸不到它 —— 设计文档
      // 前一版把 9.8 的验证方法写成纯函数测试，删掉防护也不会红。
      vi.spyOn(modelsApi, 'list').mockResolvedValue({
        ...catalog(),
        video: [T2V], // 只有 t2v 一档有模型，i2v 档解不出
        total: 1,
      });
      const records = { 'veo-3.1': { duration: 4 } };
      seedVideoNode({ mode: 't2v', model: 'veo-3.1', paramsByModel: records });
      mountContainer('video', { mode: 't2v', model: 'veo-3.1' });
      act(() => {
        useCanvasStore.getState().openGeneratePanel('target', 'video');
      });
      // 面板先渲染一帧、目录才解析完，在那之前这个 trigger 是 disabled 的
      // （ModeToggle 的 `disabled={catalogEmpty}`）—— 不等它 enabled 就点，
      // 浮层不开、下一句报 `Unable to find generate-video-mode-i2v`。
      const trigger = await screen.findByTestId('generate-video-mode-trigger');
      await waitFor(() => expect(trigger).not.toBeDisabled());
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByTestId('generate-video-mode-i2v'));
      await waitFor(() => {
        const data = readCanvasGraph('p', 's').nodes.find(
          (n) => n.id === 'target',
        )?.data as {
          mode?: string;
          model?: string;
          paramsByModel?: Record<string, Record<string, unknown>>;
        };
        // 一个字段都没被动过：模式还是 t2v，模型还在，记录原样。
        expect(data.mode).toBe('t2v');
        expect(data.model).toBe('veo-3.1');
        expect(data.paramsByModel).toEqual(records);
      });
    });
  });
});
