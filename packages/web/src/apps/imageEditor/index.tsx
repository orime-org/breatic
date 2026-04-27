import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from 'fabric';
import { useParams } from 'react-router-dom';
import { Icon } from '@/components/base/icon';
import Loading from '@/components/loading/Loading';
import LeftHistoryPanel from './components/LeftHistoryPanel/LeftHistoryPanel';
import RightToolPanel from './components/RightToolPanel/RightToolPanel';
import ImageInpaintCanvas from './components/inpaint/ImageInpaintCanvas';
import InpaintBottomToolbar from './components/inpaint/InpaintBottomToolbar';

type ImageEditorPageProps = {
  nodeId?: string;
};

const ImageEditorPage: React.FC<ImageEditorPageProps> = ({ nodeId: nodeIdProp }) => {
  const params = useParams<'projectId' | 'nodeId'>();
  const nodeId = nodeIdProp ?? params.nodeId ?? '';
  const [activeHistoryIndex, setActiveHistoryIndex] = useState(0);
  const [baseImageSrc] = useState('https://picsum.photos/1080/1680?random=48');
  const [imageSrc, setImageSrc] = useState('https://picsum.photos/1080/1680?random=48');
  const [editorCanvas, setEditorCanvas] = useState<Canvas | null>(null);
  const [inpaintSessionId, setInpaintSessionId] = useState(0);
  const canvasShellRef = useRef<HTMLDivElement | null>(null);
  const [shellSize, setShellSize] = useState({ width: 1, height: 1 });
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [imageLoading, setImageLoading] = useState(true);
  const [zoomFactor, setZoomFactor] = useState(1);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const restoringRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const historyList = useMemo(
    () => [
      baseImageSrc,
      `${baseImageSrc}&grayscale=1`,
      `${baseImageSrc}&blur=1`,
      `${baseImageSrc}&grayscale=1&blur=1`,
      `${baseImageSrc}&blur=2`,
    ],
    [baseImageSrc],
  );

  useEffect(() => {
    const shell = canvasShellRef.current;
    if (!shell) return;
    const updateSize = () => {
      const rect = shell.getBoundingClientRect();
      setShellSize({
        width: Math.max(1, Math.floor(rect.width)),
        height: Math.max(1, Math.floor(rect.height)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const shell = canvasShellRef.current;
    if (!shell) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoomFactor((prev) => {
        const next = event.deltaY < 0 ? prev * 1.08 : prev / 1.08;
        return Math.max(0.2, Math.min(6, next));
      });
    };
    shell.addEventListener('wheel', handleWheel, { passive: false });
    return () => shell.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setImageLoading(true);
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (cancelled) return;
      setImageSize({
        width: Math.max(1, image.naturalWidth || image.width || 1),
        height: Math.max(1, image.naturalHeight || image.height || 1),
      });
      setZoomFactor(1);
      setImageLoading(false);
    };
    image.onerror = () => {
      if (cancelled) return;
      setImageSize(null);
      setImageLoading(false);
    };
    image.src = imageSrc;
    return () => {
      cancelled = true;
    };
  }, [imageSrc]);

  const fitScale = useMemo(() => {
    if (!imageSize) return 1;
    return Math.min(shellSize.width / imageSize.width, shellSize.height / imageSize.height);
  }, [shellSize.width, shellSize.height, imageSize]);

  const displayScale = useMemo(() => Math.max(0.05, Math.min(8, fitScale * zoomFactor)), [fitScale, zoomFactor]);

  const updateHistoryAvailability = useCallback(() => {
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(historyIndexRef.current >= 0 && historyIndexRef.current < historyRef.current.length - 1);
  }, []);

  const pushCanvasSnapshot = useCallback(
    (canvas: Canvas) => {
      if (restoringRef.current) return;
      const snapshot = JSON.stringify(canvas.toDatalessJSON());
      const current = historyRef.current[historyIndexRef.current];
      if (snapshot === current) return;
      const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
      nextHistory.push(snapshot);
      historyRef.current = nextHistory;
      historyIndexRef.current = nextHistory.length - 1;
      updateHistoryAvailability();
    },
    [updateHistoryAvailability],
  );

  const applyCanvasSnapshot = useCallback(
    async (canvas: Canvas, targetIndex: number) => {
      const snapshot = historyRef.current[targetIndex];
      if (!snapshot) return;
      restoringRef.current = true;
      try {
        const parsed = JSON.parse(snapshot);
        const loadResult = canvas.loadFromJSON(parsed);
        if (loadResult instanceof Promise) {
          await loadResult;
        }
        canvas.requestRenderAll();
        historyIndexRef.current = targetIndex;
      } finally {
        restoringRef.current = false;
        updateHistoryAvailability();
      }
    },
    [updateHistoryAvailability],
  );

  const handleUndo = useCallback(() => {
    if (!editorCanvas || historyIndexRef.current <= 0) return;
    void applyCanvasSnapshot(editorCanvas, historyIndexRef.current - 1);
  }, [editorCanvas, applyCanvasSnapshot]);

  const handleRedo = useCallback(() => {
    if (!editorCanvas || historyIndexRef.current >= historyRef.current.length - 1) return;
    void applyCanvasSnapshot(editorCanvas, historyIndexRef.current + 1);
  }, [editorCanvas, applyCanvasSnapshot]);

  useEffect(() => {
    if (!editorCanvas) {
      historyRef.current = [];
      historyIndexRef.current = -1;
      updateHistoryAvailability();
      return;
    }

    const handleCanvasChanged = () => pushCanvasSnapshot(editorCanvas);

    editorCanvas.on('object:added', handleCanvasChanged);
    editorCanvas.on('object:modified', handleCanvasChanged);
    editorCanvas.on('object:removed', handleCanvasChanged);
    editorCanvas.on('path:created', handleCanvasChanged);

    pushCanvasSnapshot(editorCanvas);

    return () => {
      editorCanvas.off('object:added', handleCanvasChanged);
      editorCanvas.off('object:modified', handleCanvasChanged);
      editorCanvas.off('object:removed', handleCanvasChanged);
      editorCanvas.off('path:created', handleCanvasChanged);
    };
  }, [editorCanvas, pushCanvasSnapshot, updateHistoryAvailability]);

  if (!nodeId) {
    return (
      <div className='flex h-full w-full min-h-0 min-w-0 items-center justify-center bg-[#f3f4f6] text-sm text-[#6b7280]'>
        Missing node id
      </div>
    );
  }

  return (
    <div className='flex h-full w-full min-h-0 min-w-0 flex-col bg-[#f2f3f5]'>
      <div className='flex min-h-0 flex-1 flex-col rounded-xl border border-[#e6e8ec] bg-background-default-secondary'>
        <div className='grid min-h-0 flex-1 grid-cols-[200px_minmax(0,1fr)_64px] divide-x divide-[#e6e8ec]'>
          <LeftHistoryPanel
            historyList={historyList}
            activeIndex={activeHistoryIndex}
            onSelect={(idx, src) => {
              setActiveHistoryIndex(idx);
              setImageSrc(src);
            }}
          />

          <div className='flex min-h-0 items-center justify-center bg-background-default-secondary p-3'>
            <div ref={canvasShellRef} className='relative h-full w-full overflow-hidden'>
              {imageSize ? (
                <div className='flex h-full w-full items-center justify-center'>
                  <div
                    style={{
                      transform: `scale(${displayScale})`,
                      transformOrigin: 'center center',
                    }}
                  >
                    <ImageInpaintCanvas
                      key={`${inpaintSessionId}`}
                      src={imageSrc}
                      width={imageSize.width}
                      height={imageSize.height}
                      drawBackgroundOnCanvas={false}
                      drawLayerOpacity={0.55}
                      onCanvasReady={setEditorCanvas}
                    />
                  </div>
                </div>
              ) : (
                <div className='flex h-full w-full items-center justify-center' />
              )}
              {imageLoading && (
                <div className='pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[#f0f2f666]'>
                  <Loading inline width='100%' height='100%' backgroundColor='transparent' scale={0.20} />
                </div>
              )}
              <div className='pointer-events-none absolute bottom-3 right-3 z-10'>
                <div className='pointer-events-auto flex items-center gap-1 rounded-md border border-[#d7dce3] bg-background-default-secondary p-1 shadow-[0_1px_3px_rgba(0,0,0,0.08)] backdrop-blur-sm'>
                  <button
                    type='button'
                    aria-label='Undo'
                    disabled={!canUndo}
                    onClick={handleUndo}
                    className='flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-40'
                  >
                    <Icon name='videoEditor-undo-icon' width={14} height={14} color='var(--color-icon-secondary)' />
                  </button>
                  <button
                    type='button'
                    aria-label='Redo'
                    disabled={!canRedo}
                    onClick={handleRedo}
                    className='flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-40'
                  >
                    <Icon name='videoEditor-redo-icon' width={14} height={14} color='var(--color-icon-secondary)' />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <RightToolPanel />
        </div>

        <div className='h-[250px] border-t border-[#e6e8ec] bg-background-default-secondary px-3 pb-3 pt-0'>
          <InpaintBottomToolbar
            canvas={editorCanvas}
            active
            baseImageSrc={imageSrc}
            onClose={(nextImageSrc) => {
              if (nextImageSrc) setImageSrc(nextImageSrc);
              setInpaintSessionId((prev) => prev + 1);
            }}
          />
        </div>
      </div>
    </div>
  );
};

export default ImageEditorPage;

