// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { t } from '@breatic/shared';
import { drawFitted, VideoTimelinePreview } from '../video/VideoTimelinePreview';
import type { VideoTimelinePresentedFrame } from '../video/video-timeline-decoder';

function FirstFrame({ frame, onFrame }: { frame: VideoTimelinePresentedFrame; onFrame: (frame: VideoTimelinePresentedFrame) => void }): React.JSX.Element | null {
  const sent = React.useRef(false);
  React.useLayoutEffect(() => { if (!sent.current) { sent.current = true; onFrame(frame); } }, [frame, onFrame]);
  return null;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('synchronous canonical timeline frame consumption', () => {
  it('copies the paused first RGBA frame before a binding or deferred GL draw exists', () => {
    const surface = document.createElement('canvas'); surface.width = 2; surface.height = 2;
    const drawImage = vi.fn();
    const context = { clearRect: vi.fn(), drawImage } as unknown as CanvasRenderingContext2D;
    (vi.spyOn(HTMLCanvasElement.prototype, 'getContext') as unknown as MockInstance<(contextId: string) => unknown>).mockImplementation((kind: string) => kind === '2d' ? context : null);
    const frame = { sourceKey: 'registered-source', sourceEpoch: 3, seekEpoch: 7, mediaTime: 0.12, surface };
    const clip = { clipId: '10000000-0000-4000-8000-000000000001', inputId: '20000000-0000-4000-8000-000000000001', in: 0, out: 1, transition: { kind: 'cut' as const, duration: 0 }, start: 0, end: 1, overlap: 0 };
    render(<VideoTimelinePreview plan={{ duration: 1, clips: [clip] }} inputs={[{ inputId: clip.inputId, url: 'https://media.example.test/source.webm' }]} cursor={0} playing={false} onCursorChange={vi.fn()} onPlayingChange={vi.fn()} renderDecoder={(_input, _onBinding, onFrame) => <FirstFrame frame={frame} onFrame={onFrame} />} />);
    expect(drawImage).toHaveBeenCalledWith(surface, 0, 0, 2, 2);
  });
});


describe('partial timeline presentation allocation', () => {
  it.each(['gain', 'texture'] as const)('releases every earlier owned resource exactly once when the second %s allocation fails', (stage) => {
    const disconnect = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const firstTexture = {};
    const createTexture = vi.fn().mockReturnValueOnce(firstTexture).mockReturnValueOnce(null);
    const deleteTexture = vi.fn();
    const deleteBuffer = vi.fn();
    const gl = {
      createBuffer: vi.fn(() => ({})), bindBuffer: vi.fn(), bufferData: vi.fn(), viewport: vi.fn(), pixelStorei: vi.fn(),
      createTexture, bindTexture: vi.fn(), texParameteri: vi.fn(), deleteTexture, deleteBuffer,
    } as unknown as WebGLRenderingContext;
    (vi.spyOn(HTMLCanvasElement.prototype, 'getContext') as unknown as MockInstance<(contextId: string) => unknown>).mockImplementation((kind: string) => kind === 'webgl' ? gl : null);
    let allocations = 0;
    vi.stubGlobal('AudioContext', class {
      state = 'running';
      destination = {};
      createGain(): GainNode {
        allocations += 1;
        if (stage === 'gain' && allocations === 2) throw new Error('Independent second gain allocation failure');
        return { connect: vi.fn(), disconnect, gain: { value: 1 } } as unknown as GainNode;
      }
      close = close;
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const view = render(<VideoTimelinePreview plan={{ duration: 0, clips: [] }} inputs={[]} cursor={0} playing={false} onCursorChange={vi.fn()} onPlayingChange={vi.fn()} />);
    expect(disconnect).toHaveBeenCalledTimes(stage === 'gain' ? 1 : 2);
    expect(close).toHaveBeenCalledOnce();
    if (stage === 'texture') {
      expect(deleteTexture).toHaveBeenCalledExactlyOnceWith(firstTexture);
      expect(deleteBuffer).toHaveBeenCalledOnce();
    }
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(stage === 'gain' ? 1 : 2);
    expect(close).toHaveBeenCalledOnce();
    expect(deleteTexture).toHaveBeenCalledTimes(stage === 'texture' ? 1 : 0);
  });
});

describe('the composite has the first clip frame and fits the other inside it (canvas design §4 transitions row; demo timeline-preview.tsx)', () => {
  const plan = { duration: 0, clips: [] };

  it('sizes the canvas to the first clip frame, a checkerboard behind it only when the output is transparent', () => {
    (vi.spyOn(HTMLCanvasElement.prototype, 'getContext') as unknown as MockInstance<(contextId: string) => unknown>).mockReturnValue(null);
    const view = render(<VideoTimelinePreview format={{ width: 1080, height: 1920, transparent: false }} plan={plan} inputs={[]} cursor={0} playing={false} onCursorChange={vi.fn()} onPlayingChange={vi.fn()} />);
    const canvas = view.container.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([1080, 1920]);
    expect(canvas.style.backgroundImage).toBe('');
    view.rerender(<VideoTimelinePreview format={{ width: 1080, height: 1920, transparent: true }} plan={plan} inputs={[]} cursor={0} playing={false} onCursorChange={vi.fn()} onPlayingChange={vi.fn()} />);
    expect(view.container.querySelector('canvas')!.style.backgroundImage).not.toBe('');
  });

  it.each([
    ['opaque', false],
    ['transparent', true],
  ])('scales a frame of another shape to fit, centred, with %s borders', (_name, transparent) => {
    const calls: unknown[][] = [];
    const context = new Proxy({}, { get: (_target, key) => (key === 'fillStyle' ? undefined : (...args: unknown[]) => { calls.push([key, ...args]); }), set: (_target, key, value) => { calls.push([key, value]); return true; } }) as CanvasRenderingContext2D;
    const frame = Object.assign(document.createElement('canvas'), { width: 1920, height: 1080 });
    drawFitted(context, frame, { width: 1080, height: 1920, transparent });
    const scaled = 1080 * 1080 / 1920;
    expect(calls).toEqual([
      ...(transparent ? [['clearRect', 0, 0, 1080, 1920]] : [['fillStyle', '#000'], ['fillRect', 0, 0, 1080, 1920]]),
      ['drawImage', frame, 0, (1920 - scaled) / 2, 1080, scaled],
    ]);
  });
});

describe('the failed preview offers Retry with its icon (demo timeline-preview.tsx)', () => {
  it('shows the RefreshCw icon on Retry', () => {
    (vi.spyOn(HTMLCanvasElement.prototype, 'getContext') as unknown as MockInstance<(contextId: string) => unknown>).mockReturnValue(null);
    vi.stubGlobal('AudioContext', class { close = vi.fn(); });
    const view = render(<VideoTimelinePreview plan={{ duration: 0, clips: [] }} inputs={[]} cursor={0} playing={false} onCursorChange={vi.fn()} onPlayingChange={vi.fn()} />);
    const retry = view.getByRole('button', { name: t('canvas.miniTool.videoUI.retryPreview') });
    expect(retry.querySelector('.lucide-refresh-cw')).not.toBeNull();
  });
});
