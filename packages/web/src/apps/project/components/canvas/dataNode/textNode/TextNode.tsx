/**
 * Text input node (TextNode)
 * - Shows NodeToolbar on selection (copy / delete / upload)
 * - Supports txt/md/docx/xlsx/xls and inline text editing
 */
import React, { useState, useEffect, memo, useRef, useCallback } from 'react';
import { type NodeProps, Position, NodeToolbar as FlowNodeToolbar, NodeResizer, useStore } from '@xyflow/react';
import { message } from '@/components/base/message';
import { useTranslation } from 'react-i18next';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { useCanvasUI } from '@/hooks/useCanvasUI';
import {
  shouldHideNodeChatComposerForChatRecordCanvasPick,
  type CanvasWorkflowNodeData,
} from '@/apps/project/components/canvas/types';
import { Icon } from '@/components/base/icon';
import TextNodeContent, { type TextNodeContentHandle } from './TextNodeContent';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import NodeHeader from '../../common/NodeHeader';
import DataNodeHandle from '../../common/DataNodeHandle';
import NodeSkeleton, { zoomLevelShowContentSelector } from '../../common/NodeSkeleton';
import TextNodeToolbar from './NodeToolbar';
import NodeChatComposer from '@/apps/project/components/agent/NodeChatComposer';

/** Extract plain text from HTML to check emptiness (same rule as TextNodeContent). */
const getTextFromHtml = (html: string): string => {
  if (!html || !html.trim()) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || div.innerText || '').replace(/\u00A0/g, ' ').trim();
};

/** Edge handle IDs aligned with canvas conventions. */
const targetHandleId = 'Text_0_0';
const sourceHandleId = 'Text_0_0';

const defaultTextNodeWidth = 300;
const defaultTextNodeHeight = 250;

/**
 * Node data shape as read from Yjs (new schema).
 * Text content (`prompt`) lives in the Yjs Y.XmlFragment, not in this object.
 * TODO PR-6+: inline text editing in TextNode must be rerouted to read/write
 * the TipTap editor document that mirrors the `prompt` Y.XmlFragment, rather
 * than reading/writing `data.content` (removed from schema).
 */
type TextNodeData = Partial<CanvasWorkflowNodeData> & { type?: string };

/** Custom upload request params (aligned with base Upload customRequest; onProgress optional). */
interface CustomRequestOptions {
  file: File;
  onProgress?: (percent: number) => void;
  onSuccess: (response: unknown) => void;
  onError: (error: Error) => void;
}

const TextNode: React.FC<NodeProps> = ({ id, data, selected, dragging }) => {
  const { t } = useTranslation();
  const { nodes } = useCanvasData();
  const { updateNode, onNodesChange } = useCanvasActions();
  const {
    openRightPanel,
    requestAddResourceToInput,
    openCanvasOverlayPanel,
    closeCanvasOverlayPanel,
    canvasOverlayPanel,
  } = useCanvasUI();
  const showContent = useStore(zoomLevelShowContentSelector);
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const currentNode = nodes.find((n) => n.id === id);
  const nodeStyle = (currentNode?.style ?? {}) as { width?: number; height?: number };
  const width = nodeStyle.width ?? defaultTextNodeWidth;
  const height = nodeStyle.height ?? defaultTextNodeHeight;
  const borderColor = selected ? 'var(--color-border-utilities-selected)' : 'var(--color-border-default-base)';

  const nodeData = data as TextNodeData | undefined;
  const wf = (currentNode?.data ?? nodeData) as Partial<CanvasWorkflowNodeData> | undefined;
  // TODO PR-6+: text content lives in the Yjs `prompt` Y.XmlFragment, not in
  // `data.content` (removed from schema). `textContent` should be sourced from
  // the TipTap editor document bound to the node's prompt Y.XmlFragment.
  // Stubbed to empty string until that migration is complete.
  const textContent = '';
  const [nodeHovered, setNodeHovered] = useState(false);
  const [textValue, setTextValue] = useState(textContent);
  const [isUploading, setIsUploading] = useState(false);
  const [hasActivated, setHasActivated] = useState(false);
  /** With content, enter edit mode only on content double-click; reset on deselect. */
  const [contentEditingActive, setContentEditingActive] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<TextNodeContentHandle>(null);
  const isEmpty = getTextFromHtml(textValue).length === 0;
  const prevSelectedRef = useRef(selected);

  /** On deselect: empty content returns to placeholder, otherwise exit edit mode. */
  useEffect(() => {
    const justDeselected = !selected && prevSelectedRef.current;
    prevSelectedRef.current = selected;
    if (justDeselected) {
      if (isEmpty) setHasActivated(false);
      else setContentEditingActive(false);
    }
  }, [selected, isEmpty]);

  /** Sync local text state when external data content changes. */
  useEffect(() => {
    if (textContent !== textValue) {
      setTextValue(textContent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textContent]);

  /** Update text and write back to node data; keep edit mode after paste from empty state. */
  const handleTextChange = (newValue: string) => {
    const hadContent = !isEmpty;
    const willHaveContent = getTextFromHtml(newValue).length > 0;
    setTextValue(newValue);
    if (!hadContent && willHaveContent && hasActivated) {
      setContentEditingActive(true);
    }
    // TODO PR-6+: text content must be written to the Yjs `prompt` Y.XmlFragment
    // via TipTap, not to `data.content` (removed from schema). Only `name` is
    // written here until that migration is done.
    const cur = (nodesRef.current.find((n) => n.id === id)?.data ?? {}) as Record<string, unknown>;
    updateNode(id, {
      data: {
        name: typeof cur.name === 'string' && cur.name ? cur.name : 'text',
      },
    });
  };

  /** Custom upload: parse txt/md/json/csv/docx/xlsx/xls and update node text. */
  const customRequest = async (options: CustomRequestOptions): Promise<void> => {
    const { file, onSuccess, onError } = options;
    setIsUploading(true);
    const fileName = file.name.toLowerCase();
    const fileExtension = fileName.substring(fileName.lastIndexOf('.') + 1);
    const textFileExtensions = ['txt', 'md', 'json', 'csv'];
    const excelFileExtensions = ['xlsx', 'xls'];
    try {
      let parsedText = '';
      if (textFileExtensions.includes(fileExtension)) {
        parsedText = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.onerror = reject;
          reader.readAsText(file);
        });
      } else if (fileExtension === 'docx') {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        parsedText = result.value;
      } else if (excelFileExtensions.includes(fileExtension)) {
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const textParts: string[] = [];
        workbook.SheetNames.forEach((sheetName) => {
          const worksheet = workbook.Sheets[sheetName];
          const csvText = XLSX.utils.sheet_to_csv(worksheet);
          if (csvText.trim()) textParts.push(`Sheet: ${sheetName}\n${csvText}`);
        });
        parsedText = textParts.join('\n\n');
      } else {
        message.error(t('project.toolbar.unsupportedFileFormat', { extension: fileExtension }));
        setIsUploading(false);
        onError(new Error(t('project.toolbar.unsupportedFileFormat', { extension: fileExtension })));
        return;
      }
      setTextValue(parsedText);
      // TODO PR-6+: parsed text must be inserted into the Yjs `prompt` Y.XmlFragment
      // via TipTap. Only `name` is updated here until that migration is done.
      const cur = (nodesRef.current.find((n) => n.id === id)?.data ?? {}) as Record<string, unknown>;
      updateNode(id, {
        data: {
          name: typeof cur.name === 'string' && cur.name ? cur.name : 'text',
        },
      });
      setIsUploading(false);
      onSuccess(parsedText);
    } catch (error) {
      console.error('File parse failed:', error);
      message.error(t('project.toolbar.fileParseFailed'));
      setIsUploading(false);
      onError(error as Error);
    }
  };

  const selectedCount = nodes.filter((n: { selected?: boolean }) => n.selected).length;
  const parentNode = currentNode?.parentId ? nodes.find((n) => n.id === currentNode.parentId) : null;
  const isInsideLockedGroup =
    parentNode?.type === 'group' && (parentNode.data as { locked?: boolean })?.locked === true;
  const showToolbar = selected && selectedCount === 1 && !dragging && !isInsideLockedGroup;
  const showBottomNodeChatComposer = showToolbar && !shouldHideNodeChatComposerForChatRecordCanvasPick(wf);

  /** Toolbar upload click: trigger hidden file input. */
  const handleToolbarUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleToolbarInfoClick = () => {
    const isCurrentNodePanelOpen = canvasOverlayPanel.open && canvasOverlayPanel.nodeId === id;
    if (isCurrentNodePanelOpen) {
      closeCanvasOverlayPanel();
      return;
    }
    openCanvasOverlayPanel(id);
  };

  /** Hidden file input change: parse file via customRequest and update node text. */
  const handleToolbarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    customRequest({
      file,
      onSuccess: () => {},
      onError: () => {},
    });
    e.target.value = '';
  };

  const handleResize = (_: unknown, params: { width: number; height: number }) => {
    const node = nodesRef.current.find((n) => n.id === id);
    const currentStyle = (node?.style ?? {}) as Record<string, unknown>;
    updateNode(id, {
      style: {
        ...currentStyle,
        width: params.width,
        height: params.height,
      },
    });
  };

  /** Open right-side editor panel (same behavior as video node). */
  /** Double-click empty placeholder to enter edit mode and focus editor. */
  const handleEmptyStateDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onNodesChange(nodes.map((n) => ({ type: 'select' as const, id: n.id, selected: n.id === id })));
      setHasActivated(true);
      setTimeout(() => contentRef.current?.focusEditor(), 0);
    },
    [id, nodes, onNodesChange],
  );

  /** With content, double-click content to edit; when empty, `isEditing = hasActivated`. */
  const isEditing = isEmpty ? hasActivated : contentEditingActive;
  const handleEnterEditMode = useCallback(() => {
    setContentEditingActive(true);
  }, []);

  const handleChatInputSend = (content: string, imageUrls?: string[]) => {
    // eslint-disable-next-line no-console
    console.log('TextNode ChatInput send:', { nodeId: id, content, imageUrls });
    // TODO: Wire to the ChatMessage list bound to this node.
  };

  return (
    <>
      <input
        ref={uploadInputRef}
        type='file'
        accept='.txt,.md,.docx,.xlsx,.xls'
        className='hidden'
        onChange={handleToolbarFileChange}
      />
      <FlowNodeToolbar position={Position.Top} align='center' offset={40} isVisible={showToolbar}>
        <div className='rounded-[8px] pointer-events-auto' onMouseDown={(e) => e.stopPropagation()}>
          <TextNodeToolbar
            nodeId={id}
            isUploading={isUploading}
            onUploadClick={handleToolbarUploadClick}
            onInfoClick={handleToolbarInfoClick}
          />
        </div>
      </FlowNodeToolbar>
      <div className='relative'>
        <div className='absolute -translate-y-full text-left left-0 -top-0 text-foreground/60 overflow-hidden text-ellipsis whitespace-nowrap'>
          <NodeHeader nodeId={id} title={t('project.toolbar.textNode')} editable={true} />
        </div>
        <div
          className={
            'relative flex flex-col rounded-[8px] bg-background-default-base outline outline-2 pointer-events-auto ' +
            (selected ? 'outline-solid outline-border-utilities-selected' : 'outline-transparent')
          }
          style={{ width, height, minWidth: defaultTextNodeWidth, minHeight: defaultTextNodeHeight }}
          onMouseEnter={() => setNodeHovered(true)}
          onMouseLeave={() => setNodeHovered(false)}
        >
          <NodeResizer
            color={borderColor}
            isVisible={selected}
            minWidth={defaultTextNodeWidth}
            minHeight={defaultTextNodeHeight}
            handleStyle={{ display: 'none' }}
            lineClassName='rounded-[8px]'
            lineStyle={{
              border: '0',
              borderColor,
              borderRadius: 8,
            }}
            onResize={handleResize}
            onResizeEnd={handleResize}
          />
          <DataNodeHandle
            type='target'
            position={Position.Left}
            handleId={targetHandleId}
            nodeId={id}
            selected={selected}
            nodeHovered={nodeHovered}
            isInsideLockedGroup={isInsideLockedGroup}
          />
          <DataNodeHandle
            type='source'
            position={Position.Right}
            handleId={sourceHandleId}
            nodeId={id}
            selected={selected}
            nodeHovered={nodeHovered}
            isInsideLockedGroup={isInsideLockedGroup}
          />
          <div className='flex-1 h-full flex flex-col p-3'>
            {!showContent ? (
              <NodeSkeleton />
            ) : isUploading ? (
              <div className='w-full flex-1 flex flex-col items-center justify-center text-center rounded-[4px] border border-solid border-border-default-secondary'>
                <Icon name='base-loading-spinner' width={32} height={32} className='animate-spin' />
                <div className='text-[12px] text-text-default-tertiary font-normal mt-2'>
                  {t('project.toolbar.uploading')}
                </div>
              </div>
            ) : isEmpty && !hasActivated ? (
              <div
                className='w-full h-full flex items-center justify-center overflow-hidden rounded-[8px] cursor-pointer'
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleEmptyStateDoubleClick(e);
                }}
              >
                <div className='w-full flex flex-col items-center justify-center gap-2'>
                  <Icon
                    name='project-text-node-placeholder'
                    width={42}
                    height={42}
                    className='text-text-default-tertiary'
                  />
                  <div className='text-center text-[12px] font-normal text-text-default-tertiary'>
                    {t('project.toolbar.textNodePlaceholder')
                      .split('\n')
                      .map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className='rounded-[4px] bg-background-default-base flex-1 h-full min-h-0 flex flex-col overflow-hidden'>
                <TextNodeContent
                  ref={contentRef}
                  value={textValue}
                  onChange={handleTextChange}
                  placeholder={t('project.toolbar.pleaseInputTexts')}
                  selected={selected}
                  isEditing={isEditing}
                  onEnterEditMode={handleEnterEditMode}
                  onMentionClick={(e) => {
                    e.stopPropagation();
                    const plainText = getTextFromHtml(textValue);
                    if (plainText) {
                      const blob = new Blob([plainText], { type: 'text/plain;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      requestAddResourceToInput({
                        url,
                        name: plainText.length > 20 ? plainText.slice(0, 20) + '…' : plainText || 'Text',
                        type: 'text',
                      });
                    }
                    openRightPanel('editor', id, undefined, true);
                  }}
                  onBlurWithEmpty={() => setHasActivated(false)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Bottom FlowNodeToolbar: show a floating ChatInput below when selected. */}
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={20} isVisible={showBottomNodeChatComposer}>
        <NodeChatComposer
          className='w-[526px] min-h-[160px] pointer-events-auto rounded-[16px]'
          onSend={handleChatInputSend}
          targetNodeId={id}
        />
      </FlowNodeToolbar>
    </>
  );
};

export default memo(TextNode);
