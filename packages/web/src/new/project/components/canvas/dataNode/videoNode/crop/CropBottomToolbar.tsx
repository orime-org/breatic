import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import type { VideoRef } from '@/apps/project/components/canvas/common/Video';
import { Button } from '@/ui/button';
import { Icon } from '@/ui/icon';
import Tooltip from '@/ui/tooltip';
import Input from '@/ui/input';
import Divider from '@/ui/divider';
import PlaybackPanel from '../playback/PlaybackPanel';

type CropBottomToolbarProps = {
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
  onSave?: () => void;
};

type RatioOption = { key: string; label: string; icon: string; iconWidth: number; iconHeight: number };
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
const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const cropLabelClass = 'nodrag nopan inline-flex h-8 items-center gap-1';
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const CropBottomToolbar: React.FC<CropBottomToolbarProps> = ({
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
  onSave,
}) => {
  const [ratio, setRatio] = useState<string>('original');
  const [ratioOpen, setRatioOpen] = useState(false);
  const [inputW, setInputW] = useState(String(Math.round(width)));
  const [inputH, setInputH] = useState(String(Math.round(height)));
  const internalChangeRef = useRef(false);

  useEffect(() => {
    setInputW(String(Math.max(1, Math.round(width))));
    setInputH(String(Math.max(1, Math.round(height))));
    if (internalChangeRef.current) {
      internalChangeRef.current = false;
      return;
    }
    setRatio((prev) => {
      if (prev === 'free') return prev;
      const ar = prev === 'original' ? containerWidth / containerHeight : Number(prev.split(':')[0]) / Number(prev.split(':')[1]);
      return Math.abs(width / height - ar) > 0.02 ? 'free' : prev;
    });
  }, [width, height, containerWidth, containerHeight]);

  const getAR = useCallback((key: string): number | null => {
    if (key === 'free') return null;
    if (key === 'original') return containerWidth / containerHeight;
    const parts = key.split(':');
    return Number(parts[0]) / Number(parts[1]);
  }, [containerHeight, containerWidth]);

  const fitToContainer = useCallback((ar: number): { w: number; h: number } => {
    let w = containerWidth;
    let h = w / ar;
    if (h > containerHeight) {
      h = containerHeight;
      w = h * ar;
    }
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }, [containerHeight, containerWidth]);

  const handleRatioChange = (key: string) => {
    setRatio(key);
    setRatioOpen(false);
    const ar = getAR(key);
    if (ar !== null) {
      const { w, h } = fitToContainer(ar);
      setInputW(String(w));
      setInputH(String(h));
      internalChangeRef.current = true;
      onDimensionChange(w, h, true);
    }
  };

  const commitW = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1) return setInputW(String(Math.max(1, Math.round(width))));
    const w = clamp(parsed, 1, containerWidth);
    const ar = getAR(ratio);
    const h = ar !== null ? clamp(Math.round(w / ar), 1, containerHeight) : clamp(Math.round(height), 1, containerHeight);
    setInputW(String(w));
    setInputH(String(h));
    internalChangeRef.current = true;
    onDimensionChange(w, h, false);
  };

  const commitH = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1) return setInputH(String(Math.max(1, Math.round(height))));
    const h = clamp(parsed, 1, containerHeight);
    const ar = getAR(ratio);
    const w = ar !== null ? clamp(Math.round(h * ar), 1, containerWidth) : clamp(Math.round(width), 1, containerWidth);
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
        />
        <div className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'>
          <div className={cropLabelClass}>
            <Icon name='videoNode-crop' width={18} height={18} color='var(--color-icon-base)' />
            <span className='text-text-default-base text-sm font-bold'>Crop</span>
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <Dropdown trigger='click' placement='top' offset={8} items={ratioMenuItems} selectedKeys={[ratio]} open={ratioOpen} onOpenChange={setRatioOpen} onClick={handleRatioChange}>
            <button type='button' className='nodrag nopan flex h-[28px] items-center gap-1 rounded-[6px] bg-transparent px-2 hover:bg-background-default-base-hover'>
              <span className='flex shrink-0 items-center justify-center' style={{ width: selectedRatio.iconWidth, height: selectedRatio.iconHeight }}>
                <Icon name={selectedRatio.icon} width={selectedRatio.iconWidth} height={selectedRatio.iconHeight} color='var(--bg-icon-base)' />
              </span>
              <span className='px-2 text-[13px] font-semibold text-text-default-base'>{selectedRatio.label}</span>
              <span className={`flex shrink-0 items-center justify-center transition-transform duration-200 ${ratioOpen ? 'rotate-180' : ''}`}>
                <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
              </span>
            </button>
          </Dropdown>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <div className='flex items-center gap-1'>
            <span className='text-[12px] text-text-default-secondary'>W</span>
            <Input size='middle' type='outlined' inputType='text' value={inputW} onChange={(e) => setInputW(e.target.value)} onBlur={(e) => commitW(e.target.value)} className='!h-[28px] !w-[60px] !px-2 !text-center !text-[13px]' />
          </div>
          <div className='flex items-center gap-1'>
            <span className='text-[12px] text-text-default-secondary'>H</span>
            <Input size='middle' type='outlined' inputType='text' value={inputH} onChange={(e) => setInputH(e.target.value)} onBlur={(e) => commitH(e.target.value)} className='!h-[28px] !w-[60px] !px-2 !text-center !text-[13px]' />
          </div>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <Button type='primary' shape='round' className='nodrag nopan !h-[28px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]' onClick={onSave}>
            <Icon name='imageEditor-mark-save-icon' width={18} height={18} />
            <span className='pl-2'>Save</span>
          </Button>
          <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />
          <Tooltip title='Exit' placement='top' offset={4}>
            <button type='button' className={iconBtnClass} onClick={onClose}>
              <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};

export default memo(CropBottomToolbar);
