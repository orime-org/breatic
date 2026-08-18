// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `CatalogGatedFrame` — the one gate both Generate panels open behind (#1964).
 *
 * It used to gate on failure alone, so the panel rendered the moment the user
 * clicked Generate and every control filled itself in a beat later: a blank
 * model pill, empty param pills, a dead execute button, and — since #1950 —
 * a prompt box a talking-head model has no use for. On failure the panel even
 * flashed into view before closing itself.
 *
 * The gate now also holds while the request is in flight, so «panel on screen»
 * implies «catalog in hand» and nothing inside has to render a not-known-yet
 * state.
 *
 * Since #1951 it also implies «this modality has a mode we can serve». A
 * deployment with no key for a modality gets `[]` and an HTTP 200 — a
 * success, but not one the panel can be built out of, and the panel body
 * used to open anyway with every control inert and nothing said. That state
 * now ends here, with its own sentence, the same way failure and offline do.
 */

import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { CatalogGatedFrame } from '@web/spaces/canvas/generate/generate-panel-frame';
import { modelsApi } from '@web/data/api';
import { useCanvasStore } from '@web/stores/canvas';
import { toast } from '@web/lib/toast';
import type { ModelCatalog } from '@breatic/shared';

vi.mock('@xyflow/react', () => ({
  NodeToolbar: ({ children }: { children: React.ReactNode }) => (
    <div data-testid='toolbar'>{children}</div>
  ),
  Position: { Bottom: 'bottom' },
}));

/**
 * An empty-but-successful catalog — what a deployment with no configured key
 * for a modality actually returns.
 * @returns A catalog with every bucket empty.
 */
function emptyCatalog(): ModelCatalog {
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
 * 一份 image 桶里有 t2i 模型的目录 —— 「这个部署至少能做一件事」。
 * @returns 一份 image 非空的目录。
 */
function catalogWithImageModel(): ModelCatalog {
  return {
    ...emptyCatalog(),
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
    total: 1,
  };
}

/**
 * Mounts the gate around a marker child, each test with its own query client
 * so one test's cached catalog can never satisfy the next one's gate.
 * @param modality - 这个面板服务的模态（决定查目录的哪个桶）。
 * @returns The render result.
 */
function mountGate(modality: 'image' | 'video' = 'image'): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CatalogGatedFrame nodeId='n1' modality={modality}>
        <div data-testid='panel-body'>body</div>
      </CatalogGatedFrame>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useCanvasStore.setState({ panelHostId: 'n1', panelKind: 'generate' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CatalogGatedFrame — 目录到齐才展开 (#1964)', () => {
  it('请求还在路上时，什么都不渲染', async () => {
    // 永不 resolve：这就是「还在请求中」这个状态本身。
    vi.spyOn(modelsApi, 'list').mockReturnValue(
      new Promise(() => {}) as ReturnType<typeof modelsApi.list>,
    );
    mountGate();
    // 给它几帧机会去渲染错的东西。
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('panel-body')).toBeNull();
  });

  it('目录到齐之后才把内容放出来', async () => {
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalogWithImageModel());
    mountGate();
    await waitFor(() => {
      expect(screen.getByTestId('panel-body')).toBeTruthy();
    });
  });

  // 空目录是一次成功的请求（HTTP 200、data 不是 undefined），不是失败 ——
  // 所以它走 warning 不走 error，跟离线那句同族。但它同样不展开：这个部署
  // 一个能做的档都没有，面板里的每个控件都将是死的（#1951）。
  it('这个模态一个可用档都没有时不展开、说一句为什么、关掉面板意图', async () => {
    const errorSpy = vi.spyOn(toast, 'error');
    const warnSpy = vi.spyOn(toast, 'warning');
    vi.spyOn(modelsApi, 'list').mockResolvedValue(emptyCatalog());
    mountGate();
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    });
    // 认这条出口自己的那句话本身，不是「弹了个 warning」也不是 toast id ——
    // id 写死在调用处，跟传哪个 key 无关，把两句话对调它照样对得上（实现对抗
    // 第 2 轮实测：对调后 1207 条全绿，我第一版断言 id 也没抓住）。
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No models available'),
      expect.anything(),
    );
    expect(screen.queryByTestId('panel-body')).toBeNull();
    expect(useCanvasStore.getState().panelHostId).toBeNull();
    // 不是失败，所以不能弹 error。
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('另一个模态有模型不算数，看的是自己这个桶', async () => {
    // image 有模型、video 没有：视频面板该被拦住。
    const warnSpy = vi.spyOn(toast, 'warning');
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalogWithImageModel());
    mountGate('video');
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No models available'),
      expect.anything(),
    );
    expect(screen.queryByTestId('panel-body')).toBeNull();
  });

  it('这个模态有模型时照常展开、不说话', async () => {
    const warnSpy = vi.spyOn(toast, 'warning');
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalogWithImageModel());
    mountGate();
    await waitFor(() => {
      expect(screen.getByTestId('panel-body')).toBeTruthy();
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // 离线时 react-query 把请求 park 起来：`fetchStatus` 是 paused，既不 resolve
  // 也不 reject，queryFn 一次都不会调。只判「还在路上」会把它当成等待，而这个
  // 等待不会自己结束 —— 用户点了生成，屏幕上什么都不发生也没有任何解释，正是
  // 项目里禁的那种静默无反应。实现对抗（2026-08-16）咬出这条。
  it('离线时不展开、说一句为什么、关掉面板意图', async () => {
    const warnSpy = vi.spyOn(toast, 'warning');
    const listSpy = vi.spyOn(modelsApi, 'list').mockResolvedValue(emptyCatalog());
    onlineManager.setOnline(false);
    try {
      mountGate();
      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('offline'),
        expect.anything(),
      );
      expect(screen.queryByTestId('panel-body')).toBeNull();
      expect(useCanvasStore.getState().panelHostId).toBeNull();
      // 对照：这不是「请求失败了」，而是根本没发出去。
      expect(listSpy).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('取不到目录时不展开、弹 toast、关掉面板意图', async () => {
    const errorSpy = vi.spyOn(toast, 'error');
    vi.spyOn(modelsApi, 'list').mockRejectedValue(new Error('down'));
    mountGate();
    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Model list unavailable'),
      expect.anything(),
    );
    expect(screen.queryByTestId('panel-body')).toBeNull();
    expect(useCanvasStore.getState().panelHostId).toBeNull();
  });
});
