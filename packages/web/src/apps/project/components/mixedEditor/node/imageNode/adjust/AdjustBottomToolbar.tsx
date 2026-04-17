import React, { useEffect, useState } from 'react';
import Slider from '@/components/base/slider';
import { Icon } from '@/components/base/icon';
import { Button } from '@/components/base/button';
import Tooltip from '@/components/base/tooltip';

export type AdjustValue = {
  exposure: number;
  highlights: number;
  shadows: number;
  contrast: number;
  saturation: number;
  vibrance: number;
  temperature: number;
  tint: number;
  hue: number;
  sharpness: number;
  noiseReduction: number;
  clarity: number;
  vignette: number;
  grain: number;
  fade: number;
};

type AdjustBottomToolbarProps = {
  active: boolean;
  onClose: () => void;
  onChange?: (value: AdjustValue) => void;
  onSave: (value: AdjustValue) => void;
};

const iconBtnClass = 'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';

export const defaultAdjustValue: AdjustValue = {
  exposure: 0,
  highlights: 0,
  shadows: 0,
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  hue: 0,
  sharpness: 0,
  noiseReduction: 0,
  clarity: 0,
  vignette: 0,
  grain: 0,
  fade: 0,
};

const rowClass = 'space-y-1';
const sliderClass = 'nodrag nopan !w-full';
const twoColRowClass = 'space-y-1';
const temperatureTrackBackground = 'linear-gradient(to right, #1A00FF 0%, #FFF600 100%)';
const tintTrackBackground = 'linear-gradient(to right, #FF00D0 0%, #00FF06 100%)';
const hueTrackBackground = 'linear-gradient(to right, #FF0000 0%, #F6FF00 17%, #00F942 33%, #00D9FF 50%, #2600FF 67%, #FF00E5 83%, #FF0400 100%)';

const getSliderTrackBackground = (key: keyof AdjustValue): string | undefined => {
  if (key === 'temperature') return temperatureTrackBackground;
  if (key === 'tint') return tintTrackBackground;
  if (key === 'hue') return hueTrackBackground;
  return undefined;
};

const AdjustBottomToolbar: React.FC<AdjustBottomToolbarProps> = ({ active, onClose, onChange, onSave }) => {
  const [value, setValue] = useState<AdjustValue>(defaultAdjustValue);

  const sections = [
    {
      key: 'light',
      title: 'Light',
      icon: 'imageEditor-adjust-light-icon',
      iconWidth: 14,
      iconHeight: 14,
      items: [
        { key: 'exposure', label: 'Exposure' },
        { key: 'highlights', label: 'Highlights' },
        { key: 'contrast', label: 'Contrast' },
        { key: 'shadows', label: 'Shadows' },
      ] as const,
    },
    {
      key: 'color',
      title: 'Color',
      icon: 'imageEditor-adjust-color-icon',
      iconWidth: 12,
      iconHeight: 14,
      items: [
        { key: 'saturation', label: 'Saturation' },
        { key: 'temperature', label: 'Temperature' },
        { key: 'vibrance', label: 'Vibrance' },
        { key: 'tint', label: 'Tint' },
        { key: 'hue', label: 'Hue' },
      ] as const,
    },
    {
      key: 'detail',
      title: 'Detail',
      icon: 'imageEditor-adjust-detail-icon',
      iconWidth: 14,
      iconHeight: 14,
      items: [
        { key: 'sharpness', label: 'Sharpness' },
        { key: 'noiseReduction', label: 'Noise Reduc.' },
        { key: 'clarity', label: 'Clarity' },
      ] as const,
    },
    {
      key: 'effects',
      title: 'Effects',
      icon: 'imageEditor-adjust-effects-icon',
      iconWidth: 14,
      iconHeight: 14,
      items: [
        { key: 'vignette', label: 'Vignette' },
        { key: 'grain', label: 'Grain' },
        { key: 'fade', label: 'Fade' },
      ] as const,
    },
  ] as const;

  useEffect(() => {
    if (!active) return;
    setValue(defaultAdjustValue);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    onChange?.(value);
  }, [active, onChange, value]);

  if (!active) return null;

  return (
    <div className='nodrag nopan pointer-events-auto flex flex-col items-center gap-3'>
      <div
        className='nodrag nopan pointer-events-auto w-[520px] rounded-[14px] border border-[#DBDBDB] bg-background-default-base shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className='mb-2 flex items-center justify-between px-3 pt-3 text-text-default-base'>
          <div className='flex items-center gap-1'>
            <Icon name='imageEditor-adjust-title-icon' width={16} height={16} />
            <span className='text-[14px] font-semibold'>Adjust</span>
          </div>
          <Tooltip title='Exit' placement='top' offset={4}>
            <button type='button' className={iconBtnClass} onClick={onClose} aria-label='Close adjust toolbar'>
              <Icon name='imageEditor-multi-angle-close-icon' width={20} height={20} />
            </button>
          </Tooltip>
        </div>
        <div
          className='h-[220px] overflow-y-auto p-3'
          onWheelCapture={(e) => {
            e.stopPropagation();
          }}
          onWheel={(e) => {
            e.stopPropagation();
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
        >
          {(['light', 'color'] as const).map((sectionKey) => {
            const section = sections.find((s) => s.key === sectionKey)!;
            const rows: Array<[typeof section.items[number], typeof section.items[number] | null]> = [];
            for (let i = 0; i < section.items.length; i += 2) {
              rows.push([section.items[i]!, section.items[i + 1] ?? null]);
            }
            return (
              <div key={section.key} className='mb-3'>
                <div className='mb-2 flex items-center gap-1.5 text-text-default-secondary'>
                  <Icon name={section.icon} width={section.iconWidth} height={section.iconHeight} />
                  <span className='text-[13px] font-semibold'>{section.title}</span>
                </div>
                {(() => {
                  const pairRows = rows.filter(([, rightItem]) => rightItem !== null) as Array<
                  [typeof section.items[number], typeof section.items[number]]
                >;
                  const singleRow = rows.find(([, rightItem]) => rightItem === null)?.[0] ?? null;
                  return (
                    <>
                      <div className='grid grid-cols-[1fr_auto_1fr] items-start gap-3'>
                        <div className='space-y-1.5'>
                          {pairRows.map(([leftItem]) => (
                            <div key={leftItem.key} className={twoColRowClass}>
                              <div className='flex items-center justify-between'>
                                <span className='text-[13px] text-text-default-base'>{leftItem.label}</span>
                                <span className='text-right text-[12px] text-text-default-secondary'>{value[leftItem.key]}</span>
                              </div>
                              <Slider
                                className={sliderClass}
                                value={value[leftItem.key]}
                                min={-100}
                                max={100}
                                trackBackground={getSliderTrackBackground(leftItem.key)}
                                activeColor='#5A5A5A'
                                inactiveColor='#E3E3E3'
                                trackHeight={6}
                                thumbWidth={20}
                                thumbHeight={16}
                                thumbColor='#B3B3B3'
                                onChange={(next) => {
                                  setValue((prev) => ({ ...prev, [leftItem.key]: next }));
                                }}
                              />
                            </div>
                          ))}
                        </div>
                        <div className='h-full w-px bg-border-default-base' />
                        <div className='space-y-1.5'>
                          {pairRows.map(([, rightItem]) => (
                            <div key={rightItem.key} className={twoColRowClass}>
                              <div className='flex items-center justify-between'>
                                <span className='text-[13px] text-text-default-base'>{rightItem.label}</span>
                                <span className='text-right text-[12px] text-text-default-secondary'>{value[rightItem.key]}</span>
                              </div>
                              <Slider
                                className={sliderClass}
                                value={value[rightItem.key]}
                                min={-100}
                                max={100}
                                trackBackground={getSliderTrackBackground(rightItem.key)}
                                activeColor='#5A5A5A'
                                inactiveColor='#E3E3E3'
                                trackHeight={6}
                                thumbWidth={20}
                                thumbHeight={16}
                                thumbColor='#B3B3B3'
                                onChange={(next) => {
                                  setValue((prev) => ({ ...prev, [rightItem.key]: next }));
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                      {singleRow ? (
                        <div className='mt-1.5'>
                          <div className={rowClass}>
                            <div className='flex items-center justify-between'>
                              <span className='text-[13px] text-text-default-base'>{singleRow.label}</span>
                              <span className='text-right text-[12px] text-text-default-secondary'>{value[singleRow.key]}</span>
                            </div>
                            <Slider
                              className={sliderClass}
                              value={value[singleRow.key]}
                              min={-100}
                              max={100}
                              trackBackground={getSliderTrackBackground(singleRow.key)}
                              activeColor='#5A5A5A'
                              inactiveColor='#E3E3E3'
                              trackHeight={6}
                              thumbWidth={20}
                              thumbHeight={16}
                              thumbColor='#B3B3B3'
                              onChange={(next) => {
                                setValue((prev) => ({ ...prev, [singleRow.key]: next }));
                              }}
                            />
                          </div>
                        </div>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            );
          })}
          <div className='space-y-3'>
            {(['detail', 'effects'] as const).map((sectionKey) => {
              const section = sections.find((s) => s.key === sectionKey)!;
              return (
                <div key={section.key}>
                  <div className='mb-2 flex items-center gap-1.5 text-text-default-secondary'>
                    <Icon name={section.icon} width={section.iconWidth} height={section.iconHeight} />
                    <span className='text-[13px] font-semibold'>{section.title}</span>
                  </div>
                  <div className='space-y-1.5'>
                    {section.items.map((item) => (
                      <div key={item.key} className={rowClass}>
                        <div className='flex items-center justify-between'>
                          <span className='text-[13px] text-text-default-base'>{item.label}</span>
                          <span className='text-right text-[12px] text-text-default-secondary'>{value[item.key]}</span>
                        </div>
                        <Slider
                          className={sliderClass}
                          value={value[item.key]}
                          min={-100}
                          max={100}
                          trackBackground={getSliderTrackBackground(item.key)}
                          activeColor='#5A5A5A'
                          inactiveColor='#E3E3E3'
                          trackHeight={6}
                          thumbWidth={20}
                          thumbHeight={16}
                          thumbColor='#B3B3B3'
                          onChange={(next) => {
                            setValue((prev) => ({ ...prev, [item.key]: next }));
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className='flex items-center justify-between p-3 pb-3'>
          <div className='flex items-center gap-1'>
            <button
              type='button'
              className='nodrag nopan inline-flex h-[28px] w-[80px] items-center justify-center gap-1 rounded-[6px] border border-border-default-base px-2 text-[13px] text-text-default-secondary hover:bg-background-default-base-hover'
              onClick={() => setValue(defaultAdjustValue)}
            >
              <Icon name='imageEditor-adjust-auto-icon' width={14} height={14} />
              <span>Auto</span>
            </button>
            <button
              type='button'
              className='nodrag nopan inline-flex h-[28px] items-center gap-1 rounded-[6px] px-2 text-[13px] text-text-default-secondary hover:bg-background-default-base-hover'
              onClick={() => setValue(defaultAdjustValue)}
            >
              <Icon name='imageEditor-reset-icon' width={16} height={18} color='var(--bg-icon-base)' />
              <span>Reset</span>
            </button>
          </div>
          <div className='flex items-center gap-1'>
            <Button
              type='primary'
              shape='round'
              className='nodrag nopan !h-[30px] !bg-[#2FB344] !px-3 !text-[13px] !font-semibold !text-white hover:!bg-[#28A13D]'
              onClick={() => onSave(value)}
            >
              <Icon name='imageEditor-mark-save-icon' width={18} height={18} />
              <span className='pl-2'>Save</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdjustBottomToolbar;
