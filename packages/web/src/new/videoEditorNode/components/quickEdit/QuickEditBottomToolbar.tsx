import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import { Icon } from '@/ui/icon';
import { Button } from '@/ui/button';
import Tooltip from '@/ui/tooltip';
import AgentComposerInput, {
  type AgentCanvasPickSurfaceRemovalDetail,
  type AgentComposerInputHandle,
} from '@/features/chat/components/AgentInput';
import AgentComposerTabs, { type AgentComposerUploadItem } from '@/features/chat/components/AgentComposerTabs';
import PlaybackPanel from '../playback/PlaybackPanel';

type QuickEditBottomToolbarProps = {
  active: boolean;
  videoRef: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  imageSrc: string;
  pendingPicks: Array<{ id: string }>;
  recognizedPicks: Array<{ id: string; name: string }>;
  onStartPick: () => void;
  onRemovePickBox: (id: string) => void;
  onClose: () => void;
  onSend: (content: string) => void;
};

const trailingSquareBtnClass =
  'flex h-10 w-10 shrink-0 cursor-pointer select-none items-center justify-center rounded-[6px] border border-[var(--color-border-default-base)] bg-background-default-base text-[var(--color-icon-base)] transition-colors hover:bg-[var(--color-background-default-base-hover)]';
const disabledLeftSlotClass =
  'inline-flex h-[40px] items-center gap-1.5 rounded-full border border-[#C8C8C8] px-4 text-[12px] font-semibold !text-text-disabled-base cursor-not-allowed bg-[var(--color-background-default-base)]';

const QuickEditBottomToolbar: React.FC<QuickEditBottomToolbarProps> = ({
  active,
  videoRef,
  mediaSrc,
  currentTime,
  duration,
  isPlaying,
  volume,
  imageSrc,
  pendingPicks,
  recognizedPicks,
  onStartPick,
  onRemovePickBox,
  onClose,
  onSend,
}) => {
  const inputRef = useRef<AgentComposerInputHandle>(null);
  const [inputEmpty, setInputEmpty] = useState(true);
  const processedPickIdsRef = useRef(new Set<string>());
  const recognizedPickNamesRef = useRef(new Map<string, string>());
  const [uploadItems, setUploadItems] = useState<AgentComposerUploadItem[]>([]);
  const uploadItemsRef = useRef<AgentComposerUploadItem[]>([]);
  uploadItemsRef.current = uploadItems;

  useEffect(() => {
    if (!active) return;
    inputRef.current?.clear();
    setInputEmpty(true);
    processedPickIdsRef.current.clear();
    recognizedPickNamesRef.current.clear();
    setUploadItems((prev) => {
      prev.forEach((item) => {
        if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
      });
      return [];
    });
  }, [active]);

  useEffect(
    () => () => {
      uploadItemsRef.current.forEach((item) => {
        if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
      });
    },
    [],
  );

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    for (const box of pendingPicks) {
      if (processedPickIdsRef.current.has(box.id)) continue;
      const appended = input.appendCanvasPickRecognizingPlaceholder(box.id);
      if (appended) {
        processedPickIdsRef.current.add(box.id);
      }
    }
  }, [pendingPicks]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    for (const box of recognizedPicks) {
      const prevName = recognizedPickNamesRef.current.get(box.id);
      if (!prevName) {
        let hasInsertAnchor = processedPickIdsRef.current.has(box.id);
        if (!hasInsertAnchor) {
          input.focusEditor();
          const appended = input.appendCanvasPickRecognizingPlaceholder(box.id);
          processedPickIdsRef.current.add(box.id);
          hasInsertAnchor = appended;
          if (!appended) {
            input.addResourceFromUrl(imageSrc, box.name || 'Image', 'image');
          }
        }
        if (hasInsertAnchor) {
          input.replaceCanvasPickPlaceholderWithImageChip(box.id, imageSrc, box.name);
          input.replaceCanvasPickChipById(box.id, imageSrc, box.name, 'image');
        }
        recognizedPickNamesRef.current.set(box.id, box.name);
        continue;
      }
      if (prevName !== box.name) {
        input.replaceCanvasPickChipById(box.id, imageSrc, box.name, 'image');
        recognizedPickNamesRef.current.set(box.id, box.name);
      }
    }
  }, [recognizedPicks, imageSrc]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const currentIds = new Set([...pendingPicks.map((box) => box.id), ...recognizedPicks.map((box) => box.id)]);
    for (const pickId of Array.from(processedPickIdsRef.current)) {
      if (currentIds.has(pickId)) continue;
      input.removeCanvasPickPlaceholder(pickId);
      processedPickIdsRef.current.delete(pickId);
      recognizedPickNamesRef.current.delete(pickId);
    }
  }, [pendingPicks, recognizedPicks]);

  const handleSendClick = () => {
    const input = inputRef.current;
    if (!input || input.isEmpty()) return;
    const content = input.getHtml();
    onSend(content);
    input.clear();
    setInputEmpty(true);
  };

  const mapFileToUploadItem = useCallback(async (file: File): Promise<AgentComposerUploadItem> => {
    const id = crypto.randomUUID();
    if (file.type.startsWith('image/')) {
      return { id, type: 'image', previewUrl: URL.createObjectURL(file), name: file.name };
    }
    if (file.type.startsWith('video/')) {
      return { id, type: 'video', previewUrl: URL.createObjectURL(file), name: file.name };
    }
    if (file.type.startsWith('audio/')) {
      return { id, type: 'audio', previewUrl: URL.createObjectURL(file), name: file.name };
    }
    if (file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')) {
      const content = await file.text();
      return { id, type: 'text', previewUrl: content, name: file.name };
    }
    return { id, type: 'file', previewUrl: file.name, name: file.name };
  }, []);

  const handleComposerFiles = useCallback(
    (files: File[]) => {
      void (async () => {
        const mapped = await Promise.all(files.map(mapFileToUploadItem));
        setUploadItems((prev) => [...prev, ...mapped]);
      })();
    },
    [mapFileToUploadItem],
  );

  const handleRemoveUpload = useCallback((id: string) => {
    setUploadItems((prev) => {
      const hit = prev.find((item) => item.id === id);
      if (hit?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const handleUploadItemClick = useCallback((item: AgentComposerUploadItem) => {
    inputRef.current?.focusEditor();
    if (item.type === 'image' && item.previewUrl) {
      inputRef.current?.addResourceFromUrl(item.previewUrl, item.name ?? 'Image', 'image');
      return;
    }
    if (item.type === 'text') {
      inputRef.current?.addResourceFromUrl(item.previewUrl ?? '', item.name ?? 'Text', 'text');
      return;
    }
    if (item.previewUrl) {
      inputRef.current?.addResourceFromUrl(item.previewUrl, item.name ?? 'File', item.type);
    }
  }, []);

  const handleCanvasPickSurfaceRemoved = useCallback(
    (detail: AgentCanvasPickSurfaceRemovalDetail) => {
      onRemovePickBox(detail.placeholderId);
    },
    [onRemovePickBox],
  );

  const handleAddToInput = useCallback(() => {
    if (!imageSrc) return;
    inputRef.current?.addResourceFromUrl(imageSrc, 'Image', 'image');
  }, [imageSrc]);

  if (!active) return null;

  return (
    <div className='nodrag nopan pointer-events-auto flex w-[min(680px,92vw)] flex-col items-center gap-2'>
      <PlaybackPanel
        videoRef={videoRef}
        mediaSrc={mediaSrc}
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        volume={volume}
        hideFilmstripAndWaveform
      />
      <div
        className='flex w-[min(520px,92vw)] flex-col gap-2 overflow-hidden rounded-[16px] border border-[#DBDBDB] bg-background-default-base p-[10px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='min-w-0'>
          <AgentComposerTabs
            upstreamItems={[]}
            uploadItems={uploadItems}
            onUpstreamItemClick={() => {}}
            onRemoveUpstreamItem={() => {}}
            onFilesSelected={handleComposerFiles}
            onRemoveUpload={handleRemoveUpload}
            onUploadItemClick={handleUploadItemClick}
            onLayoutClick={onStartPick}
            onMentionClick={onStartPick}
            onTrailingClick={handleAddToInput}
            showMention={false}
            showUploadDivider={false}
            showTrailingDivider={false}
            trailingActionsSlot={
              <Tooltip title='Exit quick edit' placement='top' offset={4} triggerClassName='self-start'>
                <button
                  type='button'
                  className={trailingSquareBtnClass}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={onClose}
                  aria-label='Exit quick edit'
                >
                  <Icon name='imageEditor-multi-angle-close-icon' width={16} height={16} />
                </button>
              </Tooltip>
            }
            disabled={!active}
          />
        </div>

        <div className='flex h-[100px] flex-col overflow-hidden rounded-[8px] border border-[var(--color-border-default-base)] bg-background-default-base'>
          <AgentComposerInput
            ref={inputRef}
            canvasPickSourceId='video-editor-quick-edit'
            className='flex-1 !cursor-text'
            placeholder='Please describe the modifications you want here.'
            disabled={!active}
            onEnterSend={handleSendClick}
            onEmptyChange={setInputEmpty}
            upstreamItems={[]}
            uploadItems={uploadItems}
            onCanvasPickSurfaceRemoved={handleCanvasPickSurfaceRemoved}
          />
        </div>

        <div className='flex items-center justify-between gap-2'>
          <Button
            type='default'
            shape='round'
            disabled
            className={disabledLeftSlotClass}
            aria-label='Nano Banana Pro disabled'
          >
            <Icon
              name='imageEditor-nano-banana-pro-icon'
              width={16}
              height={17}
              color='var(--color-bg-icon-tertiary-hover)'
            />
            <span className='text-text-disabled-base'>Nano Banana Pro</span>
          </Button>
          <div className='flex items-center gap-2'>
            <div className='flex h-[28px] items-center gap-1 text-xs font-bold text-text-disabled-base'>
              <Icon name='imageEditor-nano-banana-credit-icon' width={18} height={18} />
              <span>120</span>
            </div>
            <Button
              type='primary'
              size='medium'
              shape='round'
              disabled={!active || inputEmpty}
              icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
              onClick={handleSendClick}
              className='!h-[28px] w-[52px] shrink-0 !border-[#35C838] !bg-[#35C838] !py-[2px] !pl-[16px] !pr-[12px] hover:!border-[#35C838] hover:!bg-[#35C838] disabled:!border-[#CDCDCD] disabled:!bg-[#CDCDCD]'
              aria-label='Send quick edit'
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuickEditBottomToolbar;
