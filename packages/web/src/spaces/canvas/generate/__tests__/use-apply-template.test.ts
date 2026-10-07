// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Applying a picked template from a generate panel (inner#977).
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findTemplate, type ModelEntry } from '@breatic/shared';

vi.mock('@web/data/yjs/canvas-space', () => ({
  readCanvasGraph: vi.fn(() => ({ nodes: [{ id: 'n1', data: { kind: 'image' } }], edges: [] })),
  setNodeMode: vi.fn(),
  setNodeModel: vi.fn(),
  getPromptFragment: vi.fn(() => null),
}));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

import { setNodeMode, setNodeModel } from '@web/data/yjs/canvas-space';
import { toast } from '@web/lib/toast';
import { useApplyTemplate } from '@web/spaces/canvas/generate/use-apply-template';

const grid = findTemplate('storyboard-grid-25');
if (!grid) throw new Error('grid template missing');

const ULTRA = {
  name: 'nano-banana-pro-edit-ultra',
  params: {
    aspect_ratio: { description: '', values: ['1:1'], default: '1:1' },
    resolution: { description: '', values: ['4k'], default: '4k' },
  },
} as unknown as ModelEntry;

describe('useApplyTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the template mode and model when this deployment serves the model', () => {
    const { result } = renderHook(() => useApplyTemplate('p', 's', 'n1', [ULTRA]));
    result.current(grid);
    expect(setNodeMode).toHaveBeenCalledWith('p', 's', 'n1', 'i2i', 'nano-banana-pro-edit-ultra', expect.any(Object));
    expect(setNodeModel).toHaveBeenCalledWith('p', 's', 'n1', 'i2i', 'nano-banana-pro-edit-ultra', expect.any(Object));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says the model is unavailable and writes nothing when the catalog no longer has it', () => {
    const { result } = renderHook(() => useApplyTemplate('p', 's', 'n1', []));
    result.current(grid);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(setNodeMode).not.toHaveBeenCalled();
    expect(setNodeModel).not.toHaveBeenCalled();
  });
});
