// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 图片面板的可用档列表在内容不变时保持同一个引用（#1951）。
 *
 * `GeneratePanel` 和它里面的 `ModeToggle` 都是 `React.memo`，而容器的 view model
 * 每次画布变动都重建 —— 拖一个节点的每一帧都重建。可用档是 filter 的产物，不
 * memo 就是每帧一个新数组，两级 memo 因此永不 bail，等于没有 memo。
 *
 * 视频侧的同一条不变量在 `video-panel-prop-identity.test.tsx` 里；图片侧此前没有
 * 对应的用例，拆掉容器里那个 `useMemo` 时 758 条测试无一变红（实现对抗第 2 轮
 * 实测）。
 *
 * 断言的是容器交下去的那个对象本身，不是渲染次数：渲染次数会因为别的原因上涨、
 * 从而以错误的理由通过，而引用正是 `React.memo` 拿去比的东西。
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

/** 面板每次拿到的可用档列表，最新的在最后。 */
const seenModeOptions: unknown[] = [];

// 真面板渲染的那棵树这个用例用不上，替身让用例读到 prop 对象本身 —— 那正是被测
// 的东西。故意不包 React.memo：包了会把这个用例要测的那次重渲藏起来。
vi.mock('@web/spaces/canvas/generate/GeneratePanel', () => ({
  GeneratePanel: (props: { modeOptions: unknown }): null => {
    seenModeOptions.push(props.modeOptions);
    return null;
  },
}));

import { GeneratePanelContainer } from '@web/spaces/canvas/generate/GeneratePanelContainer';
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
 * 一份 image 桶里有 t2i 模型的目录。
 *
 * 至少一个可服务的档：面板只在这个模态有档可服务时才打开（#1951），而这个文件
 * 测的是 prop 的引用稳定性，得先让面板开出来。
 * @returns 一份 image 非空的目录。
 */
function catalog(): ModelCatalog {
  return {
    image: [
      {
        name: 'nano',
        display_name: 'Nano',
        modality: 'image',
        mode: 't2i',
        description: '',
        guide: '',
        tier: 'optional',
        cost_per_call: 5,
        generation_time: 10,
        takes_prompt: true,
        params: {},
        providers: [],
        sourcesByMode: {},
      },
    ],
    video: [],
    audio: [],
    tts: [],
    three_d: [],
    understand: [],
    total: 1,
  };
}

/**
 * 容器的节点数组，每次调用现建一个新的。
 *
 * 每次一个新数组正是画布真实交下来的样子 —— ReactFlow 每次board 变动都重建它，
 * 所以这就是那个不许以新对象形式抵达 memo 子组件的输入。
 * @returns 一个 image 目标节点。
 */
function nodes(): Parameters<typeof GeneratePanelContainer>[0]['nodes'] {
  return [
    { id: 'target', data: { kind: 'image', status: 'idle' } },
  ] as Parameters<typeof GeneratePanelContainer>[0]['nodes'];
}

/**
 * 把容器挂在一个 image 节点上。
 * @returns render 结果，用例靠它强制重渲。
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
          <GeneratePanelContainer
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

describe('图片容器让它的 memo 子组件还能 bail', () => {
  beforeEach(() => {
    seenModeOptions.length = 0;
    _resetForTests();
    useCanvasStore.setState({
      panelHostId: null,
      panelKind: null,
      pickSession: null,
    });
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
        mode: 't2i',
      },
    } as Parameters<typeof addNode>[2]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('可用档内容没变时，交下去的是同一个数组', async () => {
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    const { rerender } = mount();
    act(() => {
      useCanvasStore.getState().openGeneratePanel('target', 'image');
    });
    await waitFor(() => {
      expect(seenModeOptions.length).toBeGreaterThan(0);
    });
    const before = seenModeOptions.at(-1);
    // 从这里开始数，不从挂载数：到这一刻面板已经渲染过不止一次（挂载 + 目录查询
    // 落定），绝对值判断会在那次要观察的重渲之前就满足 —— 于是用例拿一次渲染跟
    // 它自己比，`Object.is` 当然说相同，prop 再不稳也照过。
    const rendersBefore = seenModeOptions.length;

    // 一次 board 变动从这里看是什么样：一个全新的 nodes 数组，内容一模一样。
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
            <GeneratePanelContainer
              projectId='p'
              spaceId='s'
              edges={[]}
              nodes={nodes()}
            />
          </CanvasContext.Provider>
        </ReactFlow>
      </QueryClientProvider>,
    );

    expect(seenModeOptions.length).toBeGreaterThan(rendersBefore);
    expect(Object.is(before, seenModeOptions.at(-1))).toBe(true);
  });
});
