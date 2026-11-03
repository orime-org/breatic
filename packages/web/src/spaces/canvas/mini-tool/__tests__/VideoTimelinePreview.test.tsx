// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoTimelinePreview } from '../video/VideoTimelinePreview';
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
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind: string) => kind === '2d' ? context : null);
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
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind: string) => kind === 'webgl' ? gl : null);
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
