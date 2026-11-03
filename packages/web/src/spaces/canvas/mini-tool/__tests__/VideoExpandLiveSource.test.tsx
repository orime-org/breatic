// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ViewportPortal } from '@xyflow/react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cropCanvas, installLayout } from '../../crop/__tests__/crop-harness';
import { ExpandFrameOverlay } from '../ExpandFrameOverlay';
import { canvasSessions } from '@web/stores/canvas-session';
import { modelsApi } from '@web/data/api';

beforeEach(() => { installLayout(); canvasSessions.clear(); vi.spyOn(modelsApi, 'list').mockReturnValue(new Promise(() => {})); });
afterEach(() => { vi.restoreAllMocks(); canvasSessions.clear(); });

function openLiveVideo(): void {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{cropCanvas([{ id: 'video', kind: 'video', src: 'https://assets.example.test/canonical.webm' }], <ViewportPortal><ExpandFrameOverlay videoLiveSource videoRevision='revision' onNodeContextMenu={vi.fn()} /></ViewportPortal>)}</QueryClientProvider>);
  const video = screen.getByTestId('media-element');
  video.setAttribute('data-canonical-video-display', 'https://assets.example.test/canonical.webm');
  act(() => {
    const session = canvasSessions.of('').getState();
    session.openMiniTool('video', 'video.expand', { sourceContent: 'https://assets.example.test/canonical.webm', params: {} });
    session.setMiniToolSourceSize({ width: 1600, height: 1000 });
    session.setExpand({ frame: { x: -0.5, y: -0.5, width: 2, height: 2 }, ratio: 'free' });
  });
}

describe('approved live-source video expansion structure', () => {
  it('keeps the original node video exposed and never paints a cover or source-copy over its controls', () => {
    openLiveVideo();
    expect(screen.getByTestId('media-element').tagName).toBe('VIDEO');
    expect(screen.getByTestId('mini-tool-expand-frame')).toHaveClass('pointer-events-none');
    expect(screen.queryByTestId('mini-tool-expand-cover')).toBeNull();
    expect(screen.queryByTestId('mini-tool-expand-source')).toBeNull();
    expect(screen.queryByTestId('video-expand-surface')).toBeNull();
    expect(screen.getByTestId('mini-tool-expand-frame').querySelectorAll('[data-testid^="mini-tool-expand-handle-"]')).toHaveLength(8);
  });

  it('fills exactly four outside bands while the canonical source box remains an unpainted pointer hole', () => {
    openLiveVideo();
    const frame = screen.getByTestId('mini-tool-expand-frame');
    expect(frame.style.backgroundImage).toBe('');
    const expected = {
      top: ['0px', '0px', '798px', '149px'], bottom: ['0px', '449px', '798px', '149px'],
      left: ['0px', '149px', '199px', '300px'], right: ['599px', '149px', '199px', '300px'],
    };
    for (const [side, geometry] of Object.entries(expected)) {
      const band = screen.getByTestId(`video-expand-background-${side}`);
      expect([band.style.left, band.style.top, band.style.width, band.style.height]).toEqual(geometry);
      expect(band).toHaveClass('pointer-events-auto');
      expect(band.style.backgroundImage).not.toBe('');
    }
  });
});
