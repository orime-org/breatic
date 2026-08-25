// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `usePrefetchModelCatalog` (#1966) — warm the catalog when the canvas space
 * mounts, so the readiness gate #1964 adds costs nobody a visible wait.
 *
 * `prefetchQuery` rather than `useQuery`, for two reasons that both matter
 * here. It creates no subscriber, so the cache still ages out the way it did
 * before — a `useQuery` here would keep an observer alive for as long as the
 * space is open and the eviction branch of the catalog's lifecycle would stop
 * being reachable at all. And it discards errors by design (TanStack's own
 * words: `useQuery` will try again when the data is actually needed), which is
 * exactly the behaviour a background warm-up should have — nobody is waiting
 * on this request, so nobody should be told it failed.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { usePrefetchModelCatalog } from '@web/spaces/canvas/generate/use-prefetch-model-catalog';
import { modelsApi } from '@web/data/api';
import { toast } from '@web/lib/toast';
import type { ModelCatalog } from '@breatic/shared';

/**
 * An empty-but-valid catalog payload.
 * @returns The catalog every bucket of which is empty.
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
 * Mounts a component that does nothing but run the hook.
 * @returns The query client it ran against, so a test can inspect the cache.
 */
function mountHook(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  /**
   * Bare host for the hook under test.
   * @returns Nothing rendered.
   */
  function Host(): null {
    usePrefetchModelCatalog();
    return null;
  }
  render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePrefetchModelCatalog (#1966)', () => {
  it('把目录填进缓存，用的是面板那道门读的同一个 key', async () => {
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    const client = mountHook();
    await waitFor(() => {
      expect(client.getQueryData(['models'])).toBeTruthy();
    });
  });

  it('不建订阅者，所以缓存照常可以被回收', async () => {
    vi.spyOn(modelsApi, 'list').mockResolvedValue(catalog());
    const client = mountHook();
    await waitFor(() => {
      expect(client.getQueryData(['models'])).toBeTruthy();
    });
    const entry = client.getQueryCache().find({ queryKey: ['models'] });
    expect(entry?.getObserversCount()).toBe(0);
  });

  it('预取失败是静默的：不弹 toast', async () => {
    const errorSpy = vi.spyOn(toast, 'error');
    vi.spyOn(modelsApi, 'list').mockRejectedValue(new Error('down'));
    mountHook();
    await new Promise((r) => setTimeout(r, 50));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // 这个文件钉不住「用 prefetchQuery 而不是 fetchQuery」这个选择，实测过：
  // 把调用换成 fetchQuery，上面三条照样全绿。原因是这两个 API 只差一件事 ——
  // prefetchQuery 就是 fetchQuery 再吞掉 rejection —— 而调用点已经 `void` 掉
  // 了返回值，jsdom 这边也不把由此产生的 unhandledrejection 暴露给测试（试过
  // 监听 window 的 unhandledrejection，事件不来）。
  //
  // 所以这个选择靠的是官方契约而不是这里的断言：prefetch 系列被文档定义为
  // 不抛，正因为 useQuery 会在真正需要时再取一次。别在这里补一条形状像在测
  // 它、实际什么都没测的用例。
});
