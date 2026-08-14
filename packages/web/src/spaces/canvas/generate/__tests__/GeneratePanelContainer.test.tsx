// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlow } from '@xyflow/react';
import type { ModelCatalog, ModelEntry } from '@breatic/shared';
import type { ReactNode } from 'react';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
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

// WHICH bodies the panel subscribes to is behaviour (#1774 round-4): only the
// text nodes its references can reach — never the whole board, where every
// keystroke by anyone anywhere would rebuild this panel's view model. The spy
// wraps the real hook so the subscription set itself is observable.
vi.mock('@web/data/yjs/use-text-body', async (importActual) => {
  const actual =
    await importActual<typeof import('@web/data/yjs/use-text-body')>();
  return { ...actual, useTextBodies: vi.fn(actual.useTextBodies) };
});

import * as Y from 'yjs';
import { toast } from 'sonner';

import { addNode, getPromptFragment } from '@web/data/yjs/canvas-space';
import { _resetForTests } from '@web/data/yjs/manager';
import { canvasApi } from '@web/data/api/canvas';
import { GeneratePanelContainer } from '@web/spaces/canvas/generate/GeneratePanelContainer';
import { useTextBodies } from '@web/data/yjs/use-text-body';
import { useSocket } from '@web/data/yjs/use-socket';
import {
  CanvasContext,
  type CanvasContextValue,
} from '@web/spaces/canvas/canvas-context';
import { modelsApi } from '@web/data/api';
import { useCanvasStore } from '@web/stores';

type ContainerProps = Parameters<typeof GeneratePanelContainer>[0];

/**
 * Mounts the container under a fresh QueryClient (no retries — the failure
 * path resolves in one round trip).
 * @param graph - Optional canvas graph override; defaults to a lone target.
 * @returns The render result.
 */
function mountContainer(graph?: {
  nodes?: ContainerProps['nodes'];
  edges?: ContainerProps['edges'];
  /** Whether the canvas is read-only — the role's, or this connection's. */
  readOnly?: boolean;
}): ReturnType<typeof render> {
  const canvas: CanvasContextValue = {
    projectId: 'p',
    spaceId: 's',
    readOnly: graph?.readOnly ?? false,
    caretProvider: null,
  };
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
        <CanvasContext.Provider value={canvas}>
          <GeneratePanelContainer
            projectId='p'
            spaceId='s'
            nodes={
              graph?.nodes ?? [
                {
                  id: 'target',
                  data: { kind: 'image', status: 'idle' },
                },
              ]
            }
            edges={graph?.edges ?? []}
          />
        </CanvasContext.Provider>
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
      panelHostId: null, panelKind: null,
      pickSession: null,
    });
  });

  it('on catalog fetch failure: toasts, closes the panel intent, renders nothing', async () => {
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockRejectedValue(new Error('boom'));
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
    expect(useCanvasStore.getState().panelHostId).toBeNull();
    expect(
      screen.queryByTestId('generate-prompt-editor'),
    ).not.toBeInTheDocument();
    listSpy.mockRestore();
  });

  // Collaborator carets (batch-2 item 14): the prompt fragment lives in the
  // CANVAS-SPACE doc, so carets have to be published through that exact doc's
  // shared provider — into any other awareness and nobody on this board sees
  // them.
  //
  // The container used to acquire that provider itself. It no longer does
  // (#1774): the canvas resolves it once and hands it to every editor on the
  // board, because two acquisitions leave two answers in the codebase to
  // "whose caret is this" and they drift. What is checked here is that the
  // second one has not grown back; WHICH document the canvas acquires is
  // checked where that now happens, in `CanvasSpace.test`.
  it('does not acquire a provider of its own', async () => {
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
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    await waitFor(() => {
      expect(useCanvasStore.getState().panelHostId).toBe('target');
    });
    expect(vi.mocked(useSocket)).not.toHaveBeenCalled();
    listSpy.mockRestore();
  });

  /**
   * Renders the container with the target node in the given mode (shared by the
   * two zombie-guard cases below). An empty catalog keeps vm.mode resolving off
   * the node's stored `mode` alone.
   * @param client - The query client.
   * @param mode - The node's generation sub-mode.
   * @returns The render tree.
   */
  const modeTree = (
    client: QueryClient,
    mode: 'i2i' | 't2i',
  ): React.JSX.Element => (
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

  const EMPTY_CATALOG = {
    image: [],
    video: [],
    audio: [],
    tts: [],
    three_d: [],
    understand: [],
    total: 0,
  };

  // Reference pick SURVIVES a t2i switch (#1788 batch-3 #1): t2i no longer
  // DISABLES the reference button — references are text-scoped there (image
  // sources dim, text stays pickable), so a reference pick started in i2i stays
  // valid after a flip to t2i. Ending it would strand the user mid-pick. The
  // pre-#1788-batch-3 guard killed it here on the (now-false) premise that t2i
  // disables references; Focus is the one that still ends (next test).
  it('KEEPS a running reference pick when the node mode becomes t2i (references are text-scoped, #1788 batch-3 #1)', async () => {
    const listSpy = vi.spyOn(modelsApi, 'list').mockResolvedValue(EMPTY_CATALOG);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(modeTree(client, 'i2i'));
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
      useCanvasStore.getState().startReferencePick('target');
    });
    await waitFor(() =>
      expect(useCanvasStore.getState().pickSession?.nodeId).toBe('target'),
    );
    // Mode flips to t2i (local toggle or a collaborator's setNodeMode) — the
    // reference pick must NOT be terminated.
    rerender(modeTree(client, 't2i'));
    // Give the mode effect a chance to (wrongly) fire, then assert it did not.
    await waitFor(() =>
      expect(useCanvasStore.getState().pickSession?.nodeId).toBe('target'),
    );
    expect(useCanvasStore.getState().pickSession?.purpose).toBe('reference');
    listSpy.mockRestore();
  });

  // Focus pick still ENDS on a t2i switch: a focus crop IS an image source, so
  // the Focus button stays disabled in t2i — a focus pick left running would
  // strand its banner + keyboard focus (the original zombie-guard case). Driven
  // by vm.mode so a collaborator's setNodeMode ends it too.
  it('ends a running FOCUS pick when the node mode becomes t2i (focus stays image-only)', async () => {
    const listSpy = vi.spyOn(modelsApi, 'list').mockResolvedValue(EMPTY_CATALOG);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(modeTree(client, 'i2i'));
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
      useCanvasStore.getState().startFocusPick('target');
    });
    await waitFor(() =>
      expect(useCanvasStore.getState().pickSession?.purpose).toBe('focus'),
    );
    rerender(modeTree(client, 't2i'));
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
      useCanvasStore.getState().openGeneratePanel('target', 'image');
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

// The subscription SET is the behaviour here (#1774 round-4): the panel's only
// consumers of body text — the reference rail and the chip serializer — read
// exclusively the text nodes wired into the target, so following anything more
// means a keystroke in an unrelated note rebuilds this panel's view model.
describe('GeneratePanelContainer — body subscription set', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      panelHostId: null,
      panelKind: null,
      pickSession: null,
    });
  });

  it('follows the text nodes wired into the target, not every text node on the board', async () => {
    const listSpy = vi.spyOn(modelsApi, 'list').mockResolvedValue({
      image: [],
      video: [],
      audio: [],
      tts: [],
      three_d: [],
      understand: [],
      total: 0,
    });
    mountContainer({
      nodes: [
        { id: 'target', data: { kind: 'image', status: 'idle' } },
        { id: 'wired-a', data: { kind: 'text', status: 'idle' } },
        { id: 'wired-b', data: { kind: 'text', status: 'idle' } },
        { id: 'stray', data: { kind: 'text', status: 'idle' } },
        { id: 'other', data: { kind: 'image', status: 'idle' } },
      ],
      edges: [
        { id: 'e1', source: 'wired-a', target: 'target' },
        // A second edge from the same source must not subscribe it twice.
        { id: 'e1b', source: 'wired-a', target: 'target' },
        { id: 'e2', source: 'wired-b', target: 'target' },
        // Wired into a DIFFERENT node — not this panel's business.
        { id: 'e3', source: 'stray', target: 'other' },
      ],
    });
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    await waitFor(() => {
      expect(vi.mocked(useTextBodies)).toHaveBeenCalled();
    });
    const ids = vi.mocked(useTextBodies).mock.lastCall?.[2];
    expect(ids).toEqual(['wired-a', 'wired-b']);
    listSpy.mockRestore();
  });
});

// The submit-time connection gate (#88).
//
// The gate is the first check in `onExecute`: a connection that may only look
// is refused with a warning instead of queueing a task. It has to live there
// rather than in the button's disabled state, for the same reason the node
// gate does — someone who clicks and gets nothing learns nothing. And what is
// at stake is not cosmetic: this request travels over HTTP, not Yjs, so the
// task queues and the studio is billed while the connection that would carry
// the result cannot write.
//
// Every other case in this file mounts an EMPTY catalog, which leaves Execute
// disabled — a click there never reaches `onExecute`, so asserting on the gate
// would pass without exercising it. These two cases build a catalog with one
// usable image model and a node state that satisfies `canExecuteGenerate`, and
// the second one is what proves the first is doing anything: if the fixture
// stopped producing a clickable button, the writable case fails loudly instead
// of the read-only case passing quietly.
describe('GeneratePanelContainer — submit-time connection gate (#88)', () => {
  /** One usable text-to-image model — enough for Execute to become clickable. */
  const T2I: ModelEntry = {
    name: 'nano-banana',
    display_name: 'Nano Banana',
    modality: 'image',
    mode: 't2i',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 5,
    generation_time: 10,
    params: {
      aspect_ratio: { description: '', values: ['1:1'], default: '1:1' },
    },
    providers: [],
    sourcesByMode: { t2i: [] },
  };

  /**
   * Seeds the target node in the canvas doc and writes a prompt into it.
   *
   * The prompt has to go through Yjs rather than the `nodes` prop: the image
   * panel always demands one (`promptRequired: true`), and the container reads
   * it out of the node's prompt fragment.
   */
  function seedNodeWithPrompt(): void {
    addNode('p', 's', {
      id: 'target',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        name: 'I',
        createdAt: 1000,
        createdBy: 'u1',
        locked: false,
        state: 'idle',
        attachments: [],
      },
    } as Parameters<typeof addNode>[2]);
    const fragment = getPromptFragment('p', 's', 'target');
    if (!fragment) throw new Error('addNode must run first');
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('a lighthouse at dusk')]);
    fragment.insert(0, [paragraph]);
  }

  /**
   * Opens the panel on a board where Execute is clickable.
   * @param readOnly - Whether this connection may only look.
   * @returns The enabled Execute button.
   */
  async function openReadyPanel(readOnly: boolean): Promise<HTMLElement> {
    vi.spyOn(modelsApi, 'list').mockResolvedValue({
      image: [T2I],
      video: [],
      audio: [],
      tts: [],
      three_d: [],
      understand: [],
      total: 1,
    } satisfies ModelCatalog);
    seedNodeWithPrompt();
    mountContainer({
      readOnly,
      nodes: [
        { id: 'target', data: { kind: 'image', status: 'idle', model: T2I.name } },
      ],
    });
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    const execute = await screen.findByTestId('generate-execute');
    await waitFor(() => expect(execute).not.toBeDisabled());
    return execute;
  }

  beforeEach(() => {
    vi.mocked(toast.warning).mockClear();
    _resetForTests();
    useCanvasStore.setState({
      panelHostId: null,
      panelKind: null,
      pickSession: null,
    });
  });

  it('refuses to queue a task on a read-only connection, and says why', async () => {
    const create = vi.spyOn(canvasApi, 'createTask');
    const execute = await openReadyPanel(true);
    fireEvent.click(execute);
    expect(create).not.toHaveBeenCalled();
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1);
  });

  it('queues the task when the connection may write', async () => {
    const create = vi
      .spyOn(canvasApi, 'createTask')
      .mockResolvedValue({ id: 't1' } as Awaited<
        ReturnType<typeof canvasApi.createTask>
      >);
    const execute = await openReadyPanel(false);
    fireEvent.click(execute);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });
});
