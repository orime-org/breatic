/**
 * Local text node (type `1001`) — top `NodeToolbar` (format + AI dropdowns) hides while an AI tool sheet is open; bottom sheet matches `new/textEditor` shell styling; body is chromeless.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  NodeResizer,
  NodeToolbar as FlowNodeToolbar,
  Position,
  useReactFlow,
  useStore,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import Divider from '@/ui/divider';
import { message } from '@/ui/message';
import CanvasOutputPendingProgressOverlay from '../../common/CanvasOutputPendingProgressOverlay';
import { Icon } from '@/ui/icon';
import type { LocalCanvasNodeData } from '@/new/project/types';
import LocalNodeHeader from '../../common/LocalNodeHeader';
import LocalDataNodeHandle from '../../common/LocalDataNodeHandle';
import LocalNodeSkeleton, { zoomLevelShowContentSelector } from '../../common/LocalNodeSkeleton';
import LocalTextFormatToolbar, { localTextNodeTopToolbarShellClass } from './LocalTextFormatToolbar';
import {
  MOCK_REPLACEMENT,
  LocalTextAiToolFormPanel,
  LocalTextAiTriggerBar,
  type TextAiPanelFields,
  type TextAiToolId,
} from './LocalTextAiToolsPanel';
import LocalTextNodeContent, {
  type LocalTextNodeContentHandle,
  type LocalTextRichTextFormatState,
} from './LocalTextNodeContent';

const targetHandleId = 'Text_0_0';
const sourceHandleId = 'Text_0_0';

const defaultTextNodeWidth = 300;
const defaultTextNodeHeight = 250;

const getTextFromHtml = (html: string): string => {
  if (!html || !html.trim()) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || div.innerText || '').replace(/\u00A0/g, ' ').trim();
};

const defaultRichTextFormatState: LocalTextRichTextFormatState = {
  bold: false,
  block: 'p',
  orderedList: false,
  unorderedList: false,
};

const TextNode: React.FC<NodeProps<Node<LocalCanvasNodeData>>> = ({ id, type, data, selected, dragging }) => {
  const { t } = useTranslation();
  const { setNodes, getNodes } = useReactFlow();
  const showContent = useStore(zoomLevelShowContentSelector);
  const nodes = useStore(useCallback((s) => s.nodes as Node<LocalCanvasNodeData>[], []));
  const selectedCount = nodes.filter((n) => n.selected).length;
  const nodesRef = useRef(getNodes());
  useEffect(() => {
    nodesRef.current = getNodes();
  }, [getNodes]);

  const currentNode = getNodes().find((n) => n.id === id);
  const nodeStyle = (currentNode?.style ?? {}) as { width?: number; height?: number };
  const width = nodeStyle.width ?? defaultTextNodeWidth;
  const height = nodeStyle.height ?? defaultTextNodeHeight;
  const borderColor = selected ? 'var(--color-border-utilities-selected)' : 'var(--color-border-default-base)';

  const title = data.name?.trim() ? data.name : 'Text';
  const textValue = data.text ?? '';
  const [nodeHovered, setNodeHovered] = useState(false);
  const [hasActivated, setHasActivated] = useState(false);
  const [contentEditingActive, setContentEditingActive] = useState(false);
  const [floatingFormatState, setFloatingFormatState] =
    useState<LocalTextRichTextFormatState>(defaultRichTextFormatState);
  const contentRef = useRef<LocalTextNodeContentHandle>(null);
  const prevSelectedRef = useRef(selected);
  const isEmpty = getTextFromHtml(textValue).length === 0;
  const hasDocumentText = getTextFromHtml(textValue).length > 0;
  const [activeAiTool, setActiveAiTool] = useState<TextAiToolId | null>(null);
  const [aiFields, setAiFields] = useState<TextAiPanelFields>({});
  const [aiRunning, setAiRunning] = useState(false);
  const [pendingMockPlain, setPendingMockPlain] = useState<string | null>(null);
  const mockRunTimersRef = useRef<number[]>([]);

  useEffect(() => {
    const justDeselected = !selected && prevSelectedRef.current;
    prevSelectedRef.current = selected;
    if (justDeselected) {
      if (isEmpty) setHasActivated(false);
      else setContentEditingActive(false);
      setActiveAiTool(null);
      setAiFields({});
      setAiRunning(false);
      setPendingMockPlain(null);
      mockRunTimersRef.current.forEach((tid) => window.clearTimeout(tid));
      mockRunTimersRef.current = [];
    }
  }, [selected, isEmpty]);

  useEffect(() => {
    return () => {
      mockRunTimersRef.current.forEach((tid) => window.clearTimeout(tid));
    };
  }, []);

  const persistText = useCallback(
    (html: string) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const prev = (n.data ?? {}) as LocalCanvasNodeData;
          return { ...n, data: { ...prev, text: html } };
        }),
      );
    },
    [id, setNodes],
  );

  const handleTextChange = useCallback(
    (newValue: string) => {
      const cur = getNodes().find((n) => n.id === id);
      const prevHtml = String((cur?.data as LocalCanvasNodeData)?.text ?? '');
      const hadContent = getTextFromHtml(prevHtml).length > 0;
      const willHaveContent = getTextFromHtml(newValue).length > 0;
      if (!hadContent && willHaveContent && hasActivated) {
        setContentEditingActive(true);
      }
      persistText(newValue);
    },
    [getNodes, hasActivated, id, persistText],
  );

  const handleResize = useCallback(
    (_: unknown, params: { width: number; height: number }) => {
      const node = nodesRef.current.find((n) => n.id === id);
      const currentStyle = (node?.style ?? {}) as Record<string, unknown>;
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? {
              ...n,
              style: {
                ...currentStyle,
                width: params.width,
                height: params.height,
              },
            }
            : n,
        ),
      );
    },
    [id, setNodes],
  );

  const handleEmptyStateDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setHasActivated(true);
    setTimeout(() => contentRef.current?.focusEditor(), 0);
  }, []);

  const isEditing = isEmpty ? hasActivated : contentEditingActive;

  useEffect(() => {
    if (!isEditing || pendingMockPlain === null) return;
    const chunk = pendingMockPlain;
    const tid = window.setTimeout(() => {
      setPendingMockPlain(null);
      contentRef.current?.replaceSelectionOrAppendPlain(chunk);
    }, 0);
    return () => window.clearTimeout(tid);
  }, [isEditing, pendingMockPlain]);

  const handleMockAiRun = useCallback((tool: TextAiToolId) => {
    mockRunTimersRef.current.forEach((tid) => window.clearTimeout(tid));
    mockRunTimersRef.current = [];
    setAiRunning(true);
    const t1 = window.setTimeout(() => {
      const t2 = window.setTimeout(() => {
        setHasActivated(true);
        setContentEditingActive(true);
        setPendingMockPlain(MOCK_REPLACEMENT[tool]);
        setAiRunning(false);
        setActiveAiTool(null);
        setAiFields({});
        mockRunTimersRef.current = [];
      }, 550);
      mockRunTimersRef.current.push(t2);
    }, 700);
    mockRunTimersRef.current.push(t1);
  }, []);

  const showFloatingChrome = selected && !dragging;
  /** Top chrome hides once an AI menu item is chosen so only the bottom input strip stays (matches TextEditor vs toolbar layering). */
  const showTopToolbar = showFloatingChrome && selectedCount === 1 && activeAiTool === null;
  /** Bottom: AI prompt card only after choosing a tool (same pattern as image `UpscaleBottomToolbar`). */
  const showAiBottomForm = showFloatingChrome && selectedCount === 1 && activeAiTool !== null;

  const handleCopyContentClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const text = textValue;
      if (!getTextFromHtml(text).trim()) {
        message.warning(t('project.toolbar.noContentToCopy', 'No content to copy'));
        return;
      }
      try {
        const plain = getTextFromHtml(text);
        await navigator.clipboard.writeText(plain);
        message.success(t('project.toolbar.copySuccess', 'Copied to clipboard'));
      } catch {
        message.error(t('project.toolbar.copyFailed', 'Copy failed'));
      }
    },
    [t, textValue],
  );

  const runFormat = useCallback(
    (command: string, commandValue?: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      contentRef.current?.execRichTextCommand(command, commandValue);
    },
    [],
  );

  const handleToolbarEditClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
      setHasActivated(true);
      setTimeout(() => contentRef.current?.focusEditor(), 0);
    },
    [id, setNodes],
  );

  return (
    <>
      <FlowNodeToolbar position={Position.Top} align='center' offset={40} isVisible={showTopToolbar}>
        <div className='flex max-w-[min(100vw-24px,920px)] flex-wrap items-center justify-center' onMouseDown={(e) => e.stopPropagation()}>
          <div className={localTextNodeTopToolbarShellClass}>
            <LocalTextFormatToolbar
              embedded
              formatState={floatingFormatState}
              placeholderMode={isEmpty && !hasActivated}
              onEditFromToolbar={handleToolbarEditClick}
              onH1={runFormat('formatBlock', 'h1')}
              onH2={runFormat('formatBlock', 'h2')}
              onH3={runFormat('formatBlock', 'h3')}
              onParagraph={runFormat('formatBlock', 'p')}
              onOrderedList={runFormat('insertOrderedList')}
              onUnorderedList={runFormat('insertUnorderedList')}
              onBold={runFormat('bold')}
              onCopy={handleCopyContentClick}
            />
            <Divider type='vertical' className='mx-[2px] h-[18px] shrink-0 self-center' />
            <LocalTextAiTriggerBar
              embedded
              hasDocumentText={hasDocumentText}
              fields={aiFields}
              onActiveToolChange={setActiveAiTool}
              onFieldsChange={setAiFields}
              menuPlacement='bottom-start'
            />
          </div>
        </div>
      </FlowNodeToolbar>
      <FlowNodeToolbar position={Position.Bottom} align='center' offset={12} isVisible={showAiBottomForm}>
        {activeAiTool ? (
          <div
            className='nodrag nopan flex w-full min-w-0 flex-col bg-background-default-secondary text-text-default-base'
            aria-label={t('project.textAi.bottomSheet', 'Text AI input')}
          >
            <LocalTextAiToolFormPanel
              activeTool={activeAiTool}
              hasDocumentText={hasDocumentText}
              fields={aiFields}
              onActiveToolChange={setActiveAiTool}
              onFieldsChange={setAiFields}
              onMockRun={handleMockAiRun}
              isRunning={aiRunning}
            />
          </div>
        ) : null}
      </FlowNodeToolbar>
      <div className='relative'>
        <div className='absolute left-0 right-0 top-0 min-w-0 -translate-y-full overflow-hidden text-left text-foreground/60'>
          <LocalNodeHeader nodeId={id} nodeType={String(type)} title={title} />
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
          <LocalDataNodeHandle
            type='target'
            position={Position.Left}
            handleId={targetHandleId}
            nodeId={id}
            selected={selected}
            nodeHovered={nodeHovered}
            isInsideLockedGroup={false}
          />
          <LocalDataNodeHandle
            type='source'
            position={Position.Right}
            handleId={sourceHandleId}
            nodeId={id}
            selected={selected}
            nodeHovered={nodeHovered}
            isInsideLockedGroup={false}
          />
          <div className='flex h-full flex-1 flex-col p-3'>
            {isEmpty && !hasActivated ? (
              <div
                className='flex h-full w-full cursor-pointer items-center justify-center overflow-hidden rounded-[8px]'
                onClick={(e) => {
                  e.stopPropagation();
                  setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleEmptyStateDoubleClick(e);
                }}
              >
                <div className='flex w-full flex-col items-center justify-center gap-2'>
                  <Icon name='project-text-node-placeholder' width={42} height={42} className='text-text-default-tertiary' />
                  <div className='text-center text-[12px] font-normal text-text-default-tertiary'>
                    {t('project.toolbar.textNodePlaceholder')
                      .split('\n')
                      .map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                  </div>
                </div>
              </div>
            ) : !showContent ? (
              <LocalNodeSkeleton />
            ) : (
              <div className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-[4px] bg-background-default-base'>
                <LocalTextNodeContent
                  ref={contentRef}
                  value={textValue}
                  onChange={handleTextChange}
                  placeholder={t('project.toolbar.pleaseInputTexts')}
                  selected={selected}
                  isEditing={isEditing}
                  onEnterEditMode={() => setContentEditingActive(true)}
                  onCopyClick={handleCopyContentClick}
                  onBlurWithEmpty={() => setHasActivated(false)}
                  chromeless
                  onFormatStateChange={setFloatingFormatState}
                />
              </div>
            )}
          </div>
          {data.localOutputPending ? <CanvasOutputPendingProgressOverlay /> : null}
        </div>
      </div>
    </>
  );
};

export default memo(TextNode);
