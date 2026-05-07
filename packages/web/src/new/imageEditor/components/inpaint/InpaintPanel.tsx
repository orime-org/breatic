import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from 'fabric';
import ImageInpaintCanvas from './ImageInpaintCanvas';
import InpaintBottomToolbar from './InpaintBottomToolbar';

type InpaintPanelProps = {
  imageSrc: string;
  onApply: (nextImageSrc: string) => void;
};

const InpaintPanel: React.FC<InpaintPanelProps> = ({ imageSrc, onApply }) => {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [sessionId, setSessionId] = useState(0);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    const updateSize = () => {
      const rect = host.getBoundingClientRect();
      setCanvasSize({
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const handleClose = (nextImageSrc?: string) => {
    if (nextImageSrc) {
      onApply(nextImageSrc);
    }
    setSessionId((prev) => prev + 1);
  };

  const canvasKey = useMemo(() => `${sessionId}-${imageSrc}`, [sessionId, imageSrc]);

  return (
    <div className='flex h-full min-h-0 flex-col gap-3'>
      <div ref={canvasHostRef} className='min-h-0 flex-1 overflow-hidden rounded-xl border border-[#e0e4ea] bg-[#eef1f5] p-2'>
        <ImageInpaintCanvas
          key={canvasKey}
          src={imageSrc}
          width={canvasSize.width}
          height={canvasSize.height}
          drawBackgroundOnCanvas={false}
          onCanvasReady={setCanvas}
        />
      </div>
      <InpaintBottomToolbar canvas={canvas} active baseImageSrc={imageSrc} onClose={handleClose} />
    </div>
  );
};

export default InpaintPanel;
