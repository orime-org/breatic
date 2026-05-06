import { memo, useEffect, useState, type FC, type ReactNode } from 'react';

/**
 * Duration for mock “output pending” on spawned nodes (generator send).
 * Keep in sync with the `setTimeout` that clears {@link LocalCanvasNodeData.localOutputPending}.
 */
export const CANVAS_OUTPUT_PENDING_MS = 3000 as const;

export type CanvasOutputPendingProgressOverlayProps = {
  /** Animation length in ms; defaults to {@link CANVAS_OUTPUT_PENDING_MS}. */
  durationMs?: number;
  /**
   * When set (0–100), bar width follows this value instead of the internal timed animation
   * (e.g. mini-tool task polling on the local canvas).
   */
  progressPct?: number | null;
  /** Optional center content (e.g. faint placeholder icon). */
  children?: ReactNode;
};

/**
 * Full-bleed progress fill (left → right) for canvas output nodes while `localOutputPending` is true.
 * Theme-aware translucent base (not a near-black veil) plus a vertical silver gradient on the growing bar,
 * clipped by the parent’s rounded rect.
 */
const CanvasOutputPendingProgressOverlay: FC<CanvasOutputPendingProgressOverlayProps> = ({
  durationMs = CANVAS_OUTPUT_PENDING_MS,
  progressPct: controlledPct,
  children,
}) => {
  const [internalPct, setInternalPct] = useState(0);
  const isControlled = typeof controlledPct === 'number' && !Number.isNaN(controlledPct);

  useEffect(() => {
    if (isControlled) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setInternalPct(t * 100);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [durationMs, isControlled]);

  const barWidthPct = isControlled ? Math.min(100, Math.max(0, controlledPct)) : internalPct;

  return (
    <div className='pointer-events-none absolute inset-0 z-[25] flex items-center justify-center overflow-hidden rounded-[inherit]'>
      <div
        className='absolute inset-0 rounded-[inherit] bg-background-default-base/72 backdrop-blur-[2px]'
        aria-hidden
      />
      <div
        className='absolute left-0 top-0 h-full min-w-0'
        style={{
          width: `${barWidthPct}%`,
          background:
            'linear-gradient(180deg, rgba(236,238,242,0.55) 0%, rgba(130,138,150,0.45) 48%, rgba(118,126,136,0.5) 52%, rgba(228,230,235,0.5) 100%)',
          boxShadow: '6px 0 18px -6px rgba(255,255,255,0.22)',
        }}
        aria-hidden
      />
      {children ? <div className='relative z-[1] flex items-center justify-center opacity-[0.38]'>{children}</div> : null}
    </div>
  );
};

export default memo(CanvasOutputPendingProgressOverlay);
