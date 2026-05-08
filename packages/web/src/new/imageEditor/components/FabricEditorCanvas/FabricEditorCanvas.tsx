import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, FabricImage } from 'fabric';
import Loading from '@/app/shell/loading/Loading';

interface FabricEditorCanvasProps {
  imageSrc: string;
  onCanvasReady?: (canvas: Canvas | null) => void;
}

const FabricEditorCanvas: React.FC<FabricEditorCanvasProps> = ({ imageSrc, onCanvasReady }) => {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [shellSize, setShellSize] = useState({ width: 1, height: 1 });
  const [zoomFactor, setZoomFactor] = useState(1);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const htmlCanvas = canvasRef.current;
    if (!htmlCanvas) return;
    const editor = new Canvas(htmlCanvas, {
      selection: false,
      preserveObjectStacking: true,
      backgroundColor: '#f7f8fa',
    });
    fabricRef.current = editor;
    onCanvasReady?.(editor);
    return () => {
      onCanvasReady?.(null);
      fabricRef.current?.dispose();
      fabricRef.current = null;
    };
  }, [onCanvasReady]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const resize = () => {
      const rect = shell.getBoundingClientRect();
      setShellSize({
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoomFactor((prev) => {
        const next = event.deltaY < 0 ? prev * 1.08 : prev / 1.08;
        return Math.max(0.2, Math.min(6, next));
      });
    };

    shell.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      shell.removeEventListener('wheel', handleWheel);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      const editor = fabricRef.current;
      if (!editor || !imageSrc) return;
      setIsLoading(true);

      try {
        const image = await FabricImage.fromURL(imageSrc, { crossOrigin: 'anonymous' });
        if (cancelled) return;
        const imageWidth = image.width ?? 1;
        const imageHeight = image.height ?? 1;
        setImageSize({ width: imageWidth, height: imageHeight });
        setZoomFactor(1);

        editor.setDimensions({ width: imageWidth, height: imageHeight });

        image.set({
          left: 0,
          top: 0,
          originX: 'left',
          originY: 'top',
          selectable: false,
          evented: false,
        });
        image.scale(1);

        editor.clear();
        editor.backgroundColor = '#f7f8fa';
        editor.add(image);
        editor.requestRenderAll();
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void render();

    return () => {
      cancelled = true;
    };
  }, [imageSrc]);

  const fitScale = useMemo(
    () => Math.min(shellSize.width / imageSize.width, shellSize.height / imageSize.height),
    [shellSize.width, shellSize.height, imageSize.width, imageSize.height],
  );

  const displayScale = useMemo(
    () => Math.max(0.05, Math.min(8, fitScale * zoomFactor)),
    [fitScale, zoomFactor],
  );

  return (
    <div className='flex min-h-0 items-center justify-center bg-[#ffffff] p-3'>
      <div
        ref={shellRef}
        className='relative h-full w-full overflow-hidden bg-[#f0f2f6]'
      >
        {isLoading && (
          <div className='absolute inset-0 z-10'>
            <Loading
              inline
              width='100%'
              height='100%'
              scale={0.12}
              backgroundColor='rgba(247, 248, 250, 0.8)'
            />
          </div>
        )}
        <div className='flex h-full w-full items-center justify-center'>
          <div
            style={{
              transform: `scale(${displayScale})`,
              transformOrigin: 'center center',
            }}
          >
            <canvas ref={canvasRef} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default FabricEditorCanvas;
