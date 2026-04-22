import React, { memo, useCallback, useState } from 'react';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import Divider from '@/components/base/divider';
import Upload, { type UploadFile } from '@/components/base/upload';
import MediaResourceListPanel, { type MediaResourceListItem } from './MediaResourceListPanel';
import type { EditorTool, ImageEditorRightSidePanelId } from '../types';

type RightToolbarProps = {
  activeTool: EditorTool;
  onToolChange: (tool: EditorTool) => void;
  onUpload?: (file: File) => void;
  uploadAccept?: string;
  /** Per-panel list rows; only panels with keys present need data. */
  sidePanelItems?: Partial<Record<ImageEditorRightSidePanelId, MediaResourceListItem[]>>;
  onSidePanelItemAddClick?: (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => void;
  onSidePanelItemDownloadClick?: (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => void;
  isSidePanelItemFavorited?: (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => boolean;
  onSidePanelItemFavoriteClick?: (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => void;
  /** Called when the Upstream (`link`) side panel opens so the main canvas can focus related nodes. */
  onUpstreamPanelOpen?: () => void;
};

interface ToolItem {
  key?: EditorTool;
  /** Opens / toggles this flyout to the left of the toolbar. */
  sidePanel?: ImageEditorRightSidePanelId;
  id: string;
  icon: string;
  label: string;
  width?: number;
  height?: number;
}

const panelConfig: Record<
  ImageEditorRightSidePanelId,
  { title: string; emptyText: string; showStatusDot?: boolean }
> = {
  history: { title: 'History', emptyText: 'No images yet', showStatusDot: true },
  assets: { title: 'Assets', emptyText: 'No assets yet' },
  attach: { title: 'Attachments', emptyText: 'No attachments yet' },
  link: { title: 'Upstream', emptyText: 'No Upstream yet' },
};

/** Mutually exclusive toolbar segment: history / assert / attatch / location — only one highlighted at a time. */
type ExclusiveToolbarSegment = 'history' | 'assert' | 'attatch' | 'location';

const exclusiveSegmentIds = new Set<string>(['history', 'assert', 'attatch', 'location']);

const RightToolbar: React.FC<RightToolbarProps> = ({
  activeTool,
  onToolChange,
  onUpload,
  uploadAccept = 'image/*',
  sidePanelItems = {},
  onSidePanelItemAddClick,
  onSidePanelItemDownloadClick,
  isSidePanelItemFavorited,
  onSidePanelItemFavoriteClick,
  onUpstreamPanelOpen,
}) => {
  const [openSidePanel, setOpenSidePanel] = useState<ImageEditorRightSidePanelId | null>(null);
  const [toolbarSegment, setToolbarSegment] = useState<ExclusiveToolbarSegment | null>(null);

  const isToolActive = (tool?: EditorTool) => !!tool && activeTool === tool && tool !== 'select';

  const isSidePanelButtonActive = (tool: ToolItem) => {
    if (exclusiveSegmentIds.has(tool.id)) return toolbarSegment === tool.id;
    if (tool.id === 'upstream') return openSidePanel === 'link';
    return isToolActive(tool.key);
  };

  const tools: ToolItem[] = [
    { id: 'blank', key: 'blank', icon: 'project-image-editor-right-square-icon', label: 'blank', width: 18, height: 18 },
    { id: 'stitch', key: 'crop', icon: 'project-image-editor-more-grid-slice-icon', label: 'stitch', width: 20, height: 20 },
    {
      id: 'history',
      key: 'brush',
      sidePanel: 'history',
      icon: 'project-image-editor-history-icon',
      label: 'history',
      width: 20,
      height: 20,
    },
    {
      id: 'assert',
      key: 'text',
      sidePanel: 'assets',
      icon: 'project-image-editor-right-assets-icon',
      label: 'assert',
      width: 22,
      height: 22,
    },
    { id: 'attatch', sidePanel: 'attach', icon: 'project-image-editor-right-plus-icon', label: 'attatch', width: 20, height: 20 },
    { id: 'upstream', sidePanel: 'link', icon: 'project-image-editor-right-link-icon', label: 'Upstream', width: 20, height: 20 },
    { id: 'location', icon: 'project-image-editor-right-expand-corner-icon', label: 'Location', width: 20, height: 20 },
  ];

  const firstGroupTools = tools.slice(0, 2);
  const secondGroupTools = tools.slice(2, 6);
  const bottomTools = tools.slice(6);

  const handleUploadChange = (info: { fileList: UploadFile[] }) => {
    const latest = info.fileList[info.fileList.length - 1];
    if (latest?.originFileObj) onUpload?.(latest.originFileObj);
  };

  const handleToolButtonClick = useCallback(
    (tool: ToolItem) => {
      if (tool.id === 'blank' || tool.id === 'stitch') {
        setToolbarSegment(null);
        setOpenSidePanel(null);
        if (tool.key) onToolChange(tool.key);
        return;
      }

      if (tool.id === 'location') {
        setToolbarSegment(null);
        setOpenSidePanel(null);
        onUpstreamPanelOpen?.();
        return;
      }

      if (tool.id === 'upstream') {
        setToolbarSegment(null);
        setOpenSidePanel((prev) => (prev === 'link' ? null : 'link'));
        return;
      }

      if (exclusiveSegmentIds.has(tool.id)) {
        const seg = tool.id as ExclusiveToolbarSegment;
        if (toolbarSegment === seg) {
          setToolbarSegment(null);
          setOpenSidePanel(null);
          onToolChange('select');
          return;
        }
        setToolbarSegment(seg);
        if (tool.sidePanel) {
          setOpenSidePanel(tool.sidePanel);
        } else {
          setOpenSidePanel(null);
        }
        if (tool.key) onToolChange(tool.key);
        else onToolChange('select');
      }
    },
    [onToolChange, onUpstreamPanelOpen, toolbarSegment],
  );

  const closeSidePanel = useCallback(() => {
    setOpenSidePanel(null);
    setToolbarSegment(null);
  }, []);

  const activePanelConfig = openSidePanel ? panelConfig[openSidePanel] : null;
  const activePanelItems = openSidePanel ? sidePanelItems[openSidePanel] ?? [] : [];

  const handlePanelItemAddClick = useCallback(
    (item: MediaResourceListItem) => {
      if (openSidePanel) onSidePanelItemAddClick?.(openSidePanel, item);
    },
    [openSidePanel, onSidePanelItemAddClick],
  );

  const handlePanelItemDownloadClick = useCallback(
    (item: MediaResourceListItem) => {
      if (openSidePanel) onSidePanelItemDownloadClick?.(openSidePanel, item);
    },
    [openSidePanel, onSidePanelItemDownloadClick],
  );

  const handlePanelItemFavorited = useCallback(
    (item: MediaResourceListItem) => {
      if (!openSidePanel || !isSidePanelItemFavorited) return false;
      return isSidePanelItemFavorited(openSidePanel, item);
    },
    [openSidePanel, isSidePanelItemFavorited],
  );

  const handlePanelItemFavoriteClick = useCallback(
    (item: MediaResourceListItem) => {
      if (openSidePanel) onSidePanelItemFavoriteClick?.(openSidePanel, item);
    },
    [openSidePanel, onSidePanelItemFavoriteClick],
  );

  const sidePanelOpen = openSidePanel !== null;
  const favoriteControlsEnabled = openSidePanel !== null && openSidePanel !== 'assets';
  const sidePanelIsItemFavoritedProp = favoriteControlsEnabled && isSidePanelItemFavorited ? handlePanelItemFavorited : undefined;
  const sidePanelOnItemFavoriteClickProp = favoriteControlsEnabled && onSidePanelItemFavoriteClick ? handlePanelItemFavoriteClick : undefined;

  return (
    <div className='pointer-events-auto relative flex h-full min-h-0 shrink-0 items-center'>
      <div className='flex flex-col items-center gap-1 rounded-xl bg-background-default-base px-[4px] py-[6px] shadow-[0px_4px_16px_-1px_rgba(12,12,13,0.05),0px_4px_4px_-1px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]'>
        <Upload accept={uploadAccept} showUploadList={false} fileList={[]} onChange={handleUploadChange}>
          <Tooltip title='upload' placement='right' offset={4}>
            <button
              type='button'
              className='flex h-9 w-9 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
            >
              <Icon name='project-image-editor-upload-icon' width={16} height={16} />
            </button>
          </Tooltip>
        </Upload>

        {firstGroupTools.map((tool) => (
          <Tooltip key={tool.id} title={tool.label} placement='right' offset={4}>
            <button
              type='button'
              className={`flex h-9 w-9 items-center justify-center rounded-[6px] text-icon-base transition-colors ${
                isSidePanelButtonActive(tool) ? 'bg-background-default-base-hover' : 'hover:bg-background-default-base-hover'
              }`}
              onClick={() => handleToolButtonClick(tool)}
            >
              <Icon name={tool.icon} width={tool.width ?? 20} height={tool.height ?? 20} />
            </button>
          </Tooltip>
        ))}

        <Divider className='mx-1 my-0.5 w-5' />

        {secondGroupTools.map((tool) => (
          <Tooltip key={tool.id} title={tool.label} placement='right' offset={4}>
            <button
              type='button'
              className={`flex h-9 w-9 items-center justify-center rounded-[6px] text-icon-base transition-colors ${
                isSidePanelButtonActive(tool) ? 'bg-background-default-base-hover' : 'hover:bg-background-default-base-hover'
              }`}
              onClick={() => handleToolButtonClick(tool)}
            >
              <Icon name={tool.icon} width={tool.width ?? 20} height={tool.height ?? 20} />
            </button>
          </Tooltip>
        ))}

        <Divider className='mx-1 my-0.5 w-5' />

        {bottomTools.map((tool) => (
          <Tooltip key={tool.id} title={tool.label} placement='right' offset={4}>
            <button
              type='button'
              className={`flex h-9 w-9 items-center justify-center rounded-[6px] text-icon-base transition-colors ${
                isSidePanelButtonActive(tool) ? 'bg-background-default-base-hover' : 'hover:bg-background-default-base-hover'
              }`}
              onClick={() => handleToolButtonClick(tool)}
            >
              <Icon name={tool.icon} width={tool.width ?? 20} height={tool.height ?? 20} />
            </button>
          </Tooltip>
        ))}
      </div>

      <MediaResourceListPanel
        open={sidePanelOpen}
        title={activePanelConfig?.title ?? ''}
        showStatusDot={activePanelConfig?.showStatusDot}
        emptyText={activePanelConfig?.emptyText}
        items={activePanelItems}
        onClose={closeSidePanel}
        onItemAddClick={onSidePanelItemAddClick ? handlePanelItemAddClick : undefined}
        onItemDownloadClick={onSidePanelItemDownloadClick ? handlePanelItemDownloadClick : undefined}
        isItemFavorited={sidePanelIsItemFavoritedProp}
        onItemFavoriteClick={sidePanelOnItemFavoriteClickProp}
        className={
          sidePanelOpen ? 'absolute right-full top-1/2 z-10 mr-2 -translate-y-1/2' : undefined
        }
      />
    </div>
  );
};

export default memo(RightToolbar);
