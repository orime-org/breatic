import React, { useEffect, useRef, useState } from 'react';
import Tooltip from '@/components/base/tooltip';
import { Icon } from '@/components/base/icon';
import Slider from '@/components/base/slider';
import Switch from '@/components/base/switch';
import TextArea from '@/components/base/textArea';
import { Button } from '@/components/base/button';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import Upload, { type UploadFile } from '@/components/base/upload';
import RelightThreeScene, { type RelightLightPreset, type RelightViewMode } from './RelightThreeScene';

type RelightBottomToolbarProps = {
  active: boolean;
  onClose: () => void;
  imageSrc?: string;
};

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[10px] text-icon-base transition-colors hover:bg-background-default-base-hover';
const sliderClass = 'nodrag nopan !w-full';
const temperatureTrackBackground = 'linear-gradient(to right, #1A45FF 0%, #9333EA 45%, #FF8C00 100%)';
const lightPresetTabs = ['free', 'left', 'top', 'right', 'front', 'bottom', 'back'] as const;

const lightPresetItems: MenuItemType[] = lightPresetTabs.map((key) => ({
  key,
  label: <span className='text-[13px] font-semibold text-text-default-base'>{key}</span>,
}));

const viewModeTabs = ['perspective', 'front'] as const satisfies readonly RelightViewMode[];
const viewModeLabel: Record<RelightViewMode, string> = {
  perspective: 'Perspective',
  front: 'Front',
};

const RelightBottomToolbar: React.FC<RelightBottomToolbarProps> = ({ active, onClose, imageSrc }) => {
  const [viewMode, setViewMode] = useState<RelightViewMode>('perspective');
  const [rimLight, setRimLight] = useState(false);
  const [brightness, setBrightness] = useState(50);
  const [temperatureK, setTemperatureK] = useState(2000);
  const [promptEnabled, setPromptEnabled] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [lightingReferenceSrc, setLightingReferenceSrc] = useState<string | null>(null);
  const [lightingReferenceFileList, setLightingReferenceFileList] = useState<UploadFile[]>([]);
  const [lightPreset, setLightPreset] = useState<RelightLightPreset>('free');
  const [lightPresetOpen, setLightPresetOpen] = useState(false);
  const lightingReferenceObjectUrlRef = useRef<string | null>(null);
  const credit = 120;

  useEffect(() => {
    if (!active) return;
    setViewMode('perspective');
    setRimLight(false);
    setBrightness(50);
    setTemperatureK(2000);
    setPromptEnabled(false);
    setPrompt('');
    if (lightingReferenceObjectUrlRef.current) URL.revokeObjectURL(lightingReferenceObjectUrlRef.current);
    lightingReferenceObjectUrlRef.current = null;
    setLightingReferenceSrc(null);
    setLightingReferenceFileList([]);
    setLightPreset('free');
  }, [active]);

  const revokeLightingReferenceObjectUrl = () => {
    if (lightingReferenceObjectUrlRef.current) URL.revokeObjectURL(lightingReferenceObjectUrlRef.current);
    lightingReferenceObjectUrlRef.current = null;
  };

  const handleLightingReferenceChange = (info: { fileList: UploadFile[] }) => {
    const nextList = info.fileList.slice(0, 1);
    setLightingReferenceFileList(nextList);
    revokeLightingReferenceObjectUrl();
    setLightingReferenceSrc(null);
    const file = nextList[0];
    if (!file?.originFileObj) return;
    const url = URL.createObjectURL(file.originFileObj);
    lightingReferenceObjectUrlRef.current = url;
    setLightingReferenceSrc(url);
  };

  const handleLightingReferenceDelete = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    revokeLightingReferenceObjectUrl();
    setLightingReferenceFileList([]);
    setLightingReferenceSrc(null);
  };

  if (!active) return null;

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div className='nodrag nopan pointer-events-auto flex w-[530px] flex-col rounded-[14px] border border-[#DBDBDB] bg-background-default-base p-3 shadow-[0_1px_3px_rgba(0,0,0,0.08)]'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-1 text-[16px] font-semibold text-text-default-base'>
            <Icon name='project-image-editor-more-relight-icon' width={20} height={20} color='var(--bg-icon-base)' />
            <span>Relight</span>
          </div>
          <Tooltip title='Exit' placement='top' offset={4}>
            <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close relight toolbar'>
              <Icon name='imageEditor-multi-angle-close-icon' width={24} height={24} color='#383838' />
            </button>
          </Tooltip>
        </div>

        <div className='mt-3 flex h-[250px] w-full items-stretch gap-4'>
          <div className='py-[10px] relative flex h-full w-[240px] shrink-0 flex-col overflow-hidden rounded-[12px] border border-[#2a2a33] bg-[#1E1E24]'>
            <div className='z-10 flex h-[20px] shrink-0 items-center justify-center'>
              <div className='flex rounded-full bg-background-default-base p-[2px] backdrop-blur-sm'>
                {viewModeTabs.map((key) => (
                  <button
                    key={key}
                    type='button'
                    className={`nodrag nopan flex h-[16px] items-center justify-center rounded-full px-4 text-[10px] font-semibold transition-colors ${
                      viewMode === key
                        ? 'bg-background-default-base-hover text-text-default-base'
                        : 'bg-transparent text-text-default-base hover:bg-background-default-base-hover'
                    }`}
                    onClick={() => setViewMode(key)}
                  >
                    {viewModeLabel[key]}
                  </button>
                ))}
              </div>
            </div>
            <div className='h-[200px] w-full shrink-0'>
              <RelightThreeScene
                className='h-full w-full'
                imageSrc={imageSrc}
                rimLight={rimLight}
                brightness={brightness}
                temperatureKelvin={temperatureK}
                viewMode={viewMode}
                lightPreset={lightPreset}
              />
            </div>
          </div>

          <div className='flex min-w-0 flex-1 flex-col justify-center gap-6'>
            <div className='flex items-center justify-between gap-1'>
              <span className='text-[13px] font-semibold text-text-default-base'>Rim Light</span>
              <Switch checked={rimLight} onChange={setRimLight} className='nodrag nopan shrink-0' />
            </div>

            <div className='flex flex-col justify-between'>
              <div className='mb-4 flex items-center justify-between'>
                <span className='text-[13px] font-semibold text-text-default-base'>Brightness</span>
                <span className='text-[12px] font-semibold text-text-default-secondary'>{brightness}%</span>
              </div>
              <Slider className={sliderClass} value={brightness} min={0} max={100} step={1} onChange={setBrightness} />
            </div>

            <div className='flex flex-col justify-between'>
              <div className='mb-4 flex items-center justify-between'>
                <span className='text-[13px] font-semibold text-text-default-base'>Temperature</span>
                <span className='text-[12px] font-semibold text-text-default-secondary'>{temperatureK}K</span>
              </div>
              <Slider
                className={sliderClass}
                value={temperatureK}
                min={2000}
                max={10000}
                step={50}
                trackBackground={temperatureTrackBackground}
                onChange={setTemperatureK}
              />
            </div>
          </div>
        </div>

        {promptEnabled ? (
          <div className='mt-3 flex items-start gap-3'>
            <Upload accept='image/*' maxCount={1} fileList={lightingReferenceFileList} onChange={handleLightingReferenceChange} showUploadList={false}>
              <div className='nodrag nopan relative flex h-[80px] w-[80px] shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed border-border-default-base bg-background-default-base p-[8px] text-text-default-tertiary transition-colors hover:bg-background-default-base-hover'>
                {lightingReferenceSrc ? <img src={lightingReferenceSrc} alt='Lighting reference' className='absolute inset-0 h-full w-full rounded-[8px] object-cover' /> : <span className='text-[22px] leading-none'>+</span>}
                {lightingReferenceSrc ? (
                  <button type='button' aria-label='Delete lighting reference' className='absolute right-[6px] top-[6px] flex h-6 w-6 items-center justify-center rounded-full border-0 bg-black/40 text-white' onClick={(e) => handleLightingReferenceDelete(e)}>
                    <Icon name='imageEditor-relight-delete-icon' width={14} height={14} color='#fff' />
                  </button>
                ) : null}
              </div>
            </Upload>
            <TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder='Describe the details to preserve or recover.'
              type='outlined'
              className='nodrag nopan !h-[80px] min-h-[80px] flex-1 !rounded-[10px] !bg-background-default-base !p-3'
            />
          </div>
        ) : null}

        <div className='mt-3 flex items-center justify-between gap-3'>
          <div className='flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2'>
            <Dropdown
              trigger='click'
              placement='top-start'
              offset={8}
              items={lightPresetItems}
              selectedKeys={[lightPreset]}
              open={lightPresetOpen}
              onOpenChange={setLightPresetOpen}
              onClick={(key) => setLightPreset(String(key) as RelightLightPreset)}
            >
              <button type='button' className='nodrag nopan inline-flex h-[28px] items-center gap-1 rounded-[6px] bg-background-default-base px-2 hover:bg-background-default-base-hover' aria-label='Light position preset'>
                <span className='px-1 text-[13px] font-semibold capitalize text-text-default-base'>{lightPreset}</span>
                <Icon name='base-chevron-down-icon' width={10} height={10} color='var(--color-icon-base)' />
              </button>
            </Dropdown>
            <div className='flex items-center gap-1'>
              <span className='text-[13px] font-semibold text-text-default-base'>Prompt</span>
              <Switch checked={promptEnabled} onChange={setPromptEnabled} className='nodrag nopan shrink-0' />
            </div>
          </div>

          <div className='flex shrink-0 items-center gap-1'>
            <div className='flex items-center gap-1 text-xs font-bold text-text-default-tertiary'>
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
              aria-label='Submit relight'
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default RelightBottomToolbar;
