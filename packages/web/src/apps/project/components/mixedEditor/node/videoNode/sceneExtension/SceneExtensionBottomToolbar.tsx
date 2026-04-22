import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import Input from '@/components/base/input';
import Divider from '@/components/base/divider';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import PlaybackPanel from '../playback/PlaybackPanel';

export type SceneExtensionResolution = '1k' | '2k' | '4k';

type SceneExtensionBottomToolbarProps = {
  active: boolean;
  videoRef: React.RefObject<VideoRef | null>;
  mediaSrc?: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  width: number;
  height: number;
  containerWidth: number;
  containerHeight: number;
  onDimensionChange: (w: number, h: number, keepCentered?: boolean) => void;
  onClose: () => void;
  onSend: (payload: { width: number; height: number; resolution: SceneExtensionResolution; ratio: string }) => void;
};

type RatioOption = {
  key: string;
  label: string;
  icon: string;
  iconWidth: number;
  iconHeight: number;
};

const ratioOptions: RatioOption[] = [
  { key: 'free', label: 'Free Ratio', icon: 'imageEditor-crop-ratio-free-icon', iconWidth: 20, iconHeight: 16 },
  { key: 'original', label: 'Original', icon: 'imageEditor-crop-ratio-original-icon', iconWidth: 20, iconHeight: 16 },
  { key: '1:1', label: '1:1', icon: 'imageEditor-crop-ratio-1-1-icon', iconWidth: 18, iconHeight: 18 },
  { key: '2:3', label: '2:3', icon: 'imageEditor-crop-ratio-2-3-icon', iconWidth: 12, iconHeight: 18 },
  { key: '3:2', label: '3:2', icon: 'imageEditor-crop-ratio-3-2-icon', iconWidth: 18, iconHeight: 12 },
  { key: '3:4', label: '3:4', icon: 'imageEditor-crop-ratio-3-4-icon', iconWidth: 12, iconHeight: 16 },
  { key: '4:3', label: '4:3', icon: 'imageEditor-crop-ratio-4-3-icon', iconWidth: 16, iconHeight: 12 },
  { key: '9:16', label: '9:16', icon: 'imageEditor-crop-ratio-9-16-icon', iconWidth: 10, iconHeight: 18 },
  { key: '16:9', label: '16:9', icon: 'imageEditor-crop-ratio-16-9-icon', iconWidth: 18, iconHeight: 10 },
];

type ResolutionOption = {
  key: SceneExtensionResolution;
  badge: string;
  label: string;
};

const resolutionOptions: ResolutionOption[] = [
  { key: '1k', badge: 'SD', label: 'Enhance to 1K' },
  { key: '2k', badge: 'HD', label: 'Enhance to 2K' },
  { key: '4k', badge: 'UHD', label: 'Enhance to 4K' },
];

const resolutionLongEdge: Record<SceneExtensionResolution, number> = {
  '1k': 1024,
  '2k': 2048,
  '4k': 4096,
};

const renderResolutionBadge = (badge: string) => (
  <span className='inline-flex h-[16px] min-w-[24px] items-center justify-center rounded-[2px] border border-[#8E8E8E] bg-[#F6F6F6] px-1 text-[9px] font-bold leading-none tracking-[0.2px] text-[#6A6A6A]'>
    {badge}
  </span>
);

const resolutionOptionMap: Record<SceneExtensionResolution, ResolutionOption> = resolutionOptions.reduce(
  (acc, item) => {
    acc[item.key] = item;
    return acc;
  },
  {} as Record<SceneExtensionResolution, ResolutionOption>,
);

const resolutionMenuItems: MenuItemType[] = resolutionOptions.map((item) => ({
  key: item.key,
  label: (
    <div className='flex min-w-[160px] items-center gap-2'>
      {renderResolutionBadge(item.badge)}
      <span className='text-[13px] font-medium text-text-default-base'>{item.label}</span>
    </div>
  ),
}));

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const labelClass = 'nodrag nopan inline-flex h-8 items-center gap-1';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const fitToContainer = (ar: number, cw: number, ch: number): { w: number; h: number } => {
  let w = ch * ar;
  let h = ch;
  if (w < cw) {
    w = cw;
    h = cw / ar;
  }
  return { w: Math.max(cw, Math.round(w)), h: Math.max(ch, Math.round(h)) };
};

const applyResolutionCap = (
  w: number,
  h: number,
  ar: number | null,
  minW: number,
  minH: number,
  cap: number,
): { w: number; h: number } => {
  let nw = Math.max(minW, Math.round(w));
  let nh = Math.max(minH, Math.round(h));
  if (ar !== null) {
    nw = Math.max(minW, Math.round(nh * ar));
    nh = Math.max(minH, Math.round(nw / ar));
    nw = Math.max(minW, Math.round(nh * ar));
  }
  const long = Math.max(nw, nh);
  if (long <= cap) return { w: nw, h: nh };
  const scale = cap / long;
  nw = Math.max(minW, Math.round(nw * scale));
  nh = Math.max(minH, Math.round(nh * scale));
  if (ar !== null) {
    nw = Math.max(minW, Math.round(nh * ar));
    nh = Math.max(minH, Math.round(nw / ar));
  }
  return { w: nw, h: nh };
};

const SceneExtensionBottomToolbar: React.FC<SceneExtensionBottomToolbarProps> = ({
  active,
  videoRef,
  mediaSrc,
  currentTime,
  duration,
  isPlaying,
  volume,
  fullscreenTargetRef,
  width,
  height,
  containerWidth,
  containerHeight,
  onDimensionChange,
  onClose,
  onSend,
}) => {
  const cw = Math.max(1, Math.round(containerWidth));
  const ch = Math.max(1, Math.round(containerHeight));
  const [ratio, setRatio] = useState<string>('original');
  const [ratioOpen, setRatioOpen] = useState(false);
  const [resolution, setResolution] = useState<SceneExtensionResolution>('2k');
  const [resOpen, setResOpen] = useState(false);
  const [inputW, setInputW] = useState(String(Math.round(width)));
  const [inputH, setInputH] = useState(String(Math.round(height)));
  const internalChangeRef = useRef(false);

  useEffect(() => {
    setInputW(String(Math.max(cw, Math.round(width))));
    setInputH(String(Math.max(ch, Math.round(height))));
    if (internalChangeRef.current) {
      internalChangeRef.current = false;
      return;
    }
    setRatio((prev) => {
      if (prev === 'free') return prev;
      let ar = cw / ch;
      if (prev !== 'original') {
        const p = prev.split(':');
        ar = Number(p[0]) / Number(p[1]);
      }
      return Math.abs(width / height - ar) > 0.02 ? 'free' : prev;
    });
  }, [width, height, cw, ch]);

  const getAR = useCallback(
    (key: string): number | null => {
      if (key === 'free') return null;
      if (key === 'original') return cw / ch;
      const parts = key.split(':');
      return Number(parts[0]) / Number(parts[1]);
    },
    [cw, ch],
  );

  const maxDim = Math.max(resolutionLongEdge[resolution], cw, ch) * 2;

  const handleRatioChange = (key: string) => {
    setRatio(key);
    setRatioOpen(false);
    const ar = getAR(key);
    if (ar !== null) {
      const cap = Math.max(resolutionLongEdge[resolution], cw, ch);
      const fitted = fitToContainer(ar, cw, ch);
      const { w, h } = applyResolutionCap(fitted.w, fitted.h, ar, cw, ch, cap);
      setInputW(String(w));
      setInputH(String(h));
      internalChangeRef.current = true;
      onDimensionChange(w, h, true);
    }
  };

  const handleResolutionChange = (key: string) => {
    const next = key as SceneExtensionResolution;
    setResolution(next);
    setResOpen(false);
    const ar = getAR(ratio);
    const cap = Math.max(resolutionLongEdge[next], cw, ch);
    const { w, h } = applyResolutionCap(width, height, ar, cw, ch, cap);
    setInputW(String(w));
    setInputH(String(h));
    internalChangeRef.current = true;
    onDimensionChange(w, h, false);
  };

  const commitW = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < cw) {
      setInputW(String(Math.max(cw, Math.round(width))));
      return;
    }
    const ar = getAR(ratio);
    const w0 = clamp(parsed, cw, maxDim);
    const h0 = ar !== null ? Math.max(ch, Math.round(w0 / ar)) : Math.max(ch, Math.round(height));
    const cap = Math.max(resolutionLongEdge[resolution], cw, ch);
    const { w, h } = applyResolutionCap(w0, h0, ar, cw, ch, cap);
    setInputW(String(w));
    setInputH(String(h));
    internalChangeRef.current = true;
    onDimensionChange(w, h, false);
  };

  const commitH = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < ch) {
      setInputH(String(Math.max(ch, Math.round(height))));
      return;
    }
    const ar = getAR(ratio);
    const h0 = clamp(parsed, ch, maxDim);
    const w0 = ar !== null ? Math.max(cw, Math.round(h0 * ar)) : Math.max(cw, Math.round(width));
    const cap = Math.max(resolutionLongEdge[resolution], cw, ch);
    const { w, h } = applyResolutionCap(w0, h0, ar, cw, ch, cap);
    setInputW(String(w));
    setInputH(String(h));
    internalChangeRef.current = true;
    onDimensionChange(w, h, false);
  };

  const ratioMenuItems: MenuItemType[] = useMemo(
    () =>
      ratioOptions.map((item) => ({
        key: item.key,
        label: (
          <div className='flex w-full items-center gap-1'>
            <Icon name={item.icon} width={item.iconWidth} height={item.iconHeight} color='var(--bg-icon-base)' />
            <span className='text-[13px] font-semibold text-text-default-base'>{item.label}</span>
          </div>
        ),
      })),
    [],
  );

  if (!active) return null;

  const selectedRatio = ratioOptions.find((item) => item.key === ratio) ?? ratioOptions[1]!;
  const selectedResolution = resolutionOptionMap[resolution];

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div className='flex flex-col items-center gap-1'>
        <PlaybackPanel
          videoRef={videoRef}
          mediaSrc={mediaSrc}
          currentTime={currentTime}
          duration={duration}
          isPlaying={isPlaying}
          volume={volume}
          fullscreenTargetRef={fullscreenTargetRef}
          hideFilmstripAndWaveform
        />
        <div
          className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className={labelClass}>
            <Icon name='videoNode-scene-extension' width={18} height={18} color='var(--color-icon-base)' />
            <span className='text-text-default-base text-sm font-bold'>Scene Extension</span>
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />

        <Dropdown
          trigger='click'
          placement='top'
          offset={8}
          items={ratioMenuItems}
          selectedKeys={[ratio]}
          open={ratioOpen}
          onOpenChange={setRatioOpen}
          onClick={handleRatioChange}
          popupClassName='rounded-[6px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
          itemClassName='h-8 px-2'
        >
          <button
            type='button'
            className='nodrag nopan flex h-[28px] w-auto items-center gap-1 whitespace-nowrap rounded-[6px] bg-transparent px-2 hover:bg-background-default-base-hover'
            aria-label='Scene extension aspect ratio'
          >
            <span
              className='flex shrink-0 items-center justify-center'
              style={{ width: selectedRatio.iconWidth, height: selectedRatio.iconHeight }}
            >
              <Icon
                name={selectedRatio.icon}
                width={selectedRatio.iconWidth}
                height={selectedRatio.iconHeight}
                color='var(--bg-icon-base)'
              />
            </span>
            <span className='px-2 leading-none whitespace-nowrap text-[13px] font-semibold text-text-default-base'>
              {selectedRatio.label}
            </span>
            <span
              className={`flex shrink-0 items-center justify-center transition-transform duration-200 ${ratioOpen ? 'rotate-180' : ''}`}
            >
              <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
            </span>
          </button>
        </Dropdown>

        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />

        <Dropdown
          trigger='click'
          placement='top'
          offset={8}
          items={resolutionMenuItems}
          selectedKeys={[resolution]}
          open={resOpen}
          onOpenChange={setResOpen}
          onClick={handleResolutionChange}
          popupClassName='rounded-[6px] border border-border-default-base p-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
          itemClassName='h-8 px-2'
        >
          <button
            type='button'
            className='nodrag nopan flex h-[28px] min-w-[170px] items-center justify-between gap-2 rounded-[6px] bg-transparent px-2 hover:bg-background-default-base-hover'
            aria-label='Output resolution'
          >
            <span className='inline-flex items-center gap-2'>
              {renderResolutionBadge(selectedResolution.badge)}
              <span className='text-[13px] font-medium text-text-default-base'>{selectedResolution.label}</span>
            </span>
            <span
              className={`flex shrink-0 items-center justify-center transition-transform duration-200 ${resOpen ? 'rotate-180' : ''}`}
            >
              <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
            </span>
          </button>
        </Dropdown>

        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />

        <div className='flex items-center gap-1'>
          <span className='text-[12px] text-text-default-secondary'>W</span>
          <Input
            size='middle'
            type='outlined'
            inputType='text'
            value={inputW}
            onChange={(e) => setInputW(e.target.value)}
            onBlur={(e) => commitW(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitW((e.target as HTMLInputElement).value);
            }}
            className='!h-[28px] !w-[60px] !bg-background-default-base !px-2 !text-center !text-[13px] !font-semibold text-text-default-base'
            aria-label='Scene extension width'
          />
        </div>
        <div className='flex items-center gap-1'>
          <span className='text-[12px] text-text-default-secondary'>H</span>
          <Input
            size='middle'
            type='outlined'
            inputType='text'
            value={inputH}
            onChange={(e) => setInputH(e.target.value)}
            onBlur={(e) => commitH(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitH((e.target as HTMLInputElement).value);
            }}
            className='!h-[28px] !w-[60px] !bg-background-default-base !px-2 !text-center !text-[13px] !font-semibold text-text-default-base'
            aria-label='Scene extension height'
          />
        </div>

        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />

        <div className='inline-flex items-center gap-1 px-1 text-[12px] font-semibold text-text-default-tertiary'>
          <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
          <span>120</span>
        </div>

        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />

        <Tooltip title='Send' placement='top' offset={4}>
          <Button
            type='primary'
            shape='round'
            className='nodrag nopan !h-[28px] !w-[52px] !min-w-[52px] !py-[2px] !pl-[16px] !pr-[12px] !bg-[#2FB344] !border-[#2FB344] !text-white hover:!bg-[#28A13D] hover:!border-[#28A13D]'
            icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
            onClick={() =>
              onSend({
                width: Math.max(cw, Math.round(width)),
                height: Math.max(ch, Math.round(height)),
                resolution,
                ratio,
              })
            }
            aria-label='Send scene extension'
          />
        </Tooltip>

        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />

          <Tooltip title='Exit' placement='top' offset={4}>
            <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close scene extension toolbar'>
              <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};

export default SceneExtensionBottomToolbar;
