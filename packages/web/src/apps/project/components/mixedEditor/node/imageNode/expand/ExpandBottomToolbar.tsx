import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import Input from '@/components/base/input';
import Divider from '@/components/base/divider';

export type ExpandResolution = '1k' | '2k' | '4k';

type ExpandBottomToolbarProps = {
  active: boolean;
  /** Control frame logical width (pixels), must be at least the container width */
  width: number;
  /** Control frame logical height (pixels), must be at least the container height */
  height: number;
  containerWidth: number;
  containerHeight: number;
  /** Similar to crop: keepCentered is true when switching ratio (used internally to sync ratio logic) */
  onDimensionChange: (w: number, h: number, keepCentered?: boolean) => void;
  onClose: () => void;
  onSend: (payload: { width: number; height: number; resolution: ExpandResolution; ratio: string }) => void;
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

const resolutionLabelMap: Record<ExpandResolution, string> = {
  '1k': '1K',
  '2k': '2K',
  '4k': '4K',
};

const resolutionLongEdge: Record<ExpandResolution, number> = {
  '1k': 1024,
  '2k': 2048,
  '4k': 4096,
};

const resolutionMenuItems: MenuItemType[] = (Object.keys(resolutionLabelMap) as ExpandResolution[]).map((key) => ({
  key,
  label: <span className='text-[13px] font-semibold text-text-default-base'>{resolutionLabelMap[key]}</span>,
}));

const iconBtnClass =
  'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const expandLabelClass = 'nodrag nopan inline-flex h-8 items-center gap-1';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** At a fixed ratio, get the minimum output size that is at least the container size (dual to crop "fit inward") */
const fitExpandToContainer = (ar: number, cw: number, ch: number): { w: number; h: number } => {
  let w = ch * ar;
  let h = ch;
  if (w < cw) {
    w = cw;
    h = cw / ar;
  }
  return { w: Math.max(cw, Math.round(w)), h: Math.max(ch, Math.round(h)) };
};

/** Ensure not smaller than container, with longest edge not exceeding cap; maintain ratio when set */
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

const ExpandBottomToolbar: React.FC<ExpandBottomToolbarProps> = ({
  active,
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
  const [resolution, setResolution] = useState<ExpandResolution>('2k');
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
      const ar =
        prev === 'original'
          ? cw / ch
          : (() => {
              const p = prev.split(':');
              return Number(p[0]) / Number(p[1]);
            })();
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
      const fitted = fitExpandToContainer(ar, cw, ch);
      const { w, h } = applyResolutionCap(fitted.w, fitted.h, ar, cw, ch, cap);
      setInputW(String(w));
      setInputH(String(h));
      internalChangeRef.current = true;
      onDimensionChange(w, h, true);
    }
  };

  const handleResolutionChange = (key: string) => {
    const next = key as ExpandResolution;
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

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div
        className='nodrag nopan pointer-events-auto flex h-[40px] items-center gap-1 rounded-[8px] border border-[#DBDBDB] bg-background-default-base px-[12px] py-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className={expandLabelClass}>
          <Icon name='project-image-editor-more-expand-icon' width={18} height={18} color='var(--color-icon-base)' />
          <span className='text-text-default-base text-sm font-bold'>Expand</span>
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
            aria-label='Expand aspect ratio'
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
            className='nodrag nopan flex h-[28px] min-w-[52px] items-center justify-center gap-1 rounded-[6px] bg-transparent px-2 hover:bg-background-default-base-hover'
            aria-label='Output resolution'
          >
            <span className='text-[13px] font-semibold text-text-default-base'>{resolutionLabelMap[resolution]}</span>
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
            aria-label='Expand width'
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
            aria-label='Expand height'
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
            aria-label='Send expand'
          />
        </Tooltip>

        <Divider type='vertical' className='mx-2 h-[18px] bg-[#D0D0D0]' />

        <Tooltip title='Exit' placement='top' offset={4}>
          <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close expand toolbar'>
            <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};

export default ExpandBottomToolbar;
