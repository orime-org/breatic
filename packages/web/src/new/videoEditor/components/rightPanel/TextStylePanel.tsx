import React, { useState, useEffect, useRef, useMemo, memo } from 'react';
import Select from '@/components/base/select';
import Slider from '@/components/base/slider';
import Input from '@/components/base/input';
import { ColorPicker } from '@/components/base/colorPicker';
import { Button } from '@/components/base/button';
import { useTranslation } from 'react-i18next';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { Icon } from '@/components/base/icon';
import { RiAlignCenter, RiAlignLeft, RiAlignRight } from 'react-icons/ri';
import FontSelector from './FontSelector';
import FontFaceObserver from 'fontfaceobserver';

// fontchild itemsinterface?fontvariant??
interface FontChild {
  family: string; // fontfamily ??"Microsoft YaHei Light"
  displayName: string; // display ??"Light", "Bold"
  url: string; // font path
}

// fontfamilyinterface
interface FontFamily {
  family: string; // fontfamily ??"Microsoft YaHei"
  displayName: string; // display ??" " " "
  url?: string; // font path??child items use??
  children: FontChild[]; // child itemslist?fontvariant??
}

interface TextStylePanelProps {
  nodeId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fontConfig?: any[];
}

const sliderClass = 'nodrag nopan !w-full';
const sliderBaseProps = {
  activeColor: '#5A5A5A',
  inactiveColor: '#E3E3E3',
  trackHeight: 6,
  thumbWidth: 20,
  thumbHeight: 16,
  thumbColor: '#B3B3B3',
} as const;
const DEFAULT_FONT_WEIGHT_OPTION = { value: 'default', label: 'Regular' };

const TextStylePanel: React.FC<TextStylePanelProps> = ({ fontConfig = [] }) => {
  const { clips, selectedClipId, batchUpdateClips, setSelectedClipId } = useVideoEditorStore();
  const { t } = useTranslation();
  const [fontSelectorVisible, setFontSelectorVisible] = useState(false);
  const [availableFontWeights, setAvailableFontWeights] = useState<
    { value: string; label: string }[]
  >([DEFAULT_FONT_WEIGHT_OPTION]);
  const fontButtonRef = useRef<HTMLButtonElement>(null);
  const fontFamiliesRef = useRef<FontFamily[]>([]);
  const fontSizeAdjustStartRef = useRef<{
    initialFontSize: number;
    initialWidth: number;
    initialHeight: number;
  } | null>(null);
  const isFontInitializedRef = useRef(false);

  // getallselected clips?same type ??
  const selectedClips = selectedClipId.length > 0
    ? selectedClipId.map((id) => clips.find((c: { id: string }) => c.id === id)).filter(Boolean) as typeof clips
    : [];

  const selectedClip = selectedClips[0] || null;

  // initializefontlist??load ??@font-face inject??
  useEffect(() => {
    const initializeFonts = async () => {
      if (isFontInitializedRef.current || fontConfig.length === 0) {
        return;
      }

      try {
        const fonts: FontFamily[] = fontConfig;
        fontFamiliesRef.current = fonts;

        // @font-face rule
        const rules: string[] = [];
        const fontObservers: Promise<void>[] = [];

        fonts.forEach(font => {
          if (font.children && font.children.length > 0) {
            font.children.forEach(child => {
              const fontUrl = child.url.startsWith('/') ? child.url : new URL(child.url, document.baseURI).href;
              rules.push(
                `@font-face {\n  font-family: '${child.family}';\n  src: url('${fontUrl}') format('truetype');\n  font-display: swap;\n}`
              );
              const observer = new FontFaceObserver(child.family);
              fontObservers.push(
                observer.load(null, 15000).catch(() => {
                  console.warn(`??????: ${child.family}`);
                })
              );
            });
          } else if (font.url) {
            const fontUrl = font.url.startsWith('/') ? font.url : new URL(font.url, document.baseURI).href;
            rules.push(
              `@font-face {\n  font-family: '${font.family}';\n  src: url('${fontUrl}') format('truetype');\n  font-display: swap;\n}`
            );
            const observer = new FontFaceObserver(font.family);
            fontObservers.push(
              observer.load(null, 15000).catch(() => {
                console.warn(`??????: ${font.family}`);
              })
            );
          }
        });

        // injectstyle
        const existingStyle = document.getElementById('dynamic-fonts');
        if (existingStyle) {
          existingStyle.remove();
        }
        const styleElement = document.createElement('style');
        styleElement.id = 'dynamic-fonts';
        styleElement.textContent = rules.join('\n\n');
        document.head.appendChild(styleElement);

        // waitfontload????load??
        Promise.all(fontObservers).catch(() => {
          // handle
        });

        isFontInitializedRef.current = true;
      } catch (error) {
        console.error('????????????:', error);
      }
    };

    initializeFonts();
  }, [fontConfig]);

  // font ??component ??
  const getFontChildren = (family: string) => {
    const font = fontFamiliesRef.current.find((f) => f.family === family);
    return font?.children || [];
  };

  const getBaseFontFamily = (fontFamily: string): string => {
    // allfont child items family
    for (const font of fontFamiliesRef.current) {
      if (font.children && font.children.length > 0) {
        const child = font.children.find((c) => c.family === fontFamily);
        if (child) {
          // ??family
          return font.family;
        }
      }
    }
    // if ??font ?or font
    return fontFamily;
  };

  const availableFontWeightsMemo = useMemo(() => {
    if (!selectedClip) return [DEFAULT_FONT_WEIGHT_OPTION];
    const fontFamily = selectedClip.textStyle?.fontFamily || 'Arial';
    const baseFamily = getBaseFontFamily(fontFamily);
    const children = getFontChildren(baseFamily);

    if (children.length > 0) {
      return children.map((child) => ({
        value: child.family,
        label: child.displayName,
      }));
    }
    return [DEFAULT_FONT_WEIGHT_OPTION];
  }, [selectedClip]);

  useEffect(() => {
    setAvailableFontWeights(availableFontWeightsMemo);
  }, [availableFontWeightsMemo]);

  // click outsideclosefontselector
  useEffect(() => {
    if (!fontSelectorVisible) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (fontButtonRef.current && !fontButtonRef.current.contains(event.target as Node)) {
        const target = event.target as HTMLElement;
        if (!target.closest('.fixed.z-50')) {
          setFontSelectorVisible(false);
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [fontSelectorVisible]);

  if (!selectedClip) {
    return null;
  }

  const isChineseText = (text: string): boolean => {
    if (!text) return false;
    const chineseRegex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3300-\u33ff\ufe30-\ufe4f]/;
    return chineseRegex.test(text);
  };

  // textDecoration decoration
  const getTextDecoration = () => {
    const decoration = selectedClip.textStyle?.textDecoration || 'none';
    return {
      underline: decoration.includes('underline'),
      lineThrough: decoration.includes('line-through'),
      overline: decoration.includes('overline'),
    };
  };

  // batchupdateallselected clips textstyle
  const updateTextStyle = (updates: Partial<typeof selectedClip.textStyle>) => {
    // usebatchupdate??updateallselected clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        const newTextStyle = { ...(clip.textStyle || {}), ...updates };
        return { ...clip, textStyle: newTextStyle };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  const updateOpacity = (value: number) => {
    // usebatchupdate??updateallselected clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        return { ...clip, opacity: value };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  const handleDecorationClick = (type: 'underline' | 'lineThrough' | 'overline') => {
    const currentDecoration = getTextDecoration();
    const newDecoration = { ...currentDecoration, [type]: !currentDecoration[type] };

    const decorationArray = [];
    if (newDecoration.underline) decorationArray.push('underline');
    if (newDecoration.lineThrough) decorationArray.push('line-through');
    if (newDecoration.overline) decorationArray.push('overline');

    updateTextStyle({ textDecoration: decorationArray.join(' ') || 'none' });
  };

  const handleItalicClick = () => {
    const currentFontStyle = selectedClip.textStyle?.fontStyle || 'normal';
    const newFontStyle = currentFontStyle === 'italic' ? 'normal' : 'italic';
    updateTextStyle({ fontStyle: newFontStyle });
  };

  // getfont display
  const getFontDisplayName = (fontFamily: string): string => {
    if (!fontFamily) return 'Arial';

    // font ??variant ??
    const baseFamily = getBaseFontFamily(fontFamily);

    // fontlist get displayName
    const font = fontFamiliesRef.current.find((f) => f.family === baseFamily);
    if (font) {
      return font.displayName;
    }

    // font
    return baseFamily;
  };

  // handlefontselectordisplay
  const handleFontButtonClick = () => {
    setFontSelectorVisible(true);
  };

  // handlefont
  const handleFontSelect = (font: string) => {
    // getfont allchild items
    const children = getFontChildren(font);

    if (children.length > 0) {
      // child items - use family
      const defaultChild =
        children.find((c) => c.displayName === 'Regular') || children[0];
      const familyName = defaultChild.family; // use child.family

      updateTextStyle({ fontFamily: familyName });

      // updatefont weight - value use family?label use displayName
      const weightOptions = children.map((child) => ({
        value: child.family, // use family??"Microsoft YaHei Bold"
        label: child.displayName, // display ??"Bold"
      }));
      setAvailableFontWeights(weightOptions);
    } else {
      // nochild items - usefont
      updateTextStyle({ fontFamily: font });

      // font weight display default
      setAvailableFontWeights([DEFAULT_FONT_WEIGHT_OPTION]);
    }
  };

  // handlefont weight ??child items??
  const handleFontWeightsDetected = (font: string, _weights: string[]) => {
    // getfont allchild items
    const children = getFontChildren(font);

    if (children.length === 0) {
      setAvailableFontWeights([DEFAULT_FONT_WEIGHT_OPTION]);
      return;
    }

    // child items - value use family?label use displayName
    const weightOptions = children.map((child) => ({
      value: child.family, // use family??"Microsoft YaHei Bold"
      label: child.displayName, // display ??"Bold"
    }));

    // updatefont weight
    setAvailableFontWeights(weightOptions);
  };

  // getfont weight Select
  const getFontWeightValue = () => {
    const fontFamily = selectedClip.textStyle?.fontFamily || 'Arial';
    const isAvailable = availableFontWeights.some(
      (option) => option.value === fontFamily
    );
    return isAvailable ? fontFamily : 'default';
  };

  // handlefont weight
  const handleFontWeightChange = (selectedFamily: string | number) => {
    if (selectedFamily === 'default') {
      return;
    }
    updateTextStyle({ fontFamily: String(selectedFamily) });
  };

  // handlefont size Slider
  const handleFontSizeSliderChange = (value: number) => {
    if (!fontSizeAdjustStartRef.current) {
      fontSizeAdjustStartRef.current = {
        initialFontSize: selectedClip.textStyle?.fontSize || 48,
        initialWidth: selectedClip.width || 300,
        initialHeight: selectedClip.height || 80,
      };
    }
    // batchupdateallselected clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        const clipInitialFontSize = clip.textStyle?.fontSize || 48;
        const clipInitialWidth = clip.width || 300;
        const clipInitialHeight = clip.height || 80;
        const clipFontScaleRatio = value / clipInitialFontSize;
        const clipNewWidth = Math.round(clipInitialWidth * clipFontScaleRatio);
        const clipNewHeight = Math.round(clipInitialHeight * clipFontScaleRatio);
        return {
          ...clip,
          textStyle: { ...clip.textStyle, fontSize: value },
          width: clipNewWidth,
          height: clipNewHeight,
        };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
  };

  // handlealignment
  const handleTextAlignChange = (value: string | number) => {
    updateTextStyle({ textAlign: String(value) });
  };

  const currentTextAlign = selectedClip.textStyle?.textAlign || 'center';

  // handle Case
  const handleTextTransformChange = (value: string | number) => {
    updateTextStyle({ textTransform: String(value) });
  };

  // handlefont size
  const handleFontSizeInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val)) {
      const clampedValue = Math.max(5, Math.min(300, Math.round(val)));
      if (!fontSizeAdjustStartRef.current) {
        fontSizeAdjustStartRef.current = {
          initialFontSize: selectedClip.textStyle?.fontSize || 48,
          initialWidth: selectedClip.width || 300,
          initialHeight: selectedClip.height || 80,
        };
      }
      // batchupdateallselected clips
      const updatedClips = clips.map((clip) => {
        if (selectedClipId.includes(clip.id)) {
          const clipInitialFontSize = clip.textStyle?.fontSize || 48;
          const clipInitialWidth = clip.width || 300;
          const clipInitialHeight = clip.height || 80;
          const clipFontScaleRatio = clampedValue / clipInitialFontSize;
          const clipNewWidth = Math.round(clipInitialWidth * clipFontScaleRatio);
          const clipNewHeight = Math.round(clipInitialHeight * clipFontScaleRatio);
          return {
            ...clip,
            textStyle: { ...clip.textStyle, fontSize: clampedValue },
            width: clipNewWidth,
            height: clipNewHeight,
          };
        }
        return clip;
      });
      batchUpdateClips(updatedClips);
    }
  };

  // handlefont sizeinputon focus
  const handleFontSizeInputFocus = () => {
    if (!fontSizeAdjustStartRef.current) {
      fontSizeAdjustStartRef.current = {
        initialFontSize: selectedClip.textStyle?.fontSize || 48,
        initialWidth: selectedClip.width || 300,
        initialHeight: selectedClip.height || 80,
      };
    }
  };

  // handlefont sizeinputon blur
  const handleFontSizeInputBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 48 : Math.max(5, Math.min(300, Math.round(val)));
    // batchupdateallselected clips
    const updatedClips = clips.map((clip) => {
      if (selectedClipId.includes(clip.id)) {
        const clipInitialFontSize = clip.textStyle?.fontSize || 48;
        const clipInitialWidth = clip.width || 300;
        const clipInitialHeight = clip.height || 80;
        const clipFontScaleRatio = finalValue / clipInitialFontSize;
        const clipNewWidth = Math.round(clipInitialWidth * clipFontScaleRatio);
        const clipNewHeight = Math.round(clipInitialHeight * clipFontScaleRatio);
        return {
          ...clip,
          textStyle: { ...clip.textStyle, fontSize: finalValue },
          width: clipNewWidth,
          height: clipNewHeight,
        };
      }
      return clip;
    });
    batchUpdateClips(updatedClips);
    fontSizeAdjustStartRef.current = null;
  };

  // handlefont sizeinput key
  const handleFontSizeInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  };

  return (
    <>
      <div className='flex items-center justify-between mb-4'>
        <h3 className='font-semibold text-xs text-text-default-secondary'>
          {t('textStyle.title') || 'Text Style'}
        </h3>
        <button onClick={() => setSelectedClipId([])} className='text-gray-400 hover:text-gray-600'>
          <Icon name='videoEditor-close-icon' width={12} height={12} />
        </button>
      </div>
      <div className='space-y-4'>
        {/* font */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>{t('textStyle.font') || 'Font'}</div>
          <div className='w-[130px]'>
            <Button
              ref={fontButtonRef}
              onClick={handleFontButtonClick}
              type='default'
              className='w-full !h-[26px] !px-[7px] !flex !items-center !justify-between text-left text-xs'
              size='small'
            >
              <span className='truncate'>
                {getFontDisplayName(selectedClip.textStyle?.fontFamily || 'Arial')}
              </span>
              <Icon
                name='videoEditor-arrow-down-icon'
                width={10}
                height={10}
                className={`ml-2 transition-transform duration-150 ${fontSelectorVisible ? 'rotate-180' : 'rotate-0'}`}
              />
            </Button>
          </div>
        </div>

        {/* font weight */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('textStyle.fontWeight') || 'Font Weight'}
          </div>
          <Select
            value={getFontWeightValue()}
            onChange={handleFontWeightChange}
            className='w-[130px] h-[26px]'
            size='small'
            options={availableFontWeights}
            disabled={availableFontWeights.length === 1 && availableFontWeights[0].value === 'default'}
          />
        </div>

        {/* font size */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('textStyle.fontSize') || 'Font Size'}
          </div>
          <div className='flex items-center gap-2 w-[130px]'>
            <Input
              value={String(selectedClip.textStyle?.fontSize ?? 48)}
              onChange={handleFontSizeInputChange}
              onFocus={handleFontSizeInputFocus}
              onBlur={handleFontSizeInputBlur}
              onKeyDown={handleFontSizeInputKeyDown}
              className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
            />
            <div className='flex-1 pr-2.5'>
              <Slider
                className={sliderClass}
                value={selectedClip.textStyle?.fontSize ?? 48}
                onChange={handleFontSizeSliderChange}
                min={5}
                max={300}
                {...sliderBaseProps}
              />
            </div>
          </div>
        </div>

        {/* color */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('textStyle.color') || 'Color'}
          </div>
          <div className='w-[130px]'>
            <ColorPicker
              value={selectedClip.textStyle?.color || '#ffffff'}
              onChange={(color) => updateTextStyle({ color })}
              size='small'
              showText
              className='w-full justify-start px-[7px] h-[26px]'
            />
          </div>
        </div>

        {/* alignment */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('textStyle.align') || 'Align'}
          </div>
          <div className='flex gap-2 w-[130px]'>
            <button
              className={`flex-1 border rounded hover:bg-background-default-base flex items-center justify-center h-[26px] ${
                currentTextAlign === 'left'
                  ? 'bg-background-default-base'
                  : 'bg-background-default-secondary'
              }`}
              onClick={() => handleTextAlignChange('left')}
            >
              <RiAlignLeft
                size={14}
                color={currentTextAlign === 'left' ? 'var(--color-icon-secondary-hover)' : 'var(--color-icon-secondary)'}
              />
            </button>
            <button
              className={`flex-1 border rounded hover:bg-background-default-base flex items-center justify-center h-[26px] ${
                currentTextAlign === 'center'
                  ? 'bg-background-default-base'
                  : 'bg-background-default-secondary'
              }`}
              onClick={() => handleTextAlignChange('center')}
            >
              <RiAlignCenter
                size={14}
                color={currentTextAlign === 'center' ? 'var(--color-icon-secondary-hover)' : 'var(--color-icon-secondary)'}
              />
            </button>
            <button
              className={`flex-1 border rounded hover:bg-background-default-base flex items-center justify-center h-[26px] ${
                currentTextAlign === 'right'
                  ? 'bg-background-default-base'
                  : 'bg-background-default-secondary'
              }`}
              onClick={() => handleTextAlignChange('right')}
            >
              <RiAlignRight
                size={14}
                color={currentTextAlign === 'right' ? 'var(--color-icon-secondary-hover)' : 'var(--color-icon-secondary)'}
              />
            </button>
          </div>
        </div>

        {/* decoration */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('textStyle.decoration') || 'Decoration'}
          </div>
          <div className='flex gap-2 w-[130px]'>
            <button
              className={`flex-1 border rounded hover:bg-background-default-base flex items-center justify-center h-[26px] ${
                getTextDecoration().underline
                  ? 'bg-background-default-base'
                  : 'bg-background-default-secondary'
              }`}
              onClick={() => handleDecorationClick('underline')}
            >
              <Icon
                name='videoEditor-underline-icon'
                width={14}
                height={14}
                color={
                  getTextDecoration().underline
                    ? 'var(--color-icon-secondary-hover)'
                    : 'var(--color-icon-secondary)'
                }
              />
            </button>
            <button
              className={`flex-1 border rounded hover:bg-background-default-base flex items-center justify-center h-[26px] ${
                getTextDecoration().lineThrough
                  ? 'bg-background-default-base'
                  : 'bg-background-default-secondary'
              }`}
              onClick={() => handleDecorationClick('lineThrough')}
            >
              <Icon
                name='videoEditor-line-through-icon'
                width={14}
                height={14}
                color={
                  getTextDecoration().lineThrough
                    ? 'var(--color-icon-secondary-hover)'
                    : 'var(--color-icon-secondary)'
                }
              />
            </button>
            <button
              className={`flex-1 border rounded hover:bg-background-default-base flex items-center justify-center h-[26px] ${
                getTextDecoration().overline
                  ? 'bg-background-default-base'
                  : 'bg-background-default-secondary'
              }`}
              onClick={() => handleDecorationClick('overline')}
            >
              <Icon
                name='videoEditor-overline-icon'
                width={14}
                height={14}
                color={
                  getTextDecoration().overline
                    ? 'var(--color-icon-secondary-hover)'
                    : 'var(--color-icon-secondary)'
                }
              />
            </button>
            <button
              className={`flex-1 border rounded hover:bg-background-default-base flex items-center justify-center h-[26px] ${
                selectedClip.textStyle?.fontStyle === 'italic'
                  ? 'bg-background-default-base'
                  : 'bg-background-default-secondary'
              }`}
              onClick={handleItalicClick}
            >
              <Icon
                name='videoEditor-italic-icon'
                width={14}
                height={14}
                color={
                  selectedClip.textStyle?.fontStyle === 'italic'
                    ? 'var(--color-icon-secondary-hover)'
                    : 'var(--color-icon-secondary)'
                }
              />
            </button>
          </div>
        </div>

        {/* Case */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>{t('textStyle.case') || 'Case'}</div>
          <Select
            value={selectedClip.textStyle?.textTransform || 'none'}
            onChange={handleTextTransformChange}
            className='w-[130px] h-[26px]'
            size='small'
            disabled={isChineseText(selectedClip.text || '')}
            options={[
              { value: 'none', label: t('textStyle.caseNone') || 'None' },
              { value: 'uppercase', label: t('textStyle.caseUppercase') || 'Uppercase' },
              { value: 'lowercase', label: t('textStyle.caseLowercase') || 'Lowercase' },
              { value: 'capitalize', label: t('textStyle.caseCapitalize') || 'Capitalize' },
            ]}
          />
        </div>

        {/* opacity */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('textStyle.opacity') || 'Opacity'}
          </div>
          <div className='flex items-center gap-2 w-[130px]'>
            <Input
              value={String(selectedClip.opacity ?? 100)}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (!isNaN(val)) {
                  updateOpacity(Math.max(0, Math.min(100, val)));
                }
              }}
              onBlur={(e) => {
                const val = parseFloat(e.target.value);
                const finalValue = isNaN(val) ? 100 : Math.max(0, Math.min(100, val));
                updateOpacity(finalValue);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              className='text-center w-[35px] h-[26px] text-xs p-1 rounded'
            />
            <div className='flex-1 pr-2.5'>
              <Slider
                className={sliderClass}
                value={selectedClip.opacity ?? 100}
                onChange={updateOpacity}
                min={0}
                max={100}
                {...sliderBaseProps}
              />
            </div>
          </div>
        </div>

        {/* fontstroke */}
        <div className='pt-3 mt-3 border-t border-border-default-base'>
          <h4 className='mb-3 font-semibold text-text-default-secondary text-xs'>
            {t('textStyle.stroke') || 'Stroke'}
          </h4>
          <div className='space-y-3'>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('textStyle.strokeColor') || 'Stroke Color'}
              </div>
              <div className='w-[130px]'>
                <ColorPicker
                  value={selectedClip.textStyle?.strokeColor || '#000000'}
                  onChange={(color) => updateTextStyle({ strokeColor: color })}
                  size='small'
                  showText
                  className='w-full justify-start px-[7px] h-[26px]'
                />
              </div>
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('textStyle.strokeWidth') || 'Stroke Width'}
              </div>
              <Input
                inputType='number'
                value={String(selectedClip.textStyle?.strokeWidth ?? 0)}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val)) {
                    updateTextStyle({ strokeWidth: Math.max(0, val) });
                  }
                }}
                onBlur={(e) => {
                  const val = parseFloat(e.target.value);
                  const finalValue = isNaN(val) ? 0 : Math.max(0, val);
                  updateTextStyle({ strokeWidth: finalValue });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                className='w-[130px]'
                size='small'
              />
            </div>
          </div>
        </div>

        {/* fontshadow */}
        <div className='pt-3 mt-3 border-t border-border-default-base'>
          <h4 className='mb-3 font-semibold text-text-default-secondary text-xs'>
            {t('textStyle.shadow') || 'Shadow'}
          </h4>
          <div className='space-y-3'>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('textStyle.shadowColor') || 'Shadow Color'}
              </div>
              <div className='w-[130px]'>
                <ColorPicker
                  value={selectedClip.textStyle?.shadowColor || '#ffffff'}
                  onChange={(color) => updateTextStyle({ shadowColor: color })}
                  size='small'
                  showText
                  className='w-full justify-start px-[7px] h-[26px]'
                />
              </div>
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('textStyle.shadowX') || 'Shadow X'}
              </div>
              <div className='w-[130px]'>
                <Input
                  inputType='number'
                  value={String(selectedClip.textStyle?.shadowOffsetX ?? 0)}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      updateTextStyle({ shadowOffsetX: val });
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseFloat(e.target.value);
                    const finalValue = isNaN(val) ? 0 : val;
                    updateTextStyle({ shadowOffsetX: finalValue });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  size='small'
                />
              </div>
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('textStyle.shadowY') || 'Shadow Y'}
              </div>
              <div className='w-[130px]'>
                <Input
                  inputType='number'
                  value={String(selectedClip.textStyle?.shadowOffsetY ?? 0)}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      updateTextStyle({ shadowOffsetY: val });
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseFloat(e.target.value);
                    const finalValue = isNaN(val) ? 0 : val;
                    updateTextStyle({ shadowOffsetY: finalValue });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  size='small'
                />
              </div>
            </div>
            <div className='flex items-center justify-between'>
              <div className='text-text-default-tertiary text-xs flex-1'>
                {t('textStyle.shadowBlur') || 'Shadow Blur'}
              </div>
              <div className='w-[130px]'>
                <Input
                  inputType='number'
                  value={String(selectedClip.textStyle?.shadowBlur ?? 0)}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) {
                      updateTextStyle({ shadowBlur: Math.max(0, val) });
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseFloat(e.target.value);
                    const finalValue = isNaN(val) ? 0 : Math.max(0, val);
                    updateTextStyle({ shadowBlur: finalValue });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  size='small'
                />
              </div>
            </div>
          </div>
        </div>

      </div>
      {/* fontselector */}
      <FontSelector
        visible={fontSelectorVisible}
        currentFont={selectedClip.textStyle?.fontFamily || 'Arial'}
        onFontSelect={handleFontSelect}
        onClose={() => setFontSelectorVisible(false)}
        onFontWeightsDetected={handleFontWeightsDetected}
        fontConfig={fontConfig}
      />
    </>
  );
};

export default memo(TextStylePanel);
