import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Icon } from '@/ui/icon';
import Tooltip from '@/ui/tooltip';
import Divider from '@/ui/divider';
import { message } from '@/ui/message';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import Upload, { type UploadFile } from '@/ui/upload';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { RiAddLine, RiEdit2Line, RiSparkling2Fill } from 'react-icons/ri';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useUpstreamExternalFileList, type UpstreamExternalFileItem } from '@/hooks/useUpstreamExternalFileList';
import { useSelector, useDispatch } from 'react-redux';
import type { RootState } from '@/store';
import { toggleMixedEditorFavoriteAsset } from '@/store/modules/mixedEditor';
import type { AgentComposerUploadItem } from '@/components/base/agent/AgentComposerTabs';
import type { CanvasWorkflowNodeData } from '@/apps/project/components/canvas/types';
import { getProjectCanvasViewportApi } from '@/apps/project/components/canvas/types';
import MediaResourceListPanel, { type MediaResourceListItem } from './MediaResourceListPanel';
import { openGenerationAIMenuAtBottom } from '../utils/openGenerationAIMenuAtBottom';

/** Side-panel tab ids shared with the mixedEditor module (inlined here after mixedEditor deletion). */
type ImageEditorRightSidePanelId = 'assets' | 'attach' | 'link' | 'history';

type RightToolbarProps = {
  editor: Editor;
  /** Workflow canvas node id for this text editor panel. */
  nodeId: string;
};

const panelConfig: Record<
  Exclude<ImageEditorRightSidePanelId, 'history'>,
  { title: string; emptyText: string; showStatusDot?: boolean }
> = {
  assets: { title: 'Assets', emptyText: 'No assets yet' },
  attach: { title: 'Attachments', emptyText: 'No attachments yet' },
  link: { title: 'Upstream', emptyText: 'No Upstream yet' },
};

type ExclusiveToolbarSegment = 'assert' | 'attatch';

const exclusiveSegmentIds = new Set<string>(['assert', 'attatch']);

function canvasImageAttachToListItem(item: AgentComposerUploadItem): MediaResourceListItem {
  return {
    id: item.id,
    previewUrl: item.previewUrl ?? '',
    name: item.name,
  };
}

function canvasUpstreamImageToListItem(item: UpstreamExternalFileItem): MediaResourceListItem {
  return {
    id: item.uid,
    previewUrl: item.content ?? '',
    name: item.name,
  };
}

function canInsertMediaItem(item: MediaResourceListItem): boolean {
  return Boolean(item.previewUrl?.trim());
}

function insertImageAtCursor(editor: Editor, item: MediaResourceListItem): void {
  const src = item.previewUrl.trim();
  if (!src) {
    message.warning('Nothing to insert');
    return;
  }
  const alt = item.name?.trim() || 'image';
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'image',
      attrs: { src, alt, title: null },
    })
    .run();
}

interface ToolItem {
  id: string;
  sidePanel?: ImageEditorRightSidePanelId;
  icon: string;
  label: string;
  width?: number;
  height?: number;
}

const tools: ToolItem[] = [
  {
    id: 'assert',
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

const AI_TOOL_INITIAL_REPLACEMENTS = {
  generate: '[GENERATE] This is fixed replacement content.',
  character: '[CHARACTER] This is fixed replacement content.',
  storyboard: '[STORYBOARD] This is fixed replacement content.',
  script: '[SCRIPT] This is fixed replacement content.',
} as const;

async function parseTextUploadFile(file: File): Promise<string> {
  const fileName = file.name.toLowerCase();
  const ext = fileName.substring(fileName.lastIndexOf('.') + 1);
  const textFileExtensions = ['txt', 'md', 'json', 'csv'];
  const excelFileExtensions = ['xlsx', 'xls'];

  if (textFileExtensions.includes(ext)) {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(String(e.target?.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  if (ext === 'docx') {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }

  if (excelFileExtensions.includes(ext)) {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const textParts: string[] = [];
    workbook.SheetNames.forEach((sheetName) => {
      const worksheet = workbook.Sheets[sheetName];
      const csvText = XLSX.utils.sheet_to_csv(worksheet);
      if (csvText.trim()) textParts.push(`Sheet: ${sheetName}\n${csvText}`);
    });
    return textParts.join('\n\n');
  }

  throw new Error(`unsupported:${ext}`);
}

const RightToolbar: React.FC<RightToolbarProps> = ({ editor, nodeId }) => {
  const { nodes: projectNodes, edges: projectEdges } = useCanvasData();
  const favoriteAssets = useSelector((s: RootState) => s.mixedEditor.favoriteAssets);
  const dispatch = useDispatch();
  const toggleFavoriteAsset = useCallback(
    (payload: { panel: ImageEditorRightSidePanelId; item: MediaResourceListItem }) =>
      dispatch(toggleMixedEditorFavoriteAsset(payload)),
    [dispatch],
  );
  const projectCanvasUpstream = useUpstreamExternalFileList(projectNodes, projectEdges, nodeId);

  const [openSidePanel, setOpenSidePanel] = useState<ImageEditorRightSidePanelId | null>(null);
  const [toolbarSegment, setToolbarSegment] = useState<ExclusiveToolbarSegment | null>(null);
  const [pendingUploadMode, setPendingUploadMode] = useState<'insert' | 'overwrite' | null>(null);
  const uploadProxyRef = useRef<HTMLDivElement | null>(null);

  const sidePanelItems = useMemo((): Partial<Record<ImageEditorRightSidePanelId, MediaResourceListItem[]>> => {
    const canvasNode = projectNodes.find((n) => n.id === nodeId);
    const canvasData = canvasNode?.data as Partial<CanvasWorkflowNodeData> | undefined;
    const rawAttach = canvasData?.attach;
    const canvasAttach = (Array.isArray(rawAttach) ? rawAttach : []) as AgentComposerUploadItem[];
    const canvasImageAttach = canvasAttach.filter((u) => u.type === 'image');
    const upstreamImages = projectCanvasUpstream.filter((u) => u.type === 'image');

    const assets: MediaResourceListItem[] = favoriteAssets.map((f) => ({
      id: f.id,
      previewUrl: f.previewUrl,
      name: f.name,
    }));

    return {
      assets,
      attach: canvasImageAttach.map(canvasImageAttachToListItem),
      link: upstreamImages.map(canvasUpstreamImageToListItem),
    };
  }, [nodeId, projectNodes, projectCanvasUpstream, favoriteAssets]);

  const isSidePanelButtonActive = (tool: ToolItem) => {
    if (exclusiveSegmentIds.has(tool.id)) return toolbarSegment === tool.id;
    if (tool.id === 'upstream') return openSidePanel === 'link';
    return false;
  };

  const handleUpstreamPanelOpen = useCallback(() => {
    const api = getProjectCanvasViewportApi();
    if (!api) return;
    api.centerOnFirstNodeId([nodeId], true);
  }, [nodeId]);

  const handleToolButtonClick = useCallback(
    (tool: ToolItem) => {
      if (tool.id === 'location') {
        setToolbarSegment(null);
        setOpenSidePanel(null);
        handleUpstreamPanelOpen();
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
          return;
        }
        setToolbarSegment(seg);
        if (tool.sidePanel) setOpenSidePanel(tool.sidePanel);
        else setOpenSidePanel(null);
      }
    },
    [handleUpstreamPanelOpen, toolbarSegment],
  );

  const closeSidePanel = useCallback(() => {
    setOpenSidePanel(null);
    setToolbarSegment(null);
  }, []);

  const getActivePanelConfig = () => {
    if (!openSidePanel) return null;
    if (openSidePanel === 'assets' || openSidePanel === 'attach' || openSidePanel === 'link') {
      return panelConfig[openSidePanel];
    }
    return null;
  };
  const activePanelConfig = getActivePanelConfig();
  const activePanelItems = openSidePanel ? sidePanelItems[openSidePanel] ?? [] : [];

  const handlePanelItemAddClick = useCallback(
    (item: MediaResourceListItem) => {
      if (!openSidePanel) return;
      if (!canInsertMediaItem(item)) {
        message.warning('Nothing to insert');
        return;
      }
      insertImageAtCursor(editor, item);
    },
    [editor, openSidePanel],
  );

  const handlePanelItemDownloadClick = useCallback(async (item: MediaResourceListItem) => {
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
  }, []);

  const isItemFavoritedForPanel = useCallback(
    (panel: ImageEditorRightSidePanelId, item: MediaResourceListItem) => {
      if (panel === 'assets') {
        return favoriteAssets.some((f) => f.id === item.id);
      }
      return favoriteAssets.some((f) => f.sourcePanel === panel && f.sourceItemId === item.id);
    },
    [favoriteAssets],
  );

  const handlePanelItemFavorited = useCallback(
    (item: MediaResourceListItem) => {
      if (!openSidePanel) return false;
      return isItemFavoritedForPanel(openSidePanel, item);
    },
    [openSidePanel, isItemFavoritedForPanel],
  );

  const handlePanelItemFavoriteClick = useCallback(
    (item: MediaResourceListItem) => {
      if (openSidePanel) toggleFavoriteAsset({ panel: openSidePanel, item });
    },
    [openSidePanel, toggleFavoriteAsset],
  );

  const sidePanelOpen = openSidePanel !== null;
  const favoriteControlsEnabled = openSidePanel !== null && openSidePanel !== 'assets';
  const sidePanelIsItemFavoritedProp = favoriteControlsEnabled ? handlePanelItemFavorited : undefined;
  const sidePanelOnItemFavoriteClickProp = favoriteControlsEnabled ? handlePanelItemFavoriteClick : undefined;
  const primaryTools = tools.filter((tool) => tool.id !== 'location');
  const locationTool = tools.find((tool) => tool.id === 'location') ?? null;

  const uploadDropdownItems: MenuItemType[] = useMemo(
    () => [
      {
        key: 'upload-insert',
        label: (
          <span className='inline-flex items-center gap-2'>
            <RiAddLine size={14} />
            Insert
          </span>
        ),
      },
      {
        key: 'upload-overwrite',
        label: (
          <span className='inline-flex items-center gap-2'>
            <RiEdit2Line size={14} />
            Overwrite
          </span>
        ),
      },
    ],
    [],
  );

  const aiDropdownItems: MenuItemType[] = useMemo(
    () => [
      { key: 'ai-generate', label: 'Generate' },
      { key: 'ai-character', label: 'Character' },
      { key: 'ai-storyboard', label: 'Storyboard' },
      { key: 'ai-script', label: 'Script' },
    ],
    [],
  );

  const openUploadDialog = useCallback((mode: 'insert' | 'overwrite') => {
    setPendingUploadMode(mode);
    const input = uploadProxyRef.current?.querySelector('input[type="file"]') as HTMLInputElement | null;
    input?.click();
  }, []);

  const handleUploadMenuClick = useCallback(
    (key: string) => {
      if (key === 'upload-insert') {
        openUploadDialog('insert');
      } else if (key === 'upload-overwrite') {
        openUploadDialog('overwrite');
      }
    },
    [openUploadDialog],
  );

  const handleAIMenuClick = useCallback(
    (key: string) => {
      if (key === 'ai-generate') {
        openGenerationAIMenuAtBottom(editor, { replacement: AI_TOOL_INITIAL_REPLACEMENTS.generate });
        return;
      }
      if (key === 'ai-character') {
        openGenerationAIMenuAtBottom(editor, { replacement: AI_TOOL_INITIAL_REPLACEMENTS.character });
        return;
      }
      if (key === 'ai-storyboard') {
        openGenerationAIMenuAtBottom(editor, { replacement: AI_TOOL_INITIAL_REPLACEMENTS.storyboard });
        return;
      }
      if (key === 'ai-script') {
        openGenerationAIMenuAtBottom(editor, { replacement: AI_TOOL_INITIAL_REPLACEMENTS.script });
      }
    },
    [editor],
  );

  const handleUploadChange = useCallback(
    async (info: { fileList: UploadFile[] }) => {
      const latest = info.fileList[info.fileList.length - 1];
      const file = latest?.originFileObj;
      const mode = pendingUploadMode;
      setPendingUploadMode(null);
      if (!file || !mode) return;
      try {
        const parsedText = await parseTextUploadFile(file);
        if (mode === 'insert') {
          editor.chain().focus().insertContent(parsedText).run();
          return;
        }
        editor.chain().focus().setContent(parsedText).run();
      } catch (err) {
        const maybeMsg = err instanceof Error ? err.message : '';
        if (maybeMsg.startsWith('unsupported:')) {
          const ext = maybeMsg.replace('unsupported:', '');
          message.warning(`Unsupported file format: ${ext}`);
          return;
        }
        console.error('Upload failed:', err);
        message.warning('Upload failed');
      }
    },
    [editor, pendingUploadMode],
  );

  return (
    <div className='pointer-events-auto relative flex h-full min-h-0 shrink-0 items-center'>
      <div className='flex flex-col items-center gap-1 rounded-xl bg-background-default-base px-[4px] py-[6px] shadow-[0px_4px_16px_-1px_rgba(12,12,13,0.05),0px_4px_4px_-1px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]'>
        <div ref={uploadProxyRef} className='hidden'>
          <Upload
            accept='.txt,.md,.json,.csv,.docx,.xlsx,.xls'
            showUploadList={false}
            fileList={[]}
            onChange={handleUploadChange}
          >
            <span />
          </Upload>
        </div>
        <Dropdown
          trigger='click'
          placement='left-start'
          items={uploadDropdownItems}
          popupClassName='min-w-[220px]'
          onClick={(key) => handleUploadMenuClick(key)}
        >
          <Tooltip title='Upload' placement='right' offset={4}>
            <button
              type='button'
              className='flex h-9 w-9 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
            >
              <Icon name='project-image-editor-upload-icon' width={16} height={16} />
            </button>
          </Tooltip>
        </Dropdown>

        <Divider className='mx-1 my-0.5 w-5' />

        <Dropdown
          trigger='click'
          placement='left-start'
          items={aiDropdownItems}
          popupClassName='min-w-[170px]'
          onClick={(key) => handleAIMenuClick(key)}
        >
          <Tooltip title='Ask AI' placement='right' offset={4}>
            <button
              type='button'
              className='flex h-9 w-9 items-center justify-center rounded-[6px] text-icon-base transition-colors hover:bg-background-default-base-hover'
            >
              <RiSparkling2Fill size={22} />
            </button>
          </Tooltip>
        </Dropdown>

        {primaryTools.map((tool) => (
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

        {locationTool ? (
          <Tooltip key={locationTool.id} title={locationTool.label} placement='right' offset={4}>
            <button
              type='button'
              className={`flex h-9 w-9 items-center justify-center rounded-[6px] text-icon-base transition-colors ${
                isSidePanelButtonActive(locationTool) ? 'bg-background-default-base-hover' : 'hover:bg-background-default-base-hover'
              }`}
              onClick={() => handleToolButtonClick(locationTool)}
            >
              <Icon name={locationTool.icon} width={locationTool.width ?? 20} height={locationTool.height ?? 20} />
            </button>
          </Tooltip>
        ) : null}
      </div>

      <MediaResourceListPanel
        open={sidePanelOpen}
        title={activePanelConfig?.title ?? ''}
        showStatusDot={activePanelConfig?.showStatusDot}
        emptyText={activePanelConfig?.emptyText}
        items={activePanelItems}
        onClose={closeSidePanel}
        onItemAddClick={handlePanelItemAddClick}
        onItemDownloadClick={handlePanelItemDownloadClick}
        isItemFavorited={sidePanelIsItemFavoritedProp}
        onItemFavoriteClick={sidePanelOnItemFavoriteClickProp}
        className={sidePanelOpen ? 'absolute right-full top-1/2 z-10 mr-2 -translate-y-1/2' : undefined}
      />
    </div>
  );
};

export default memo(RightToolbar);
