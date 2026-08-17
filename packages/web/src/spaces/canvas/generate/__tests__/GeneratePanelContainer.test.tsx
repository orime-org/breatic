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

// WHICH bodies the panel subscribes to is behaviour (#1774 round-4): only the
// text nodes its references can reach — never the whole board, where every
// keystroke by anyone anywhere would rebuild this panel's view model. The spy
// wraps the real hook so the subscription set itself is observable.
vi.mock('@web/data/yjs/use-text-body', async (importActual) => {
  const actual =
    await importActual<typeof import('@web/data/yjs/use-text-body')>();
  return { ...actual, useTextBodies: vi.fn(actual.useTextBodies) };
});

import { toast } from 'sonner';

import { GeneratePanelContainer } from '@web/spaces/canvas/generate/GeneratePanelContainer';
import { useTextBodies } from '@web/data/yjs/use-text-body';
import { useSocket } from '@web/data/yjs/use-socket';
import {
  CanvasContext,
  type CanvasContextValue,
} from '@web/spaces/canvas/canvas-context';
import { canvasApi, modelsApi } from '@web/data/api';
import * as Y from 'yjs';

import {
  addNode,
  getPromptFragment,
  readCanvasGraph,
  setNodeModel,
} from '@web/data/yjs/canvas-space';
import { _resetForTests } from '@web/data/yjs/manager';
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
}): ReturnType<typeof render> {
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
      {/* A REAL ReactFlow with the target node: GeneratePanelBody mounts
          inside a NodeToolbar, which renders its children only when the node
          exists in ReactFlow's store — a bare provider never mounts the
          body (caught wiring the caret-awareness test). The canvas here
          exists only so NodeToolbar renders.

          Drive clicks with `fireEvent`, not `userEvent`: a userEvent pointer
          sequence bubbles to ReactFlow's d3-zoom, whose d3-drag reads
          `event.view.document` — null in jsdom, an unhandled error. Radix
          popovers open under a bare click; what does need waiting for is the
          trigger becoming enabled once the catalog resolves (measured — that,
          not the event kind, is what makes an early click miss). */}
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
      takes_prompt: true,
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
    // 等到订阅集真的成形，不是等「这个 hook 被调用过」。这个 hook 住在
    // `GeneratePanelBody` 里，而那是 `CatalogGatedFrame` 的子节点、容器又在
    // 面板没打开时整个 `return null` —— 所以面板没开时一次都不会调，目录没
    // 到齐时也不会调（#1964）。它第一次被调用就已经在面板里了，但那一帧的
    // 订阅集可能还没成形，所以这里等的是集本身。
    await waitFor(() => {
      expect(vi.mocked(useTextBodies).mock.lastCall?.[2]).toEqual([
        'wired-a',
        'wired-b',
      ]);
    });
    listSpy.mockRestore();
  });
});

/**
 * A text-to-image model whose ratio list has two entries, so picking one is a
 * real change rather than a no-op on the default.
 */
const T2I_MODEL: ModelEntry = {
  name: 'nano-banana',
  display_name: 'Nano Banana',
  modality: 'image',
  mode: 't2i',
  description: '',
  guide: '',
  tier: 'recommended',
  cost_per_call: 5,
  generation_time: 10,
  takes_prompt: true,
  params: {
    aspect_ratio: { description: '', values: ['1:1', '16:9'], default: '1:1' },
  },
  providers: [],
  sourcesByMode: { t2i: [] },
};

/** An image-to-image model, so a switch to i2i has something to resolve to. */
const I2I_MODEL: ModelEntry = {
  ...T2I_MODEL,
  name: 'nano-edit',
  display_name: 'Nano Edit',
  mode: 'i2i',
  params: {
    aspect_ratio: { description: '', values: ['1:1', '4:3'], default: '4:3' },
  },
  sourcesByMode: { i2i: ['image'] },
};

/**
 * A catalog carrying the image model above.
 * @param models - Which image models the catalog offers; defaults to t2i only.
 * @returns The catalog payload `modelsApi.list()` resolves to.
 */
function imageCatalog(models: ModelEntry[] = [T2I_MODEL]): ModelCatalog {
  return {
    image: models,
    video: [],
    audio: [],
    tts: [],
    three_d: [],
    understand: [],
    total: models.length,
  };
}

/**
 * Seeds a real image node in the canvas-space doc. The container reads the
 * node fresh from Yjs on every write, so a case that asserts what got written
 * needs the node to actually be there — the React props alone are not it.
 */
function seedImageNode(): void {
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
}

describe('GeneratePanelContainer — 参数编辑记在哪个模型名下 (#1948)', () => {
  beforeEach(() => {
    _resetForTests();
    useCanvasStore.setState({
      panelHostId: null,
      panelKind: null,
      pickSession: null,
    });
  });

  it('记在面板正在渲染的模型名下，不是节点存着的那个', async () => {
    // 新建的节点根本没写过 model（node-factory 不写），而面板已经解析出第一个
    // 可用模型并渲染了它的控件。此时按存的那个记账等于记进空名下，控件下一帧
    // 弹回默认值。
    //
    // 这一条钉的是容器传了哪个值 —— 纯函数那侧钉的是「给对了模型名会怎样」，
    // 两者不是一件事：Gate 2 第 3 轮实测把这次修复整个回退回原 bug，全套测试
    // 没有一条变红。
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockResolvedValue(imageCatalog());
    seedImageNode();
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    fireEvent.click(await screen.findByTestId('generate-ratio-trigger'));
    fireEvent.click(await screen.findByTestId('generate-ratio-option-16:9'));
    await waitFor(() => {
      const data = readCanvasGraph('p', 's').nodes.find(
        (n) => n.id === 'target',
      )?.data;
      const records = (
        data as { paramsByModel?: Record<string, Record<string, unknown>> }
      ).paramsByModel;
      expect(records).toEqual({ 'nano-banana': { aspect_ratio: '16:9' } });
    });
    listSpy.mockRestore();
  });

  it('切档写下新档的模型和它自己那份记录，旧模型的记录留着', async () => {
    // 这一条是下面 9.8 的对照组：9.8 断言「什么都没被写」，而「这个面板的切档
    // 压根不写任何东西」也满足那个断言 —— 少了这一条，两者分不开。Gate 2 第 5
    // 轮实测：把容器的 onToggleMode 整个换成空函数，这个文件 8 条全绿。
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockResolvedValue(imageCatalog([T2I_MODEL, I2I_MODEL]));
    seedImageNode();
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    fireEvent.click(await screen.findByTestId('generate-ratio-trigger'));
    fireEvent.click(await screen.findByTestId('generate-ratio-option-16:9'));
    await waitFor(() => {
      const d = readCanvasGraph('p', 's').nodes.find((n) => n.id === 'target')
        ?.data as { paramsByModel?: Record<string, unknown> };
      expect(d.paramsByModel).toEqual({ 'nano-banana': { aspect_ratio: '16:9' } });
    });
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    fireEvent.click(await screen.findByTestId('generate-mode-i2i'));
    await waitFor(() => {
      const d = readCanvasGraph('p', 's').nodes.find((n) => n.id === 'target')
        ?.data as {
        mode?: string;
        model?: string;
        paramsByModel?: Record<string, unknown>;
      };
      expect(d.mode).toBe('i2i');
      expect(d.model).toBe('nano-edit');
      // 新模型拿自己声明的默认值 4:3，不继承 t2i 那边选的 16:9；而 t2i 那份
      // 记录原样留着，切回去还是 16:9。
      expect(d.paramsByModel).toEqual({
        'nano-banana': { aspect_ratio: '16:9' },
        'nano-edit': { aspect_ratio: '4:3' },
      });
    });
    listSpy.mockRestore();
  });

  it('目标档解不出模型时整个写入放弃，已有的记录一条都不丢 (9.8)', async () => {
    // 这一片让这道防护要保的东西变多了：以前失守清掉的是一份参数，现在会把
    // 所有模型的记录一起清空。
    //
    // 防护写在容器的 `if (!model) return`，纯函数测试摸不到它 —— Gate 2 第 4
    // 轮实测：删掉这一行，684 条测试没有一条变红，而视频侧同一行删掉当场红。
    // 「什么都没写」这个断言要跟上面那条正向的一起读才成立。
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      // 只有 t2i 一档有模型，i2i 档解不出
      .mockResolvedValue(imageCatalog([T2I_MODEL]));
    seedImageNode();
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    // 先让参数记录落一份下来，才验得出「一条都不丢」。
    fireEvent.click(await screen.findByTestId('generate-ratio-trigger'));
    fireEvent.click(await screen.findByTestId('generate-ratio-option-16:9'));
    await waitFor(() => {
      const d = readCanvasGraph('p', 's').nodes.find((n) => n.id === 'target')
        ?.data as { paramsByModel?: Record<string, unknown> };
      expect(d.paramsByModel).toEqual({ 'nano-banana': { aspect_ratio: '16:9' } });
    });
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    fireEvent.click(await screen.findByTestId('generate-mode-i2i'));
    await waitFor(() => {
      const d = readCanvasGraph('p', 's').nodes.find((n) => n.id === 'target')
        ?.data as {
        mode?: string;
        model?: string;
        paramsByModel?: Record<string, unknown>;
      };
      // 一个字段都没被动过。
      expect(d.mode).toBeUndefined();
      expect(d.paramsByModel).toEqual({ 'nano-banana': { aspect_ratio: '16:9' } });
    });
    listSpy.mockRestore();
  });
});

describe('GeneratePanelContainer — 提交路径读模型的提示词声明 (#1966)', () => {
  beforeEach(() => {
    _resetForTests();
    useCanvasStore.setState({
      panelHostId: null,
      panelKind: null,
      pickSession: null,
    });
  });

  // 模型不吃提示词时，这个面板跟视频面板一样：那一格不是输入框，是一句说明。
  // 实现对抗（2026-08-16）咬出这半边当时没做 —— 参考轨道已经按同一个字段冻住
  // 了，正中间却还摆着一个能打字的框，同一块面板自相矛盾。
  it('模型不吃提示词时，那一格是说明不是输入框', async () => {
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockResolvedValue(imageCatalog([{ ...T2I_MODEL, takes_prompt: false }]));
    seedImageNode();
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    expect(await screen.findByTestId('generate-prompt-not-used')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-prompt-editor')).not.toBeInTheDocument();
    listSpy.mockRestore();
  });

  // 对照组：模型说吃，输入框就该在。少了它，上面那条在「这个面板永远不挂
  // 编辑器」的实现下也会绿。
  it('模型吃提示词时，输入框在、说明不在', async () => {
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockResolvedValue(imageCatalog([{ ...T2I_MODEL, takes_prompt: true }]));
    seedImageNode();
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    expect(await screen.findByTestId('generate-prompt-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-prompt-not-used')).not.toBeInTheDocument();
    listSpy.mockRestore();
  });

  // 参考轨道那一维的接线：`GeneratePanel` 把 `promptRequired` 传成
  // `modelTakesPrompt`。实测过这条接线此前零覆盖 —— 单独删掉那一行，全仓
  // 3948 条测试没有一条变红，而 #1965 的行为在图片面板这边就静默消失了。
  it('模型不吃提示词时，参考轨道那一行也冻住', async () => {
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockResolvedValue(imageCatalog([{ ...T2I_MODEL, takes_prompt: false }]));
    seedImageNode();
    mountContainer({
      nodes: [
        { id: 'target', data: { kind: 'image', status: 'idle' } },
        { id: 'src', data: { kind: 'text', status: 'idle' } },
      ],
      edges: [{ id: 'e1', source: 'src', target: 'target' }],
    });
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    const insert = await screen.findByTestId('generate-ref-insert-e1');
    expect(insert.getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getByTestId('generate-ref-remove-e1').getAttribute('aria-disabled'),
    ).toBe('true');
    listSpy.mockRestore();
  });

  // 对照组：模型说吃提示词，同一行就该是活的。少了它，上面那条在「这一行
  // 永远冻着」的实现下也会绿。
  it('模型吃提示词时，同一行是活的', async () => {
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockResolvedValue(imageCatalog([{ ...T2I_MODEL, takes_prompt: true }]));
    seedImageNode();
    mountContainer({
      nodes: [
        { id: 'target', data: { kind: 'image', status: 'idle' } },
        { id: 'src', data: { kind: 'text', status: 'idle' } },
      ],
      edges: [{ id: 'e1', source: 'src', target: 'target' }],
    });
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    const insert = await screen.findByTestId('generate-ref-insert-e1');
    expect(insert.getAttribute('aria-disabled')).toBe('false');
    expect(
      screen.getByTestId('generate-ref-remove-e1').getAttribute('aria-disabled'),
    ).toBe('false');
    listSpy.mockRestore();
  });

  // 这个面板有两道闸门：按钮亮不亮，以及点下去之后提交前用活值再判一次。
  // 两处此前都写死 true。设计对抗指出设计文档只点名了第一处 —— 而第二处漏改
  // 的后果最难发现：按钮是亮的，点下去 `return` 走人，一句话都不说（它下面
  // 几道闸门都配了 toast，只有这道没有）。
  //
  // 这一条钉的就是第二处读的是活值。把它改回写死 true，这条会红。
  it('模型不吃提示词时，空提示词也照样提交得出去', async () => {
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockResolvedValue(
        imageCatalog([{ ...T2I_MODEL, takes_prompt: false }]),
      );
    const createSpy = vi
      .spyOn(canvasApi, 'createTask')
      .mockResolvedValue({ id: 'task-1' } as Awaited<
        ReturnType<typeof canvasApi.createTask>
      >);
    seedImageNode();
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    // 面板要等目录到齐才出现（#1964），所以 findByTestId 已经隔了一个往返；
    // 但按钮从渲染到解出模型还差几帧，不等它就点的是一个禁用按钮。
    const btn = await screen.findByTestId('generate-execute');
    await waitFor(() => {
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    listSpy.mockRestore();
    createSpy.mockRestore();
  });

  // 对照组：同样是空提示词，模型说吃，就该被拦下。少了这一条，上面那条在
  // 「这个面板根本不拦任何东西」的实现下也会绿。
  it('模型吃提示词时，空提示词提交不出去', async () => {
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockResolvedValue(imageCatalog([{ ...T2I_MODEL, takes_prompt: true }]));
    const createSpy = vi
      .spyOn(canvasApi, 'createTask')
      .mockResolvedValue({ id: 'task-1' } as Awaited<
        ReturnType<typeof canvasApi.createTask>
      >);
    seedImageNode();
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    // 这一档模型吃提示词而提示词是空的，所以按钮本来就该是禁用的 —— 先钉住
    // 这一点，再点它一次确认提交路径也不放行（两道闸门各自成立）。
    const btn = await screen.findByTestId('generate-execute');
    await waitFor(() => {
      expect(screen.getByTestId('generate-model-trigger')).toBeTruthy();
    });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 50));
    expect(createSpy).not.toHaveBeenCalled();
    listSpy.mockRestore();
    createSpy.mockRestore();
  });
});

// 「模型不吃提示词就别发提示词」这件事有两半：不挂编辑器，和不发送。上面那
// 组钉住了前一半。这一组钉后一半 —— 它是本 PR 才需要的：改之前这个容器把
// `promptRequired` 写死 true（`origin/main` 的 :340 / :601），`freshPrompt` 没有
// 分支也永远正确；改成读 `takes_prompt` 之后，它第一次可能是 false。
//
// 不挂编辑器只挡住了「在这里打字」。镜像里还留着上一个模型下打的那句话 ——
// `handlePromptChange` 是唯一写入方、没有任何地方清它，编辑器卸载时也不回调
// （只在换节点时才随整体重挂而重置）。所以没有那一行显式判断，一次口播类的
// 生成会把上一个模型的话带出去。视频面板 2026-08-15 就为这个加了那一行
// （提交 908b519a，现在在 `VideoGeneratePanelContainer.tsx:553`），图片面板这次补齐。
describe('GeneratePanelContainer — 不吃提示词的模型不发提示词 (#1966)', () => {
  beforeEach(() => {
    _resetForTests();
    useCanvasStore.setState({
      panelHostId: null,
      panelKind: null,
      pickSession: null,
    });
  });

  /** 往节点的提示词片段里放一句话，编辑器 onCreate 时会把它回调进镜像。 */
  function seedPromptText(text: string): void {
    const fragment = getPromptFragment('p', 's', 'target');
    if (!fragment) throw new Error('node has no prompt fragment');
    const paragraph = new Y.XmlElement('paragraph');
    const words = new Y.XmlText();
    words.insert(0, text);
    paragraph.insert(0, [words]);
    fragment.insert(0, [paragraph]);
  }

  it('切到不吃提示词的模型后提交，上一个模型下的字不跟着发出去', async () => {
    const listSpy = vi.spyOn(modelsApi, 'list').mockResolvedValue(
      imageCatalog([
        { ...T2I_MODEL, name: 'takes-one', takes_prompt: true },
        { ...T2I_MODEL, name: 'takes-none', takes_prompt: false },
      ]),
    );
    const createSpy = vi
      .spyOn(canvasApi, 'createTask')
      .mockResolvedValue({ id: 'task-1' } as Awaited<
        ReturnType<typeof canvasApi.createTask>
      >);
    seedImageNode();
    seedPromptText('上一个模型下打的字');
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });

    // 第一个模型吃提示词：编辑器挂上、把那句话灌进镜像，执行按钮因此可点。
    await screen.findByTestId('generate-prompt-editor');
    const btn = await screen.findByTestId('generate-execute');
    await waitFor(() => {
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });

    // 模型在面板开着的时候被换成不吃提示词的那个（协作者改的，或者自己在
    // 选择器里选的 —— 两条路都写同一个 Yjs 字段）。这个测试的 `nodes` 是
    // 静态 prop，所以渲染态不动、编辑器还挂着，而提交路径从活 Yjs 重新取值
    // （`freshVm`）—— 正好把「渲染那一半」和「提交那一半」分开：这一刻
    // `promptEditorRef.current` 不是 null，`serializePrompt()` 会交出那句话，
    // 所以唯一能让载荷里是空串的，只有那一行显式判断。
    act(() => {
      setNodeModel('p', 's', 'target', 't2i', 'takes-none', {});
    });

    fireEvent.click(screen.getByTestId('generate-execute'));
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    expect(createSpy.mock.calls[0]?.[0]?.params).toMatchObject({ prompt: '' });
    listSpy.mockRestore();
    createSpy.mockRestore();
  });

  // 对照组：模型说吃，那句话就该原样发出去。少了它，上面那条在「这个面板
  // 永远发空串」的实现下也会绿。
  it('模型吃提示词时，那句话原样发出去', async () => {
    const listSpy = vi
      .spyOn(modelsApi, 'list')
      .mockResolvedValue(imageCatalog([{ ...T2I_MODEL, takes_prompt: true }]));
    const createSpy = vi
      .spyOn(canvasApi, 'createTask')
      .mockResolvedValue({ id: 'task-1' } as Awaited<
        ReturnType<typeof canvasApi.createTask>
      >);
    seedImageNode();
    seedPromptText('要发出去的那句话');
    mountContainer();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    const btn = await screen.findByTestId('generate-execute');
    await waitFor(() => {
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    expect(createSpy.mock.calls[0]?.[0]?.params).toMatchObject({
      prompt: '要发出去的那句话',
    });
    listSpy.mockRestore();
    createSpy.mockRestore();
  });
});
