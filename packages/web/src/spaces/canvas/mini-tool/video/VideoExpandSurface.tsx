// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useTranslation } from '@web/i18n/use-translation';

/** The node owner's actual decoded surface, never a canonical URL. */
export interface VideoExpansionSurface {
  surface: CanvasImageSource;
  width: number;
  height: number;
  sourceEpoch: number;
  seekEpoch: number;
}
export interface VideoExpandSurfaceProps { source: VideoExpansionSurface; style: React.CSSProperties; onError?: () => void }

/**
 * Presents the same decoded source pixels inside the fixed expansion frame.
 * @param props - The actual decoded surface and its fixed display geometry.
 * @returns The displayed source canvas and any current pixel-read failure.
 * @throws {never} Surface failures are presented for recovery by the owner.
 */
export function VideoExpandSurface(props: VideoExpandSurfaceProps): React.JSX.Element {
  const { source, onError } = props;
  const { surface, width, height, sourceEpoch, seekEpoch } = source;
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = React.useState(false);
  const t = useTranslation();
  React.useEffect(() => {
    const context = canvas.current?.getContext('2d');
    let frame = 0;
    let active = true;
    setFailed(false);
    /**
     * Copies only the node owner's actual current pixels at their original dimensions.
     * @throws {never} Drawing failures become visible and stop this attachment.
     */
    function draw(): void {
      if (!active) return;
      try {
        if (context == null) throw new Error('Expansion source canvas unavailable');
        context.drawImage(surface, 0, 0, width, height);
        frame = requestAnimationFrame(draw);
      } catch {
        setFailed(true);
        onError?.();
      }
    }
    draw();
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [surface, width, height, sourceEpoch, seekEpoch, onError]);
  return <><canvas ref={canvas} width={width} height={height} style={props.style} className='absolute max-w-none cursor-default select-none' data-testid='mini-tool-expand-source' />{failed ? <span className='absolute rounded-chrome border border-status-error bg-popover px-2 py-1 text-xs text-status-error-foreground' style={props.style}>{t('canvas.miniTool.videoUI.mediaError')}</span> : null}</>;
}
