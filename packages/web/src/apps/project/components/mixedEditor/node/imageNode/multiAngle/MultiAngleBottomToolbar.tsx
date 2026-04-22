import React, { useState } from 'react';
import Tooltip from '@/components/base/tooltip';
import { Icon } from '@/components/base/icon';
import Slider from '@/components/base/slider';
import Switch from '@/components/base/switch';
import { Button } from '@/components/base/button';
import TextArea from '@/components/base/textArea';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import AngleEditorV3Scene, { type AngleCubeScale } from './AngleEditorV3Scene';

type MultiAngleBottomToolbarProps = {
  active: boolean;
  onClose: () => void;
  imageSrc?: string;
};

const iconBtnClass =
  'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[10px] text-icon-base transition-colors hover:bg-background-default-base-hover';

const tabs = [
  { key: 'custom', label: 'Custom' },
  { key: '45_side', label: '45°Side' },
  { key: 'looking_down', label: 'Looking Down' },
  { key: 'looking_up', label: 'Looking Up' },
  { key: 'back_side', label: 'Back Side' },
] as const;

type TabKey = (typeof tabs)[number]['key'];

const scaleIndexToValue = (i: number): AngleCubeScale => (i === 0 ? 1 : i === 2 ? 10 : 5);
const scaleValueToIndex = (s: AngleCubeScale): 0 | 1 | 2 => (s === 1 ? 0 : s === 10 ? 2 : 1);

const MultiAngleBottomToolbar: React.FC<MultiAngleBottomToolbarProps> = ({ active, onClose, imageSrc }) => {
  const [tab, setTab] = useState<TabKey>('custom');
  const [rotate, setRotate] = useState(0);
  const [tilt, setTilt] = useState(0);
  const [scale, setScale] = useState<AngleCubeScale>(5);
  const [presetOpen, setPresetOpen] = useState(false);
  const [promptEnabled, setPromptEnabled] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [wideAngleEnabled, setWideAngleEnabled] = useState(false);
  const credit = 120;

  const scaleLabel = scale === 1 ? 'Small' : scale === 10 ? 'Large' : 'Medium';

  const handleSelectTab = (nextTab: TabKey) => {
    setTab(nextTab);
    // Only apply presets for non-custom tabs.
    if (nextTab === '45_side') {
      setRotate(45);
      setTilt(-30);
      setScale(5);
    } else if (nextTab === 'looking_down') {
      setRotate(45);
      setTilt(-30);
      setScale(5);
    } else if (nextTab === 'looking_up') {
      setRotate(45);
      setTilt(45);
      setScale(5);
    } else if (nextTab === 'back_side') {
      setRotate(90);
      setTilt(-30);
      setScale(5);
    }
  };

  const handleRotateChange = (v: number) => {
    setTab('custom');
    setRotate(v);
  };

  const handleTiltChange = (v: number) => {
    setTab('custom');
    setTilt(v);
  };

  const presetMenuItems: MenuItemType[] = tabs.map((item) => ({
    key: item.key,
    label: <span className='text-[13px] font-semibold text-text-default-base'>{item.label}</span>,
  }));

  if (!active) return null;

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div
        className='nodrag nopan pointer-events-auto w-[540px] rounded-[8px] border border-[#DBDBDB] bg-background-default-base p-3 shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-1 text-[16px] font-semibold text-text-default-base'>
            <Icon name='imageEditor-multi-angle-title-icon' width={20} height={20} />
            <span>Multi-Angle</span>
          </div>
          <Tooltip title='Exit' placement='top' offset={4}>
            <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close multi-angle toolbar'>
              <Icon name='imageEditor-multi-angle-close-icon' width={24} height={24} color='#383838' />
            </button>
          </Tooltip>
        </div>

        <div className='mt-3 flex w-full items-start gap-6 h-[220px]'>
          {/* Left: select area (currently empty) */}
          <div className='w-[220px] h-full shrink-0'>
            <AngleEditorV3Scene
              className='h-full overflow-hidden rounded-[8px] bg-background-default-secondary select-none'
              rotate={rotate}
              tilt={tilt}
              cubeScale={scale}
              imageSrc={imageSrc}
              onRotateChange={handleRotateChange}
              onTiltChange={handleTiltChange}
            />
          </div>
          {/* Right: sliders */}
          <div className='flex-1 h-full flex flex-col justify-center'>
            <div className='flex w-full items-center justify-between'>
              <div className='text-[15px] font-semibold text-text-default-base'>Wide angle</div>
              <Switch checked={wideAngleEnabled} onChange={setWideAngleEnabled} />
            </div>

            <div className='mt-2'>
              <div className='flex items-center justify-between'>
                <span className='text-[13px] font-semibold text-text-default-base'>Rotate</span>
                <span className='text-[13px] font-semibold text-text-default-base'>{rotate}</span>
              </div>
              <Slider
                className='nodrag nopan !w-full'
                value={rotate}
                min={0}
                max={315}
                step={45}
                fillFromZero
                activeColor='#5A5A5A'
                inactiveColor='#E3E3E3'
                trackHeight={6}
                thumbWidth={20}
                thumbHeight={16}
                thumbColor='#B3B3B3'
                onChange={setRotate}
              />
            </div>

            <div className='mt-2'>
              <div className='flex items-center justify-between'>
                <span className='text-[13px] font-semibold text-text-default-base'>Tilt</span>
                <span className='text-[13px] font-semibold text-text-default-base'>{tilt}</span>
              </div>
              <Slider
                className='nodrag nopan !w-full'
                value={tilt}
                min={-30}
                max={60}
                step={30}
                fillFromZero
                activeColor='#5A5A5A'
                inactiveColor='#E3E3E3'
                trackHeight={6}
                thumbWidth={20}
                thumbHeight={16}
                thumbColor='#B3B3B3'
                onChange={setTilt}
              />
            </div>

            <div className='mt-2'>
              <div className='flex items-center justify-between'>
                <span className='text-[13px] font-semibold text-text-default-base'>Scale</span>
                <span className='text-[13px] font-semibold text-text-default-base'>{scaleLabel}</span>
              </div>
              <Slider
                className='nodrag nopan !w-full'
                value={scaleValueToIndex(scale)}
                min={0}
                max={2}
                step={1}
                activeColor='#5A5A5A'
                inactiveColor='#E3E3E3'
                trackHeight={6}
                thumbWidth={20}
                thumbHeight={16}
                thumbColor='#B3B3B3'
                onChange={(v) => setScale(scaleIndexToValue(v))}
              />
            </div>
          </div>
        </div>

        {promptEnabled ? (
          <TextArea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder='Describe the details to preserve or recover'
            type='outlined'
            className='mt-3 !h-[80px] !rounded-[6px] !bg-background-default-base !p-3'
          />
        ) : null}

        <div className='mt-3 flex items-center justify-between gap-3'>
          <div className='flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2'>
            <div>
              <Dropdown
                trigger='click'
                placement='top-start'
                offset={8}
                items={presetMenuItems}
                selectedKeys={[tab]}
                open={presetOpen}
                onOpenChange={setPresetOpen}
                onClick={(key) => handleSelectTab(String(key) as TabKey)}
                popupClassName='rounded-[6px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
                itemClassName='h-8 px-2'
              >
                <button
                  type='button'
                  className='nodrag nopan inline-flex h-[28px] items-center gap-1 rounded-[6px] bg-background-default-base px-2 hover:bg-background-default-base-hover'
                  aria-label='Multi-angle preset'
                >
                  <span className='leading-none text-[13px] font-semibold text-text-default-base pr-2'>
                    {tabs.find((it) => it.key === tab)?.label ?? ''}
                  </span>
                  <span
                    className={`ml-auto flex shrink-0 items-center justify-center transition-transform duration-200 ${presetOpen ? 'rotate-180' : ''}`}
                  >
                    <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
                  </span>
                </button>
              </Dropdown>
            </div>
            <div className='flex items-center gap-1'>
              <span className='text-[13px] font-semibold text-text-default-base'>Prompt</span>
              <Switch checked={promptEnabled} onChange={(v) => setPromptEnabled(v)} className='nodrag nopan shrink-0' />
            </div>
            <div
              className='flex items-center gap-1 cursor-pointer select-none'
              onClick={() => {
                setTab('custom');
                setRotate(0);
                setTilt(0);
                setScale(5);
              }}
            >
              <Icon name='imageEditor-reset-icon' width={16} height={18} color='var(--bg-icon-base)' />
              <span className='text-[13px] font-semibold text-text-default-base'>Reset</span>
            </div>
          </div>

          <div className='flex shrink-0 items-center gap-1'>
            <div className='flex items-center gap-1 text-text-default-tertiary text-xs font-bold'>
              <Icon name='imageEditor-nano-banana-credit-icon' width={18} height={18} />
              <span>{credit}</span>
            </div>

            <Button
              type='primary'
              size='medium'
              shape='round'
              className='!h-[28px] !w-[52px] !min-w-[52px] !py-[2px] !pl-[16px] !pr-[12px] !bg-[#35C838] !border-[#35C838] !text-white hover:!bg-[#35C838] hover:!border-[#35C838]'
              icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
              onClick={() => void 0}
              aria-label='Generate multi-angle'
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default MultiAngleBottomToolbar;
