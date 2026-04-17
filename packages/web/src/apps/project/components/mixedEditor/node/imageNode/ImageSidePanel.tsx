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
  createEditorImageNodeData,
  imageEditorImageNodeType,
  type EditorTool,
  type ImageEditorRightSidePanelId,
  type ImageFlowNodeData,
} from '../../types';
import type { MediaResourceListItem } from '../../ui/MediaResourceListPanel';

type ImageSidePanelProps = {
  nodeId: string;
  hidden?: boolean;
  activeTool: EditorTool;
  setActiveTool: (tool: EditorTool) => void;
  nodes: Node[];
  setNodes: (nodes: Node[]) => void;
  importImagesFromFiles: (files: File[], options?: { viewportCenterFlow: { x: number; y: number } }) => Promise<void>;
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

const ImageSidePanel: React.FC<ImageSidePanelProps> = ({
  nodeId,
  hidden = false,
  activeTool,
  setActiveTool,
  nodes,
  setNodes,
  importImagesFromFiles,
  favoriteAssets,
  toggleFavoriteAsset,
  flowInteractionRootRef,
  screenToFlowPosition,
}) => {
  const { nodes: projectNodes, edges: projectEdges } = useCanvasData();
  const projectCanvasUpstream = useUpstreamExternalFileList(projectNodes, projectEdges, nodeId);

  const handleUpload = useCallback(
    (file: File) => {
      const el = flowInteractionRootRef.current;
      if (!el) {
        void importImagesFromFiles([file]);
        return;
      }
      const rect = el.getBoundingClientRect();
      const viewportCenterFlow = screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      void importImagesFromFiles([file], { viewportCenterFlow });
    },
    [flowInteractionRootRef, importImagesFromFiles, screenToFlowPosition],
  );

  const sidePanelItems = useMemo((): Partial<Record<ImageEditorRightSidePanelId, MediaResourceListItem[]>> => {
    const history: MediaResourceListItem[] = nodes
      .filter((n) => n.type === imageEditorImageNodeType)
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
    const canvasImageAttach = canvasAttach.filter((item) => item.type === 'image');
    const upstreamImages = projectCanvasUpstream.filter((item) => item.type === 'image');

    const assets: MediaResourceListItem[] = favoriteAssets.map((item) => ({
      id: item.id,
      previewUrl: item.previewUrl,
      name: item.name,
    }));

    return {
      history,
      assets,
      attach: canvasImageAttach.map((item) => ({
        id: item.id,
        previewUrl: item.previewUrl ?? '',
        name: item.name,
      })),
      link: upstreamImages.map((item: UpstreamExternalFileItem) => ({
        id: item.uid,
        previewUrl: item.content ?? '',
        name: item.name,
      })),
    };
  }, [favoriteAssets, nodeId, nodes, projectCanvasUpstream, projectNodes]);

  const addMediaItemAtCenter = useCallback(
    (item: MediaResourceListItem) => {
      if (!item.previewUrl?.trim()) {
        message.warning('Nothing to add to the image editor');
        return;
      }

      const content = item.previewUrl.trim();
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
        id: `image-flow-${nanoid(12)}`,
        type: imageEditorImageNodeType,
        position: {
          x: viewportCenterFlow.x - imageEditorPlaceNodeWidth / 2,
          y: viewportCenterFlow.y - imageEditorPlaceNodeHeight / 2,
        },
        selected: true,
        style: { width: imageEditorPlaceNodeWidth, height: imageEditorPlaceNodeHeight },
        data: createEditorImageNodeData(item.name?.trim() || 'image', content),
      };

      setNodes([...nodes.map((n) => ({ ...n, selected: false })), newNode]);
    },
    [flowInteractionRootRef, nodes, screenToFlowPosition, setNodes],
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
