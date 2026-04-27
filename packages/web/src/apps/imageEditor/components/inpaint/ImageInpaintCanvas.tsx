import React, { useCallback, useEffect, useRef } from 'react';
import { Canvas, FabricImage } from 'fabric';

type ImageInpaintCanvasProps = {
  src?: string;
  width: number;
  height: number;
  drawBackgroundOnCanvas?: boolean;
  drawLayerOpacity?: number;
  canvasFilter?: string;
  onImageReady?: (image: FabricImage) => Promise<void> | void;
  onCanvasReady?: (canvas: Canvas | null) => void;
};

const ImageInpaintCanvas: React.FC<ImageInpaintCanvasProps> = ({
  src,
  width,
  height,
  drawBackgroundOnCanvas = true,
  drawLayerOpacity = 1,
  canvasFilter,
  onImageReady,
  onCanvasReady,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);

  const ensureFabricCanvas = useCallback(
    (host: HTMLDivElement): Canvas => {
      if (fabricRef.current) return fabricRef.current;
      const el = document.createElement('canvas');
      host.appendChild(el);
      const fabricCanvas = new Canvas(el, {
        width: 1,
        height: 1,
        selection: false,
        preserveObjectStacking: true,
      });
      fabricRef.current = fabricCanvas;
      onCanvasReady?.(fabricCanvas);
      return fabricCanvas;
    },
    [onCanvasReady],
  );

  const renderBackgroundImage = useCallback(
    async (fabricCanvas: Canvas, imageSrc: string, currentRequestId: number): Promise<void> => {
      try {
        const cw = fabricCanvas.getWidth() || 1;
        const ch = fabricCanvas.getHeight() || 1;

        const sourceImage = await new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new window.Image();
          image.crossOrigin = 'anonymous';
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error('image load failed'));
          image.src = imageSrc;
        });

        if (!mountedRef.current || currentRequestId !== requestIdRef.current || !fabricRef.current) return;

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = cw;
        tempCanvas.height = ch;
        const tempCtx = tempCanvas.getContext('2d');
        if (!tempCtx) return;

        const iw = sourceImage.naturalWidth || sourceImage.width || 1;
        const ih = sourceImage.naturalHeight || sourceImage.height || 1;
        const scale = Math.max(cw / iw, ch / ih);
        const drawnW = iw * scale;
        const drawnH = ih * scale;
        const drawX = (cw - drawnW) / 2;
        const drawY = (ch - drawnH) / 2;

        tempCtx.filter = canvasFilter ?? 'none';
        tempCtx.drawImage(sourceImage, drawX, drawY, drawnW, drawnH);
        tempCtx.filter = 'none';

        const img = await FabricImage.fromURL(tempCanvas.toDataURL('image/png'), { crossOrigin: 'anonymous' });
        if (!mountedRef.current || currentRequestId !== requestIdRef.current || !fabricRef.current) return;
        await onImageReady?.(img);
        if (!mountedRef.current || currentRequestId !== requestIdRef.current || !fabricRef.current) return;
        img.set({
          left: cw / 2,
          top: ch / 2,
          originX: 'center',
          originY: 'center',
          selectable: false,
          evented: false,
          erasable: false,
        });

        fabricCanvas.clear();
        fabricCanvas.add(img);
        fabricCanvas.sendObjectToBack(img);
        fabricCanvas.requestRenderAll();
      } catch {
        // Keep canvas usable if image loading fails.
      }
    },
    [canvasFilter, onImageReady],
  );

  const cleanupCanvas = useCallback(
    (host?: HTMLDivElement | null): void => {
      mountedRef.current = false;
      onCanvasReady?.(null);
      if (fabricRef.current) {
        fabricRef.current.dispose();
        fabricRef.current = null;
      }
      if (host) host.replaceChildren();
    },
    [onCanvasReady],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    mountedRef.current = true;
    ensureFabricCanvas(host);

    return () => {
      cleanupCanvas(host);
    };
  }, [ensureFabricCanvas, cleanupCanvas]);

  useEffect(() => {
    const fabricCanvas = fabricRef.current;
    if (!fabricCanvas) return;
    requestIdRef.current += 1;
    const currentRequestId = requestIdRef.current;

    fabricCanvas.setDimensions({ width, height });
    const clampedOpacity = Math.max(0, Math.min(1, drawLayerOpacity));
    if (fabricCanvas.lowerCanvasEl) fabricCanvas.lowerCanvasEl.style.opacity = String(clampedOpacity);
    if (fabricCanvas.upperCanvasEl) fabricCanvas.upperCanvasEl.style.opacity = String(clampedOpacity);
    const effectiveCanvasFilter = canvasFilter ?? 'none';
    if (fabricCanvas.lowerCanvasEl) fabricCanvas.lowerCanvasEl.style.filter = effectiveCanvasFilter;
    if (fabricCanvas.upperCanvasEl) fabricCanvas.upperCanvasEl.style.filter = effectiveCanvasFilter;

    if (!src || !drawBackgroundOnCanvas) {
      fabricCanvas.clear();
      fabricCanvas.requestRenderAll();
      return;
    }

    void renderBackgroundImage(fabricCanvas, src, currentRequestId);
  }, [src, width, height, drawBackgroundOnCanvas, drawLayerOpacity, canvasFilter, renderBackgroundImage]);

  return (
    <div
      ref={hostRef}
      className='nodrag nopan block h-full w-full touch-none'
      style={{
        backgroundColor: '#ffffff',
        ...(drawBackgroundOnCanvas || !src
          ? {}
          : {
            backgroundImage: `url("${src}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }),
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    />
  );
};

export default ImageInpaintCanvas;
