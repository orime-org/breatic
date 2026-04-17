import React, { useCallback, useMemo } from 'react';
import type { Node } from '@xyflow/react';
import { nanoid } from 'nanoid';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useUpstreamExternalFileList, type UpstreamExternalFileItem } from '@/hooks/useUpstreamExternalFileList';
import type { AgentComposerUploadItem } from '@/components/base/agent/AgentComposerTabs';
import { getProjectCanvasViewportApi, type CanvasWorkflowNodeData } from '@/apps/project/components/canvas/types';
import { message } from '@/components/base/message';
import RightToolbar from '../../ui/RightToolbar';
import {
  createEditorAudioNodeData,
  createEditorImageNodeData,
  createEditorVideoNodeData,
  imageEditorAudioNodeType,
  imageEditorImageNodeType,
  imageEditorVideoNodeType,
  type EditorTool,
  type ImageEditorRightSidePanelId,
  type ImageFlowNodeData,
} from '../../types';
import type { MediaResourceListItem } from '../../ui/MediaResourceListPanel';

type ImageSidePanelProps = {
  nodeId: string;
  mediaType?: 'image' | 'video' | 'audio';
  hidden?: boolean;
  activeTool: EditorTool;
  setActiveTool: (tool: EditorTool) => void;
  nodes: Node[];
  setNodes: (nodes: Node[]) => void;
  importImagesFromFiles: (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => Promise<void>;
  importVideosFromFiles: (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => Promise<void>;
  importAudiosFromFiles: (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => Promise<void>;
  favoriteAssets: Array<{
    id: string;
    previewUrl: string;
    name?: string;
    sourcePanel?: ImageEditorRightSidePanelId;
    sourceItemId?: string;
  }>;
  toggleFavoriteAsset: (payload: { panel: ImageEditorRightSidePanelId; item: MediaResourceListItem }) => void;
  flowInteractionRootRef: React.RefObject<HTMLDivElement | null>;
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
};

const imageEditorPlaceNodeWidth = 260;
const imageEditorPlaceNodeHeight = 160;
const audioEditorPlaceNodeWidth = 300;
const audioEditorPlaceNodeHeight = 250;

const ImageSidePanel: React.FC<ImageSidePanelProps> = ({
  nodeId,
  mediaType = 'image',
  hidden = false,
  activeTool,
  setActiveTool,
  nodes,
  setNodes,
  importImagesFromFiles,
  importVideosFromFiles,
  importAudiosFromFiles,
  favoriteAssets,
  toggleFavoriteAsset,
  flowInteractionRootRef,
  screenToFlowPosition,
}) => {
  const { nodes: projectNodes, edges: projectEdges } = useCanvasData();
  const projectCanvasUpstream = useUpstreamExternalFileList(projectNodes, projectEdges, nodeId);

  const isVideoMode = mediaType === 'video';
  const isAudioMode = mediaType === 'audio';

  const handleUpload = useCallback(
    (file: File) => {
      const el = flowInteractionRootRef.current;
      if (!el) {
        if (isAudioMode) {
          void importAudiosFromFiles([file]);
        } else if (isVideoMode) {
          void importVideosFromFiles([file]);
        } else {
          void importImagesFromFiles([file]);
        }
        return;
      }
      const rect = el.getBoundingClientRect();
      const viewportCenterFlow = screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      if (isAudioMode) {
        void importAudiosFromFiles([file], { viewportCenterFlow });
      } else if (isVideoMode) {
        void importVideosFromFiles([file], { viewportCenterFlow });
      } else {
        void importImagesFromFiles([file], { viewportCenterFlow });
      }
    },
    [
      flowInteractionRootRef,
      importAudiosFromFiles,
      importImagesFromFiles,
      importVideosFromFiles,
      isAudioMode,
      isVideoMode,
      screenToFlowPosition,
    ],
  );

  const sidePanelItems = useMemo((): Partial<Record<ImageEditorRightSidePanelId, MediaResourceListItem[]>> => {
    const targetNodeType = isAudioMode
      ? imageEditorAudioNodeType
      : isVideoMode
        ? imageEditorVideoNodeType
        : imageEditorImageNodeType;
    const targetAttachType = isAudioMode ? 'audio' : isVideoMode ? 'video' : 'image';
    const history: MediaResourceListItem[] = nodes
      .filter((n) => n.type === targetNodeType)
      .map((n) => {
        const data = n.data as ImageFlowNodeData;
        return {
          id: n.id,
          name: data.name,
          previewUrl: data.content,
        };
      });

    const canvasNode = projectNodes.find((n) => n.id === nodeId);
    const canvasData = canvasNode?.data as Partial<CanvasWorkflowNodeData> | undefined;
    const rawAttach = canvasData?.attach;
    const canvasAttach = (Array.isArray(rawAttach) ? rawAttach : []) as AgentComposerUploadItem[];
    const canvasMediaAttach = canvasAttach.filter((item) => item.type === targetAttachType);
    const upstreamMedia = projectCanvasUpstream.filter((item) => item.type === targetAttachType);

    const assets: MediaResourceListItem[] = favoriteAssets.map((item) => ({
      id: item.id,
      previewUrl: item.previewUrl,
      name: item.name,
    }));

    return {
      history,
      assets,
      attach: canvasMediaAttach.map((item) => ({
        id: item.id,
        previewUrl: item.previewUrl ?? '',
        name: item.name,
      })),
      link: upstreamMedia.map((item: UpstreamExternalFileItem) => ({
        id: item.uid,
        previewUrl: item.content ?? '',
        name: item.name,
      })),
    };
  }, [favoriteAssets, isAudioMode, isVideoMode, nodeId, nodes, projectCanvasUpstream, projectNodes]);

  const addMediaItemAtCenter = useCallback(
    (item: MediaResourceListItem) => {
      if (!item.previewUrl?.trim()) {
        message.warning('Nothing to add to the image editor');
        return;
      }

      const content = item.previewUrl.trim();
      const placeWidth = isAudioMode ? audioEditorPlaceNodeWidth : imageEditorPlaceNodeWidth;
      const placeHeight = isAudioMode ? audioEditorPlaceNodeHeight : imageEditorPlaceNodeHeight;
      const el = flowInteractionRootRef.current;
      let viewportCenterFlow: { x: number; y: number };
      if (el) {
        const rect = el.getBoundingClientRect();
        viewportCenterFlow = screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
      } else {
        viewportCenterFlow = { x: 120, y: 80 };
      }

      const newNode: Node = {
        id: `${isAudioMode ? 'audio' : isVideoMode ? 'video' : 'image'}-flow-${nanoid(12)}`,
        type: isAudioMode ? imageEditorAudioNodeType : isVideoMode ? imageEditorVideoNodeType : imageEditorImageNodeType,
        position: {
          x: viewportCenterFlow.x - placeWidth / 2,
          y: viewportCenterFlow.y - placeHeight / 2,
        },
        selected: true,
        style: { width: placeWidth, height: placeHeight },
        data: isAudioMode
          ? createEditorAudioNodeData(item.name?.trim() || 'audio', content)
          : isVideoMode
            ? createEditorVideoNodeData(item.name?.trim() || 'video', content)
            : createEditorImageNodeData(item.name?.trim() || 'image', content),
      };

      setNodes([...nodes.map((n) => ({ ...n, selected: false })), newNode]);
    },
    [flowInteractionRootRef, isAudioMode, isVideoMode, nodes, screenToFlowPosition, setNodes],
  );

  const handleSidePanelItemAdd = useCallback(
    (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => {
      if (panel === 'history' || panel === 'attach' || panel === 'link' || panel === 'assets') {
        addMediaItemAtCenter(item);
      }
    },
    [addMediaItemAtCenter],
  );

  const isSidePanelItemFavorited = useCallback(
    (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => {
      if (panel === 'assets') {
        return favoriteAssets.some((f) => f.id === item.id);
      }
      return favoriteAssets.some((f) => f.sourcePanel === panel && f.sourceItemId === item.id);
    },
    [favoriteAssets],
  );

  const handleSidePanelItemFavoriteClick = useCallback(
    (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => {
      toggleFavoriteAsset({ panel, item });
    },
    [toggleFavoriteAsset],
  );

  const handleUpstreamPanelOpen = useCallback(() => {
    const api = getProjectCanvasViewportApi();
    if (!api) return;
    api.centerOnFirstNodeId([nodeId], true);
  }, [nodeId]);

  const handleSidePanelItemDownload = useCallback(
    async (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => {
      if (panel !== 'history' && panel !== 'attach' && panel !== 'link' && panel !== 'assets') return;
      const url = item.previewUrl;
      if (!url) {
        message.warning('No content to download');
        return;
      }
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) throw new Error(res.statusText);
        const blob = await res.blob();
        const fromUrl = url.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1];
        const ext = fromUrl && fromUrl.length <= 5 ? fromUrl : 'jpg';
        const base = (item.name ?? `asset-${Date.now()}`).replace(/[<>:"/\\|?*]/g, '_');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = base.includes('.') ? base : `${base}.${ext}`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (err) {
        console.error('Download failed:', err);
        message.warning('Download failed');
      }
    },
    [],
  );

  if (hidden) return null;

  return (
    <div className='pointer-events-none absolute inset-y-0 right-3 z-10 flex h-full min-h-0 justify-end'>
      <RightToolbar
        activeTool={activeTool}
        onToolChange={setActiveTool}
        onUpload={handleUpload}
        uploadAccept={isAudioMode ? 'audio/*' : isVideoMode ? 'video/*' : 'image/*'}
        sidePanelItems={sidePanelItems}
        onSidePanelItemAddClick={handleSidePanelItemAdd}
        onSidePanelItemDownloadClick={handleSidePanelItemDownload}
        isSidePanelItemFavorited={isSidePanelItemFavorited}
        onSidePanelItemFavoriteClick={handleSidePanelItemFavoriteClick}
        onUpstreamPanelOpen={handleUpstreamPanelOpen}
      />
    </div>
  );
};

export default ImageSidePanel;
