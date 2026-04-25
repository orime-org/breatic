/**
 * Low-zoom placeholder bars inside a node shell; bar count scales with available height.
 */
import React, { memo, useState, useLayoutEffect, useRef } from 'react';

/** Target height per bar (px); larger values yield fewer, taller bars. */
const barStep = 32;

const NodeSkeleton = memo(() => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [barCount, setBarCount] = useState(3);

  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const update = () => {
      const h = el.clientHeight - 24;
      if (h > 0) {
        const n = Math.max(1, Math.floor(h / barStep));
        setBarCount(n);
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={wrapperRef}
      className='flex w-full h-full flex-col justify-stretch gap-3 p-3'
      aria-hidden
    >
      {Array.from({ length: barCount }, (_, i) => (
        <div
          key={i}
          className='min-h-[10px] flex-1 rounded bg-[var(--color-background-default-secondary)]'
          style={{ width: i === barCount - 1 && barCount > 1 ? '70%' : i === 0 ? '100%' : '85%' }}
        />
      ))}
    </div>
  );
});

NodeSkeleton.displayName = 'NodeSkeleton';

export default NodeSkeleton;

const zoomThreshold = 0.3;

/** Returns true when the viewport zoom is high enough to render full node chrome. */
export const zoomLevelShowContentSelector = (s: { transform?: [number, number, number] }) =>
  (s.transform?.[2] ?? 1) >= zoomThreshold;
