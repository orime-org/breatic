import React, { useState, useRef, useEffect, memo, startTransition } from 'react';
import { flushSync } from 'react-dom';
import { useParams } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useVideoEditorStore } from '@/app/hooks/useVideoEditorStore';
import { useUserCenterStore } from '@/app/hooks/useUserCenterStore';
import TopBar from './components/header/TopBar';
import Toolbar from './components/leftPanel/Toolbar';
import LeftPanel from './components/leftPanel/LeftPanel';
import PreviewCanvas, { PreviewCanvasRef } from './components/preview/PreviewCanvas';
import { FullscreenPreview } from './components/preview/FullscreenPreview';
import PlaybackControls from './components/controls/PlaybackControls';
import TimelineEditor from './components/timeline/TimelineEditor';
import RightPanel from './components/rightPanel/RightPanel';
import HotkeysHandler from './components/preview/HotkeysHandler';
import { TimelineClip } from './types';

interface VideoEditorProps {
  clips?: TimelineClip[];
  canvasRatio?: string;
  scale?: number;
  currentTime?: number;
}

const VideoEditor: React.FC<VideoEditorProps> = ({
  clips: _initialClips,
  canvasRatio: initialCanvasRatio,
  scale: initialScale,
  currentTime: initialCurrentTime,
}) => {
  const { projectId: projectIdParam, nodeId: nodeIdParam } = useParams<{ projectId: string; nodeId: string }>();
  const projectId = projectIdParam ?? '';
  const nodeId = nodeIdParam ?? '';

  /** This route is local-dev only: no OSS / workflow calls from export or upload. */
  const standalone = true;

  const { setTheme } = useUserCenterStore();

  const {
    clips,
    setClips,
    setSelectedClipId,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useVideoEditorStore();

  const [currentTime, setCurrentTime] = useState(initialCurrentTime ?? 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [scale, setScale] = useState(initialScale ?? 8);
  const [activePanel, setActivePanel] = useState<string | null>('folder');
  const [canvasRatio, setCanvasRatio] = useState(initialCanvasRatio ?? '16:9');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isResizingTimelinePanel, setIsResizingTimelinePanel] = useState(false);

  const forceUpdateTextRef = useRef<(() => void) | null>(null);
  const previewCanvasRef = useRef<PreviewCanvasRef>(null);

  const initializeTheme = () => {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      setTheme(stored);
    } else {
      setTheme('system');
    }
  };

  useEffect(() => {
    startTransition(() => {
      initializeTheme();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isResizingTimelinePanel) return;

    const handlePointerUp = () => {
      setIsResizingTimelinePanel(false);
    };

    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isResizingTimelinePanel]);

  const actualDuration = clips.length > 0 ? Math.max(...clips.map((c) => c.end)) : 0;

  useEffect(() => {
    if (isPlaying) {
      const interval = setInterval(() => {
        setCurrentTime((prev) => {
          if (actualDuration <= 0) {
            setIsPlaying(false);
            return 0;
          }
          const nextTime = prev + 0.033;
          const playheadWidthTime = 2 / (scale * 50);
          const maxTime = Math.max(0, actualDuration - playheadWidthTime);
          if (nextTime >= maxTime) {
            setIsPlaying(false);
            return maxTime;
          }
          return nextTime;
        });
      }, 33);
      return () => clearInterval(interval);
    }
  }, [isPlaying, actualDuration, scale]);

  const getBaseCanvasSize = (ratio: string): { width: number; height: number } => {
    switch (ratio) {
      case '16:9':
        return { width: 1920, height: 1080 };
      case '9:16':
        return { width: 1080, height: 1920 };
      case '1:1':
        return { width: 1080, height: 1080 };
      default:
        return { width: 1920, height: 1080 };
    }
  };

  const handleResizeChange = (ratio: string) => {
    setSelectedClipId([]);
    const oldBaseSize = getBaseCanvasSize(canvasRatio);
    const newBaseSize = getBaseCanvasSize(ratio);
    const convertedClips = clips.map((clip: TimelineClip) => {
      if (clip.x === undefined && clip.y === undefined) {
        return clip;
      }
      const centerX = (clip.x ?? 0) + (clip.width ?? 0) / 2;
      const centerY = (clip.y ?? 0) + (clip.height ?? 0) / 2;

      const relativeCenterX = centerX / oldBaseSize.width;
      const relativeCenterY = centerY / oldBaseSize.height;

      const newCenterX = relativeCenterX * newBaseSize.width;
      const newCenterY = relativeCenterY * newBaseSize.height;

      const width = clip.width ?? 100;
      const height = clip.height ?? 100;

      let newX = newCenterX - width / 2;
      let newY = newCenterY - height / 2;

      newX = Math.max(0, Math.min(newX, newBaseSize.width - width));
      newY = Math.max(0, Math.min(newY, newBaseSize.height - height));

      return {
        ...clip,
        x: newX,
        y: newY,
      };
    });

    setClips(convertedClips);
    flushSync(() => {
      setCanvasRatio(ratio);
    });
    previewCanvasRef.current?.centerCanvas();
  };

  return (
    <div className='flex flex-col h-full bg-gray-50 w-screen h-screen'>
      <HotkeysHandler
        nodeId={nodeId}
        currentTime={currentTime}
        onPlayPause={() => setIsPlaying(!isPlaying)}
        onTimeChange={setCurrentTime}
        undo={undo}
        redo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
      />
      <TopBar
        canvasRatio={canvasRatio}
        onRatioChange={handleResizeChange}
        currentTime={currentTime}
        nodeId={nodeId}
        projectId={projectId}
        exportStandalone={standalone}
      />
      <div className='flex flex-1 overflow-hidden'>
        <Group orientation='vertical' className='flex-1 min-h-0 flex flex-col'>
          <Panel defaultSize={70} minSize={30}>
            <div className='flex h-full overflow-hidden'>
              <div className='flex'>
                <Toolbar
                  activePanel={activePanel}
                  onPanelChange={(panelId: string) => setActivePanel(panelId)}
                />
                <LeftPanel
                  activePanel={activePanel}
                  nodeId={nodeId}
                  projectId={projectId}
                  currentTime={currentTime}
                  canvasRatio={canvasRatio}
                  getBaseCanvasSize={getBaseCanvasSize}
                />
              </div>

              <div className='flex-1 overflow-hidden'>
                <PreviewCanvas
                  ref={previewCanvasRef}
                  nodeId={nodeId}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  canvasRatio={canvasRatio}
                  forceUpdateTextRef={forceUpdateTextRef}
                  isFullscreen={false}
                />
              </div>
            </div>
          </Panel>

          <Separator
            className='h-px bg-gray-300 hover:bg-blue-400 data-[resize-handle-state=drag]:bg-blue-500 cursor-row-resize shrink-0 transition-colors focus-visible:outline-none'
            onPointerDown={() => setIsResizingTimelinePanel(true)}
          />

          <Panel defaultSize={30} minSize={20} className='flex flex-col'>
            <PlaybackControls
              nodeId={nodeId}
              currentTime={currentTime}
              isPlaying={isPlaying}
              scale={scale}
              onTimeChange={setCurrentTime}
              onPlayPause={() => setIsPlaying(!isPlaying)}
              onScaleChange={setScale}
              onFullscreen={() => setIsFullscreen(true)}
              onReset={() => setCurrentTime(0)}
              undo={undo}
              redo={redo}
              canUndo={canUndo}
              canRedo={canRedo}
            />

            <div
              className='flex-1 overflow-hidden'
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  setSelectedClipId([]);
                }
              }}
            >
              <TimelineEditor
                reactflowScale={1.0}
                currentTime={currentTime}
                scale={scale}
                onTimeChange={setCurrentTime}
                nodeId={nodeId}
                disableBoxSelect={isResizingTimelinePanel}
              />
            </div>
          </Panel>
        </Group>

        <RightPanel nodeId={nodeId} fontConfig={[]} />
      </div>
      <FullscreenPreview
        visible={isFullscreen}
        currentTime={currentTime}
        isPlaying={isPlaying}
        canvasRatio={canvasRatio}
        onClose={() => setIsFullscreen(false)}
        onPlayPause={() => setIsPlaying(!isPlaying)}
        onTimeChange={setCurrentTime}
        forceUpdateTextRef={forceUpdateTextRef}
        nodeId={nodeId}
      />
    </div>
  );
};

export default memo(VideoEditor);
