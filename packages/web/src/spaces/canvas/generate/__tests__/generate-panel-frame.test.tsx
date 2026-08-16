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
 * state. What it does NOT imply is a non-empty catalog: a deployment with no
 * key for a modality gets `[]` and an HTTP 200, which is a success and stays
 * the existing `catalogEmpty` handling's business.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
 * Mounts the gate around a marker child, each test with its own query client
 * so one test's cached catalog can never satisfy the next one's gate.
 * @returns The render result.
 */
function mountGate(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CatalogGatedFrame nodeId='n1'>
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
    vi.spyOn(modelsApi, 'list').mockResolvedValue(emptyCatalog());
    mountGate();
    await waitFor(() => {
      expect(screen.getByTestId('panel-body')).toBeTruthy();
    });
  });

  // 空目录是一次成功的请求（HTTP 200、data 不是 undefined），不是失败。
  // 面板照常展开，模型选择器由既有的 catalogEmpty 处理禁用。
  it('目录为空也照常展开，不当成失败', async () => {
    const errorSpy = vi.spyOn(toast, 'error');
    vi.spyOn(modelsApi, 'list').mockResolvedValue(emptyCatalog());
    mountGate();
    await waitFor(() => {
      expect(screen.getByTestId('panel-body')).toBeTruthy();
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('取不到目录时不展开、弹 toast、关掉面板意图', async () => {
    const errorSpy = vi.spyOn(toast, 'error');
    vi.spyOn(modelsApi, 'list').mockRejectedValue(new Error('down'));
    mountGate();
    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('panel-body')).toBeNull();
    expect(useCanvasStore.getState().panelHostId).toBeNull();
  });
});
