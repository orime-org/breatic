import React, { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { useCanvasUI } from '@/spaces/canvas/hooks/useCanvasUI';
import { Icon } from '@/ui/icon';
import { Image } from '@/ui/image';
import Divider from '@/ui/divider';
import { message } from '@/ui/message';
import type { ResourceTypeForInput } from '@/store/modules/canvas';
import Video from '@/spaces/canvas/common/Video';
import { sanitizeRichText } from '@/utils/sanitize';
import AudioWaveformPlayer from '@/spaces/canvas/common/AudioWaveformPlayer';

const markdownProseClass =
  '[&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_pre]:bg-black/10 [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto [&_code]:px-1 [&_code]:rounded [&_code]:bg-black/10 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-[var(--color-text-link)] [&_a]:underline [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_strong]:font-semibold';

const isLikelyMarkdown = (text: string) => {
  // Simple heuristic: if common markdown structures match, use markdown rendering
  return /(^|\n)\s{0,3}#{1,6}\s/m.test(text) || /\*\*[^*]+\*\*|```/.test(text) || /\n- |\n\* /m.test(text);
};

const renderOutputContent = (params: {
  isSuccess: boolean;
  recordType: HistoryRecordType;
  outputContent: string;
  outputIsHtmlContent: boolean;
  fallbackTypeLabel: string;
}) => {
  const { isSuccess, recordType, outputContent, outputIsHtmlContent, fallbackTypeLabel } = params;

  if (outputIsHtmlContent) {
    return (
      <div className='mt-2 rounded-lg'>
        <div className='text-[12px] text-text-default-base leading-relaxed break-words break-all min-w-0 overflow-hidden inline-flex flex-wrap items-center gap-0.5'>
          <span
            className='chat-message-html break-all min-w-0 [&_img]:h-[16px] [&_img]:w-[16px] [&_img]:rounded [&_img]:object-cover'
            dangerouslySetInnerHTML={{ __html: sanitizeRichText(outputContent) }}
          />
        </div>
      </div>
    );
  }

  if (isSuccess && recordType === HistoryRecordType.Image) {
    return (
      <div className='mt-2 overflow-hidden rounded-lg border border-border-default-base'>
        <Image
          src={outputContent}
          alt=''
          preview={false}
          lazy={false}
          className='block w-full'
          imgClassName='block w-full h-auto object-cover'
        />
      </div>
    );
  }

  if (isSuccess && recordType === HistoryRecordType.Video) {
    return (
      <div className='mt-2 overflow-hidden rounded-lg border border-border-default-base bg-black'>
        <div className='aspect-video w-full min-h-0'>
          <Video src={outputContent} showControlBar className='!rounded-none h-full w-full' />
        </div>
      </div>
    );
  }

  if (isSuccess && recordType === HistoryRecordType.Audio) {
    return (
      <div className='mt-2 rounded-lg border border-border-default-base px-2 py-2'>
        <AudioWaveformPlayer
          src={outputContent}
          label={outputContent.split('/').pop()?.split('?')[0] || 'Audio'}
          showControls
        />
      </div>
    );
  }

  return (
    <div className={isSuccess ? 'mt-2' : 'mt-2 bg-[#FF375F]/20 border border-[#ef4444]/25 rounded-lg px-2 py-2'}>
      {!isSuccess ? (
        <div className='whitespace-pre-wrap text-[11px] text-[#dc2626] font-normal leading-relaxed'>
          {outputContent}
        </div>
      ) : (
        <div className='text-[12px] text-text-default-tertiary'>
          {isLikelyMarkdown(outputContent) ? (
            <div className={`chat-message-markdown ${markdownProseClass}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{outputContent}</ReactMarkdown>
            </div>
          ) : (
            <div className='whitespace-pre-wrap'>{outputContent || fallbackTypeLabel}</div>
          )}
        </div>
      )}
    </div>
  );
};

interface CanvasRightOverlayPanelProps {
  onClose: () => void;
}

enum HistoryRecordStatus {
  Success = 'success',
  Failed = 'failed',
}

enum HistoryRecordType {
  Text = 'text',
  Image = 'image',
  Video = 'video',
  Audio = 'audio',
}

interface HistoryRecordStaticItem {
  uid: string;
  index: number;
  status: HistoryRecordStatus;
  credits: number;
  type: HistoryRecordType;
  /** Output display content */
  outputContent?: string;
  /** Input display content */
  inputContent?: string;
  userName: string;
  date: string;
  time: string;
}

const typeTitleMap: Record<string, string> = {
  '1001': 'Text',
  '1002': 'Image',
  '1003': 'Video',
  '1004': 'Audio',
  group: 'Group',
};

const CanvasRightOverlayPanel: React.FC<CanvasRightOverlayPanelProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const { nodes } = useCanvasData();
  const { updateNode } = useCanvasActions();
  const { canvasOverlayPanel } = useCanvasUI();
  const node = canvasOverlayPanel.nodeId ? nodes.find((n) => n.id === canvasOverlayPanel.nodeId) : null;
  const typeTitle = node?.type ? (typeTitleMap[node.type as string] ?? 'Node') : 'Node';
  const title = `${typeTitle} Node`;

  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  const toggleCollapsed = (uid: string) => {
    setCollapsedMap((prev) => ({ ...prev, [uid]: !(prev[uid] ?? false) }));
  };

  // Static “execution history” data (no API dependency)
  const historyRecords: HistoryRecordStaticItem[] = [
    {
      uid: 'r-5',
      index: 5,
      status: HistoryRecordStatus.Success,
      credits: 60,
      type: HistoryRecordType.Image,
      outputContent: 'https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png',
      inputContent:
        'Generate a portrait image of Marie Curie, the pioneering physicist and chemist known for her research on radioactivity. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" data-resource-index="0" data-resource-type="image" data-resource-source="attach" data-resource-is-image="true" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><img src="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" alt="image-1773917131365.png" class="w-[16px] h-[16px] object-cover rounded-[4px] shrink-0"><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">image-1773917131365.png</span></span> This portrait should capture her intellectual demeanor and iconic style from the early 20th century. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/video/1773918758359-8ujc5n.mp4" data-resource-index="1" data-resource-type="video" data-resource-source="attach" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><span class="relative w-[14px] h-[14px] rounded-[2px] shrink-0 overflow-hidden bg-[var(--color-background-default-secondary)]"><img alt="1773918758359-8ujc5n.mp4" class="w-full h-full object-cover" aria-hidden="true" src="https://resource.visiony.cc/upload/video/1773918758359-8ujc5n.mp4"><span class="absolute inset-0 flex items-center justify-center bg-black/20 rounded-[2px] pointer-events-none"><svg width="6" height="6" class="text-white drop-shadow" fill="currentColor"><use href="#icon-project-play_audio_icon"></use></svg></span></span><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">1773918758359-8ujc5n.mp4</span></span> Include subtle elements that reference her Nobel Prize-winning work on radium and polonium. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" data-resource-index="2" data-resource-type="image" data-resource-source="attach" data-resource-is-image="true" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><img src="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" alt="image-1773917131365.png" class="w-[16px] h-[16px] object-cover rounded-[4px] shrink-0"><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">image-1773917131365.png</span></span> The color palette should reflect the era, with muted tones and a focus on her facial features. <span contenteditable="false" data-resource="FBEC2023 Annual Conference: 8th Golden Gyroscope Awards on December 8 in Shenzhen" data-resource-index="3" data-resource-type="text" data-resource-source="attach" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><span class="w-[16px] h-[16px] rounded-[4px] shrink-0 inline-flex items-center justify-center bg-[var(--color-background-default-secondary)]" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" class="text-[var(--bg-icon-base)]" fill="currentColor"><path d="M3.66667 1.875H1C0.722222 1.875 0.486111 1.78385 0.291667 1.60156C0.0972222 1.41927 0 1.19792 0 0.9375C0 0.677083 0.0972222 0.455729 0.291667 0.273438C0.486111 0.0911458 0.722222 0 1 0H8.33333C8.61111 0 8.84722 0.0911458 9.04167 0.273438C9.23611 0.455729 9.33333 0.677083 9.33333 0.9375C9.33333 1.19792 9.23611 1.41927 9.04167 1.60156C8.84722 1.78385 8.61111 1.875 8.33333 1.875H5.66667V9.0625C5.66667 9.32292 5.56944 9.54427 5.375 9.72656C5.18056 9.90885 4.94444 10 4.66667 10C4.38889 10 4.15278 9.90885 3.95833 9.72656C3.76389 9.54427 3.66667 9.32292 3.66667 9.0625V1.875Z" fill="currentColor"></path></svg></span><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">new-text-document.txt</span></span>',
      userName: 'Username',
      date: '18 / 3 / 2026',
      time: '4.5s',
    },
    {
      uid: 'r-4',
      index: 4,
      status: HistoryRecordStatus.Success,
      credits: 60,
      type: HistoryRecordType.Video,
      outputContent: 'https://resource.visiony.cc/upload/video/1774005550384-9kxupk.mp4',
      inputContent:
        'Generate a portrait image of Marie Curie, the pioneering physicist and chemist known for her research on radioactivity. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" data-resource-index="0" data-resource-type="image" data-resource-source="attach" data-resource-is-image="true" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><img src="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" alt="image-1773917131365.png" class="w-[16px] h-[16px] object-cover rounded-[4px] shrink-0"><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">image-1773917131365.png</span></span> This portrait should capture her intellectual demeanor and iconic style from the early 20th century. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/video/1773918758359-8ujc5n.mp4" data-resource-index="1" data-resource-type="video" data-resource-source="attach" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><span class="relative w-[14px] h-[14px] rounded-[2px] shrink-0 overflow-hidden bg-[var(--color-background-default-secondary)]"><img alt="1773918758359-8ujc5n.mp4" class="w-full h-full object-cover" aria-hidden="true" src="https://resource.visiony.cc/upload/video/1773918758359-8ujc5n.mp4"><span class="absolute inset-0 flex items-center justify-center bg-black/20 rounded-[2px] pointer-events-none"><svg width="6" height="6" class="text-white drop-shadow" fill="currentColor"><use href="#icon-project-play_audio_icon"></use></svg></span></span><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">1773918758359-8ujc5n.mp4</span></span> Include subtle elements that reference her Nobel Prize-winning work on radium and polonium. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" data-resource-index="2" data-resource-type="image" data-resource-source="attach" data-resource-is-image="true" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><img src="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" alt="image-1773917131365.png" class="w-[16px] h-[16px] object-cover rounded-[4px] shrink-0"><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">image-1773917131365.png</span></span> The color palette should reflect the era, with muted tones and a focus on her facial features. <span contenteditable="false" data-resource="FBEC2023 Annual Conference: 8th Golden Gyroscope Awards on December 8 in Shenzhen" data-resource-index="3" data-resource-type="text" data-resource-source="attach" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><span class="w-[16px] h-[16px] rounded-[4px] shrink-0 inline-flex items-center justify-center bg-[var(--color-background-default-secondary)]" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" class="text-[var(--bg-icon-base)]" fill="currentColor"><path d="M3.66667 1.875H1C0.722222 1.875 0.486111 1.78385 0.291667 1.60156C0.0972222 1.41927 0 1.19792 0 0.9375C0 0.677083 0.0972222 0.455729 0.291667 0.273438C0.486111 0.0911458 0.722222 0 1 0H8.33333C8.61111 0 8.84722 0.0911458 9.04167 0.273438C9.23611 0.455729 9.33333 0.677083 9.33333 0.9375C9.33333 1.19792 9.23611 1.41927 9.04167 1.60156C8.84722 1.78385 8.61111 1.875 8.33333 1.875H5.66667V9.0625C5.66667 9.32292 5.56944 9.54427 5.375 9.72656C5.18056 9.90885 4.94444 10 4.66667 10C4.38889 10 4.15278 9.90885 3.95833 9.72656C3.76389 9.54427 3.66667 9.32292 3.66667 9.0625V1.875Z" fill="currentColor"></path></svg></span><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">new-text-document.txt</span></span>',
      userName: 'Username',
      date: '18 / 3 / 2026',
      time: '4.5s',
    },
    {
      uid: 'r-3',
      index: 3,
      status: HistoryRecordStatus.Success,
      credits: 60,
      type: HistoryRecordType.Text,
      outputContent:
        'FBEC2023 Annual Conference and 8th Golden Gyroscope Awards Ceremony to be held on December 8 in Shenzhen',
      inputContent:
        'Generate a portrait image of Marie Curie, the pioneering physicist and chemist known for her research on radioactivity. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" data-resource-index="0" data-resource-type="image" data-resource-source="attach" data-resource-is-image="true" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><img src="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" alt="image-1773917131365.png" class="w-[16px] h-[16px] object-cover rounded-[4px] shrink-0"><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">image-1773917131365.png</span></span> This portrait should capture her intellectual demeanor and iconic style from the early 20th century. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/video/1773918758359-8ujc5n.mp4" data-resource-index="1" data-resource-type="video" data-resource-source="attach" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><span class="relative w-[14px] h-[14px] rounded-[2px] shrink-0 overflow-hidden bg-[var(--color-background-default-secondary)]"><img alt="1773918758359-8ujc5n.mp4" class="w-full h-full object-cover" aria-hidden="true" src="https://resource.visiony.cc/upload/video/1773918758359-8ujc5n.mp4"><span class="absolute inset-0 flex items-center justify-center bg-black/20 rounded-[2px] pointer-events-none"><svg width="6" height="6" class="text-white drop-shadow" fill="currentColor"><use href="#icon-project-play_audio_icon"></use></svg></span></span><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">1773918758359-8ujc5n.mp4</span></span> Include subtle elements that reference her Nobel Prize-winning work on radium and polonium. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" data-resource-index="2" data-resource-type="image" data-resource-source="attach" data-resource-is-image="true" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><img src="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" alt="image-1773917131365.png" class="w-[16px] h-[16px] object-cover rounded-[4px] shrink-0"><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">image-1773917131365.png</span></span> The color palette should reflect the era, with muted tones and a focus on her facial features. <span contenteditable="false" data-resource="FBEC2023 Annual Conference: 8th Golden Gyroscope Awards on December 8 in Shenzhen" data-resource-index="3" data-resource-type="text" data-resource-source="attach" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><span class="w-[16px] h-[16px] rounded-[4px] shrink-0 inline-flex items-center justify-center bg-[var(--color-background-default-secondary)]" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" class="text-[var(--bg-icon-base)]" fill="currentColor"><path d="M3.66667 1.875H1C0.722222 1.875 0.486111 1.78385 0.291667 1.60156C0.0972222 1.41927 0 1.19792 0 0.9375C0 0.677083 0.0972222 0.455729 0.291667 0.273438C0.486111 0.0911458 0.722222 0 1 0H8.33333C8.61111 0 8.84722 0.0911458 9.04167 0.273438C9.23611 0.455729 9.33333 0.677083 9.33333 0.9375C9.33333 1.19792 9.23611 1.41927 9.04167 1.60156C8.84722 1.78385 8.61111 1.875 8.33333 1.875H5.66667V9.0625C5.66667 9.32292 5.56944 9.54427 5.375 9.72656C5.18056 9.90885 4.94444 10 4.66667 10C4.38889 10 4.15278 9.90885 3.95833 9.72656C3.76389 9.54427 3.66667 9.32292 3.66667 9.0625V1.875Z" fill="currentColor"></path></svg></span><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">new-text-document.txt</span></span>',
      userName: 'Username',
      date: '18 / 3 / 2026',
      time: '4.5s',
    },
    {
      uid: 'r-2',
      index: 2,
      status: HistoryRecordStatus.Success,
      credits: 60,
      type: HistoryRecordType.Audio,
      outputContent: 'https://resource.visiony.cc/upload/audio/1774055940264-wdhlit.mp3',
      inputContent:
        'Generate a portrait image of Marie Curie, the pioneering physicist and chemist known for her research on radioactivity. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" data-resource-index="0" data-resource-type="image" data-resource-source="attach" data-resource-is-image="true" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><img src="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" alt="image-1773917131365.png" class="w-[16px] h-[16px] object-cover rounded-[4px] shrink-0"><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">image-1773917131365.png</span></span> This portrait should capture her intellectual demeanor and iconic style from the early 20th century. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/video/1773918758359-8ujc5n.mp4" data-resource-index="1" data-resource-type="video" data-resource-source="attach" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><span class="relative w-[14px] h-[14px] rounded-[2px] shrink-0 overflow-hidden bg-[var(--color-background-default-secondary)]"><img alt="1773918758359-8ujc5n.mp4" class="w-full h-full object-cover" aria-hidden="true" src="https://resource.visiony.cc/upload/video/1773918758359-8ujc5n.mp4"><span class="absolute inset-0 flex items-center justify-center bg-black/20 rounded-[2px] pointer-events-none"><svg width="6" height="6" class="text-white drop-shadow" fill="currentColor"><use href="#icon-project-play_audio_icon"></use></svg></span></span><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">1773918758359-8ujc5n.mp4</span></span> Include subtle elements that reference her Nobel Prize-winning work on radium and polonium. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" data-resource-index="2" data-resource-type="image" data-resource-source="attach" data-resource-is-image="true" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><img src="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" alt="image-1773917131365.png" class="w-[16px] h-[16px] object-cover rounded-[4px] shrink-0"><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">image-1773917131365.png</span></span> The color palette should reflect the era, with muted tones and a focus on her facial features. <span contenteditable="false" data-resource="FBEC2023 Annual Conference: 8th Golden Gyroscope Awards on December 8 in Shenzhen" data-resource-index="3" data-resource-type="text" data-resource-source="attach" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><span class="w-[16px] h-[16px] rounded-[4px] shrink-0 inline-flex items-center justify-center bg-[var(--color-background-default-secondary)]" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" class="text-[var(--bg-icon-base)]" fill="currentColor"><path d="M3.66667 1.875H1C0.722222 1.875 0.486111 1.78385 0.291667 1.60156C0.0972222 1.41927 0 1.19792 0 0.9375C0 0.677083 0.0972222 0.455729 0.291667 0.273438C0.486111 0.0911458 0.722222 0 1 0H8.33333C8.61111 0 8.84722 0.0911458 9.04167 0.273438C9.23611 0.455729 9.33333 0.677083 9.33333 0.9375C9.33333 1.19792 9.23611 1.41927 9.04167 1.60156C8.84722 1.78385 8.61111 1.875 8.33333 1.875H5.66667V9.0625C5.66667 9.32292 5.56944 9.54427 5.375 9.72656C5.18056 9.90885 4.94444 10 4.66667 10C4.38889 10 4.15278 9.90885 3.95833 9.72656C3.76389 9.54427 3.66667 9.32292 3.66667 9.0625V1.875Z" fill="currentColor"></path></svg></span><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">new-text-document.txt</span></span>',
      userName: 'Username',
      date: '18 / 3 / 2026',
      time: '4.5s',
    },
    {
      uid: 'r-1',
      index: 1,
      status: HistoryRecordStatus.Failed,
      credits: 60,
      type: HistoryRecordType.Text,
      outputContent:
        'Error code 40043\nPrompt contains unsafe content.\nGeneration failed.\nPlease revise your prompt and try again.',
      inputContent:
        'Generate a portrait image of Marie Curie, the pioneering physicist and chemist known for her research on radioactivity. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" data-resource-index="0" data-resource-type="image" data-resource-source="attach" data-resource-is-image="true" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><img src="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" alt="image-1773917131365.png" class="w-[16px] h-[16px] object-cover rounded-[4px] shrink-0"><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">image-1773917131365.png</span></span> This portrait should capture her intellectual demeanor and iconic style from the early 20th century. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/video/1773918758359-8ujc5n.mp4" data-resource-index="1" data-resource-type="video" data-resource-source="attach" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><span class="relative w-[14px] h-[14px] rounded-[2px] shrink-0 overflow-hidden bg-[var(--color-background-default-secondary)]"><img alt="1773918758359-8ujc5n.mp4" class="w-full h-full object-cover" aria-hidden="true" src="https://resource.visiony.cc/upload/video/1773918758359-8ujc5n.mp4"><span class="absolute inset-0 flex items-center justify-center bg-black/20 rounded-[2px] pointer-events-none"><svg width="6" height="6" class="text-white drop-shadow" fill="currentColor"><use href="#icon-project-play_audio_icon"></use></svg></span></span><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">1773918758359-8ujc5n.mp4</span></span> Include subtle elements that reference her Nobel Prize-winning work on radium and polonium. <span contenteditable="false" data-resource="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" data-resource-index="2" data-resource-type="image" data-resource-source="attach" data-resource-is-image="true" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><img src="https://resource.visiony.cc/upload/image/1773917131365-3ozvb5.png" alt="image-1773917131365.png" class="w-[16px] h-[16px] object-cover rounded-[4px] shrink-0"><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">image-1773917131365.png</span></span> The color palette should reflect the era, with muted tones and a focus on her facial features. <span contenteditable="false" data-resource="FBEC2023 Annual Conference: 8th Golden Gyroscope Awards on December 8 in Shenzhen" data-resource-index="3" data-resource-type="text" data-resource-source="attach" class="inline-flex items-center gap-1 align-middle max-w-[126px] py-0.5 px-2 mx-0.5 rounded-full border border-[var(--color-border-default-base)] min-w-0 cursor-pointer"><span class="h-[6px] w-[6px] shrink-0 rounded-full" style="background-color: rgb(245, 166, 35);"></span><span class="w-[16px] h-[16px] rounded-[4px] shrink-0 inline-flex items-center justify-center bg-[var(--color-background-default-secondary)]" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" class="text-[var(--bg-icon-base)]" fill="currentColor"><path d="M3.66667 1.875H1C0.722222 1.875 0.486111 1.78385 0.291667 1.60156C0.0972222 1.41927 0 1.19792 0 0.9375C0 0.677083 0.0972222 0.455729 0.291667 0.273438C0.486111 0.0911458 0.722222 0 1 0H8.33333C8.61111 0 8.84722 0.0911458 9.04167 0.273438C9.23611 0.455729 9.33333 0.677083 9.33333 0.9375C9.33333 1.19792 9.23611 1.41927 9.04167 1.60156C8.84722 1.78385 8.61111 1.875 8.33333 1.875H5.66667V9.0625C5.66667 9.32292 5.56944 9.54427 5.375 9.72656C5.18056 9.90885 4.94444 10 4.66667 10C4.38889 10 4.15278 9.90885 3.95833 9.72656C3.76389 9.54427 3.66667 9.32292 3.66667 9.0625V1.875Z" fill="currentColor"></path></svg></span><span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs">new-text-document.txt</span></span>',
      userName: 'Username',
      date: '18 / 3 / 2026',
      time: '1 min 30s',
    },
  ];

  const getResourceTypeForInput = (recordType: HistoryRecordType): ResourceTypeForInput => {
    switch (recordType) {
      case HistoryRecordType.Image:
        return 'image';
      case HistoryRecordType.Text:
        return 'text';
      case HistoryRecordType.Video:
        return 'video';
      case HistoryRecordType.Audio:
        return 'audio';
      default:
        return 'file';
    }
  };

  const getResourceTypeForInputByNodeType = (nodeType?: string): ResourceTypeForInput | null => {
    // Data node type mapping (see `src/apps/project/index.tsx` nodeTypes)
    switch (nodeType) {
      case '1001':
        return 'text';
      case '1002':
        return 'image';
      case '1003':
        return 'video';
      case '1004':
        return 'audio';
      default:
        return null;
    }
  };

  const targetNodeResourceType = getResourceTypeForInputByNodeType(node?.type as string | undefined);
  const isTargetNodeSelected = !!node?.selected;

  const downloadImageFromUrl = async (url: string) => {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(res.statusText);
    const blob = await res.blob();
    const ext = url.split('?')[0].match(/\.(jpe?g|png|webp|gif|tiff?)$/i)?.[1] || 'jpg';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `image-${Date.now()}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadTextAsFile = async (text: string, filename: string) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadRecordOutput = async (opts: { content: string; showImageOutput: boolean; recordIndex: number }) => {
    const { content, showImageOutput, recordIndex } = opts;
    const text = content ?? '';
    if (!text.trim()) {
      message.warning('No content to download');
      return;
    }

    const firstResourceFromHtml = parseFirstResourceFromContent(text);
    if (firstResourceFromHtml?.type === 'image') {
      try {
        await downloadImageFromUrl(firstResourceFromHtml.url);
      } catch (err) {
        console.error('Failed to download image:', err);
        message.warning('Download failed');
      }
      return;
    }

    if (showImageOutput) {
      try {
        await downloadImageFromUrl(text);
      } catch (err) {
        console.error('Failed to download image:', err);
        message.warning('Download failed');
      }
      return;
    }

    try {
      await downloadTextAsFile(text, `output-${recordIndex}.txt`);
    } catch (err) {
      console.error('Failed to download text:', err);
      message.warning('Download failed');
    }
  };

  const parseFirstResourceFromContent = (
    htmlOrText: string,
  ): { url: string; type: ResourceTypeForInput; name: string } | null => {
    if (!htmlOrText || !htmlOrText.includes('data-resource=')) return null;
    try {
      const doc = new DOMParser().parseFromString(htmlOrText, 'text/html');
      const span = doc.querySelector('span[data-resource]') as HTMLSpanElement | null;
      if (!span) return null;

      const url = span.getAttribute('data-resource') ?? '';
      if (!url.trim()) return null;

      const typeAttr = span.getAttribute('data-resource-type') ?? '';
      let type: ResourceTypeForInput = 'file';
      if (
        typeAttr === 'image' ||
        typeAttr === 'video' ||
        typeAttr === 'audio' ||
        typeAttr === 'text' ||
        typeAttr === 'file'
      ) {
        type = typeAttr;
      } else if (span.getAttribute('data-resource-is-image') === 'true') {
        type = 'image';
      }

      let name = '';
      const img = span.querySelector('img') as HTMLImageElement | null;
      const alt = img?.getAttribute('alt') ?? '';
      if (alt.trim()) name = alt.trim();

      if (!name) {
        const spans = Array.from(span.querySelectorAll('span'));
        const last = spans[spans.length - 1] as HTMLSpanElement | undefined;
        name = last?.textContent?.trim() ?? '';
      }

      return { url, type, name: name || 'Resource' };
    } catch (err) {
      console.error('Failed to parse resource:', err);
      return null;
    }
  };

  const copyRecordToClipboard = async (text: string) => {
    const raw = text ?? '';
    if (!raw.trim()) {
      // message.warning('No content to copy');
      return;
    }

    try {
      await navigator.clipboard.writeText(raw);
      // message.success('Copied to clipboard');
    } catch (err) {
      console.error('Copy failed:', err);
      // message.warning('Copy failed');
    }
  };

  const handleDownloadOutputClick = (output: string, showImage: boolean, recordIndex: number) => {
    void downloadRecordOutput({
      content: output,
      showImageOutput: showImage,
      recordIndex,
    });
  };

  const handleReplaceOutputToNodeContentClick = (payload: {
    nodeId: string;
    nodeType: ResourceTypeForInput;
    outputContent: string;
    parsedFirstResource: ReturnType<typeof parseFirstResourceFromContent>;
  }) => {
    const { nodeId, nodeType, outputContent, parsedFirstResource } = payload;

    // If outputContent contains data-resource, prefer the parsed real value (could be URL or plain text).
    const resolvedContent = parsedFirstResource?.type === nodeType ? parsedFirstResource.url : outputContent;

    updateNode(nodeId, {
      data: {
        nodeSelectedResultData: {
          resultType: 'content',
          content: resolvedContent,
          counter: resolvedContent.trim() ? 1 : 0,
        },
      },
    });
  };

  const handleCopyInputClick = (text: string) => {
    void copyRecordToClipboard(text);
  };

  return (
    <div className='h-full w-[350px] rounded-[8px] border border-border-default-base bg-background-default-base shadow-[0_8px_24px_rgba(0,0,0,0.12)] flex flex-col'>
      <div className='flex items-center justify-between p-[12px]'>
        <div className='flex items-center gap-2 min-w-0'>
          <Icon name='project-canvas-panel-info-icon' width={20} height={20} color='#444444' />
          <div className='text-[14px] font-medium text-text-default-base truncate'>{title}</div>
        </div>
        <button
          type='button'
          onClick={onClose}
          className='w-6 h-6 rounded flex items-center justify-center hover:bg-background-default-secondary'
        >
          <Icon name='project-canvas-panel-close-icon' width={16} height={16} color='#444444' />
        </button>
      </div>
      <div className='rounded-[6px] flex-1 min-h-0 overflow-y-auto flex flex-col px-[12px] mb-[12px]'>
        <div className='flex-1 min-h-0 flex flex-col gap-[12px]'>
          {historyRecords.length === 0 ? (
            <div className='flex-1 min-h-[200px] flex flex-col items-center justify-center gap-3 py-10 px-4 text-center'>
              <Icon name='project-node-runs-empty-icon' width={30} height={27} color='#B3B3B3' />
              <div className='text-[14px] font-semibold text-text-default-tertiary'>
                {t('project.canvas.noRunsYet', 'No runs yet')}
              </div>
              <p className='text-[12px] text-text-default-tertiary leading-relaxed max-w-[280px]'>
                {t(
                  'project.canvas.noRunsDescBefore',
                  'Each time you run this node, the result will appear here — inputs, outputs, and ',
                )}
                <span className='text-text-default-secondary'>
                  {t('project.canvas.noRunsCreditUsage', 'credit usage')}
                </span>
                {t('project.canvas.noRunsDescAfter', '.')}
              </p>
            </div>
          ) : null}
          {historyRecords.map((record) => {
            const isSuccess = record.status === HistoryRecordStatus.Success;
            const isCollapsed = collapsedMap[record.uid] ?? false;
            const outputContent = record.outputContent ?? '';
            const inputContent = record.inputContent ?? '';
            const outputIsHtmlContent = !!outputContent && outputContent.includes('data-resource=');
            const showImageOutput =
              isSuccess && record.type === HistoryRecordType.Image && !!outputContent && !outputIsHtmlContent;
            const hasOutputContent = !!outputContent?.trim();
            const hasInputContent = !!inputContent?.trim();

            const resourceTypeForInput = getResourceTypeForInput(record.type);
            const parsedFirstResource = parseFirstResourceFromContent(outputContent);
            const effectiveResourceTypeForInput = parsedFirstResource?.type ?? resourceTypeForInput;

            return (
              <div
                key={record.uid}
                className='rounded-xl border border-border-default-base bg-background-default-secondary'
              >
                <div className='flex items-center justify-between gap-2 p-[12px]'>
                  <div className='flex items-center gap-2 min-w-0'>
                    <div className='text-[14px] font-semibold text-text-default-base shrink-0'>{record.index}</div>
                    <div
                      className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] text-text-on-button-base font-semibold ${
                        isSuccess
                          ? 'bg-[#199A1B]  border border-[#199A1B]/25'
                          : 'bg-[#EC221F] border border-[#EC221F]/25'
                      }`}
                    >
                      {isSuccess ? 'Success' : 'Failed'}
                    </div>
                  </div>
                  <div className='flex items-center justify-center gap-2 shrink-0 text-[11px] text-text-default-tertiary'>
                    <span className='whitespace-nowrap leading-none'>{record.credits} credits</span>
                    <button
                      type='button'
                      onClick={() => toggleCollapsed(record.uid)}
                      className='w-6 h-6 rounded hover:bg-background-default-secondary inline-flex items-center justify-center cursor-pointer'
                    >
                      <Icon
                        name='base-chevron-down-icon'
                        width={14}
                        height={14}
                        color='var(--color-icon-secondary)'
                        className={isCollapsed ? 'rotate-0' : 'rotate-180'}
                      />
                    </button>
                  </div>
                </div>
                {!isCollapsed && <Divider />}
                {!isCollapsed && (
                  <>
                    <div className='p-[12px]'>
                      <div className='flex items-center justify-between gap-2'>
                        <div
                          className={`text-[12px] font-semibold shrink-0 ${isSuccess ? 'text-text-default-secondary' : 'text-[#EC221F]'}`}
                        >
                          {isSuccess ? 'Output' : 'Failed'}
                        </div>
                        {isSuccess && (
                          <div className='flex items-center gap-2 shrink-0'>
                            <button
                              type='button'
                              disabled={!hasOutputContent}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDownloadOutputClick(outputContent, showImageOutput, record.index);
                              }}
                              className='w-6 h-6 rounded hover:bg-background-default-secondary flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed'
                            >
                              <Icon
                                name='project-chat-download-icon'
                                width={18}
                                height={18}
                                color='var(--color-icon-secondary)'
                              />
                            </button>
                            <button
                              type='button'
                              disabled={
                                !hasOutputContent ||
                                !isTargetNodeSelected ||
                                !targetNodeResourceType ||
                                targetNodeResourceType !== effectiveResourceTypeForInput
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                // Safety guard: even if disabled style is bypassed (keyboard), prevent wrong mount.
                                if (
                                  !isTargetNodeSelected ||
                                  !targetNodeResourceType ||
                                  targetNodeResourceType !== effectiveResourceTypeForInput
                                )
                                  return;
                                if (!node?.id) return;
                                handleReplaceOutputToNodeContentClick({
                                  nodeId: node.id,
                                  nodeType: effectiveResourceTypeForInput,
                                  outputContent,
                                  parsedFirstResource,
                                });
                              }}
                              className='w-6 h-6 rounded hover:bg-background-default-secondary flex items-center justify-center disabled:opacity-50 disabled:pointer-events-none'
                            >
                              <Icon
                                name='project-chat-generated-add-to-input-icon'
                                width={17}
                                height={14}
                                color='var(--color-icon-secondary)'
                              />
                            </button>
                          </div>
                        )}
                      </div>
                      {renderOutputContent({
                        isSuccess,
                        recordType: record.type,
                        outputContent,
                        outputIsHtmlContent,
                        fallbackTypeLabel: record.type,
                      })}
                    </div>
                    <Divider />
                    <div className='p-[12px]'>
                      <div className='flex items-center justify-between gap-2'>
                        <div className='text-[12px] font-semibold text-text-default-secondary'>Input</div>
                        <button
                          type='button'
                          disabled={!hasInputContent}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyInputClick(inputContent);
                          }}
                          className='w-6 h-6 rounded hover:bg-background-default-secondary flex items-center justify-center disabled:opacity-50 disabled:pointer-events-none'
                        >
                          <Icon name='project-copy-icon' width={16} height={16} color='var(--color-icon-secondary)' />
                        </button>
                      </div>
                      <div className='mt-2 rounded-lg bg-background-default-base px-2 py-2'>
                        <div className='text-[12px] text-text-default-base leading-relaxed break-words break-all min-w-0 overflow-hidden inline-flex flex-wrap items-center gap-0.5'>
                          <span
                            className='chat-message-html break-all min-w-0 [&_img]:h-[16px] [&_img]:w-[16px] [&_img]:rounded [&_img]:object-cover'
                            dangerouslySetInnerHTML={{ __html: sanitizeRichText(inputContent) }}
                          />
                        </div>
                      </div>
                    </div>
                  </>
                )}
                <Divider />
                <div className='flex items-center justify-between text-[11px] text-text-default-tertiary p-[12px]'>
                  <div className='flex items-center gap-2 min-w-0'>
                    <span className='inline-flex w-6 h-6 rounded-full bg-[var(--color-background-default-secondary)] border border-border-default-base shrink-0' />
                    <span className='truncate max-w-[120px] leading-none'>{record.userName}</span>
                  </div>
                  <div className='flex items-center gap-2 shrink-0'>
                    <span className='whitespace-nowrap leading-none'>
                      {record.date} {record.time}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default memo(CanvasRightOverlayPanel);
