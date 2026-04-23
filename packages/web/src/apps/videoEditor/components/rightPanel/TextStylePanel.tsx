import React, { useState, useEffect, useRef, useMemo, memo } from 'react';
import Select from '@/components/base/select';
import Slider from '@/components/base/slider';
import Input from '@/components/base/input';
import { ColorPicker } from '@/components/base/colorPicker';
import { Button } from '@/components/base/button';
import { useTranslation } from 'react-i18next';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { Icon } from '@/components/base/icon';
import FontSelector from './FontSelector';
import FontFaceObserver from 'fontfaceobserver';

// 字体子项接口（字体变体）
interface FontChild {
  family: string; // 完整字体家族名，如 "Microsoft YaHei Light"
  displayName: string; // 显示名称，如 "Light", "Bold"
  url: string; // 字体文件路径
}

// 字体家族接口
interface FontFamily {
  family: string; // 字体家族名，如 "Microsoft YaHei"
  displayName: string; // 显示名称，如 "微软雅黑" 或 "楷体"
  url?: string; // 单字体文件路径（无子项时使用）
  children: FontChild[]; // 子项列表（字体变体）
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

const TextStylePanel: React.FC<TextStylePanelProps> = ({ nodeId, fontConfig = [] }) => {
  const { clips, selectedClipId, updateClip, batchUpdateClips, setSelectedClipId } = useVideoEditorStore(nodeId);
  const { t } = useTranslation();
  const [fontSelectorVisible, setFontSelectorVisible] = useState(false);
  const [availableFontWeights, setAvailableFontWeights] = useState<{ value: string; label: string }[]>([
    { value: 'default', label: '默认' },
  ]);
  const [fontSelectorPosition, setFontSelectorPosition] = useState({ x: 0, y: 0 });
  const fontButtonRef = useRef<HTMLButtonElement>(null);
  const fontFamiliesRef = useRef<FontFamily[]>([]);
  const fontSizeAdjustStartRef = useRef<{
    initialFontSize: number;
    initialWidth: number;
    initialHeight: number;
  } | null>(null);
  const isFontInitializedRef = useRef(false);

  // 获取所有选中的 clips（相同类型的）
  const selectedClips = selectedClipId.length > 0
    ? selectedClipId.map((id) => clips.find((c: { id: string }) => c.id === id)).filter(Boolean) as typeof clips
    : [];

  const selectedClip = selectedClips[0] || null;

  // 初始化字体列表（页面加载时执行，包括 @font-face 注入）
  useEffect(() => {
    const initializeFonts = async () => {
      if (isFontInitializedRef.current || fontConfig.length === 0) {
        return;
      }

      try {
        const fonts: FontFamily[] = fontConfig;
        fontFamiliesRef.current = fonts;

        // 生成 @font-face 规则
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
                  console.warn(`字体加载超时: ${child.family}`);
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
                console.warn(`字体加载超时: ${font.family}`);
              })
            );
          }
        });

        // 注入样式
        const existingStyle = document.getElementById('dynamic-fonts');
        if (existingStyle) {
          existingStyle.remove();
        }
        const styleElement = document.createElement('style');
        styleElement.id = 'dynamic-fonts';
        styleElement.textContent = rules.join('\n\n');
        document.head.appendChild(styleElement);

        // 等待字体加载（不阻塞，后台加载）
        Promise.all(fontObservers).catch(() => {
          // 静默处理错误
        });

        isFontInitializedRef.current = true;
      } catch (error) {
        console.error('❌ 字体管理器初始化失败:', error);
      }
    };

    initializeFonts();
  }, [fontConfig]);

  // 字体管理器方法（内联到组件中）
  const getFontChildren = (family: string) => {
    const font = fontFamiliesRef.current.find((f) => f.family === family);
    return font?.children || [];
  };

  const getBaseFontFamily = (fontFamily: string): string => {
    // 在所有字体的子项中查找匹配的 family
    for (const font of fontFamiliesRef.current) {
      if (font.children && font.children.length > 0) {
        const child = font.children.find((c) => c.family === fontFamily);
        if (child) {
          // 找到了，返回父级的 family
          return font.family;
        }
      }
    }
    // 如果没找到，可能本身就是基础字体名，或者是系统字体
    return fontFamily;
  };

  const availableFontWeightsMemo = useMemo(() => {
    if (!selectedClip) return [{ value: 'default', label: '默认' }];
    const fontFamily = selectedClip.textStyle?.fontFamily || 'Arial';
    const baseFamily = getBaseFontFamily(fontFamily);
    const children = getFontChildren(baseFamily);

    if (children.length > 0) {
      return children.map((child) => ({
        value: child.family,
        label: child.displayName,
      }));
    }
    return [{ value: 'default', label: '默认' }];
  }, [selectedClip]);

  useEffect(() => {
    setAvailableFontWeights(availableFontWeightsMemo);
  }, [availableFontWeightsMemo]);

  // 点击外部关闭字体选择器
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

  // 从 textDecoration 字符串解析装饰状态
  const getTextDecoration = () => {
    const decoration = selectedClip.textStyle?.textDecoration || 'none';
    return {
      underline: decoration.includes('underline'),
      lineThrough: decoration.includes('line-through'),
      overline: decoration.includes('overline'),
    };
  };

  // 批量更新所有选中的 clips 的文本样式
  const updateTextStyle = (updates: Partial<typeof selectedClip.textStyle>) => {
    // 使用批量更新，一次性更新所有选中的 clips
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
    // 使用批量更新，一次性更新所有选中的 clips
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

  // 获取字体的显示名称
  const getFontDisplayName = (fontFamily: string): string => {
    if (!fontFamily) return 'Arial';

    // 提取基础字体名称（去掉 variant 后缀）
    const baseFamily = getBaseFontFamily(fontFamily);

    // 从字体列表中获取 displayName
    const font = fontFamiliesRef.current.find((f) => f.family === baseFamily);
    if (font) {
      return font.displayName;
    }

    // 否则返回基础字体名称
    return baseFamily;
  };

  // 处理字体选择器显示
  const handleFontButtonClick = () => {
    if (fontButtonRef.current) {
      const rect = fontButtonRef.current.getBoundingClientRect();
      // 计算位置：距离右侧面板上右都是10px
      // 右侧面板宽度270px，字体面板宽度250px
      const x = rect.left - 370; // 右侧面板宽度270px + 间距10px
      const y = rect.top - 45; // 与按钮顶部对齐

      // 确保面板不超出屏幕边界
      const adjustedX = Math.max(10, x);
      const adjustedY = Math.max(10, y);

      setFontSelectorPosition({ x: adjustedX, y: adjustedY });
      setFontSelectorVisible(true);
    }
  };

  // 处理字体选择
  const handleFontSelect = (font: string) => {
    // 获取字体的所有子项
    const children = getFontChildren(font);

    if (children.length > 0) {
      // 有子项 - 使用完整的 family 名称
      const defaultChild =
        children.find((c) => c.displayName === 'Regular') || children[0];
      const familyName = defaultChild.family; // 直接使用 child.family

      updateTextStyle({ fontFamily: familyName });

      // 更新字重选项 - value 使用完整的 family，label 使用 displayName
      const weightOptions = children.map((child) => ({
        value: child.family, // 使用完整的 family，如 "Microsoft YaHei Bold"
        label: child.displayName, // 显示名称，如 "Bold"
      }));
      setAvailableFontWeights(weightOptions);
    } else {
      // 没有子项 - 直接使用字体名称
      updateTextStyle({ fontFamily: font });

      // 字重选项为空或显示一个默认项
      setAvailableFontWeights([{ value: 'default', label: '默认' }]);
    }
  };

  // 处理字重检测结果（现在基于子项）
  const handleFontWeightsDetected = (font: string, _weights: string[]) => {
    // 获取字体的所有子项
    const children = getFontChildren(font);

    if (children.length === 0) {
      setAvailableFontWeights([{ value: 'default', label: '默认' }]);
      return;
    }

    // 将子项转换为选项 - value 使用完整的 family，label 使用 displayName
    const weightOptions = children.map((child) => ({
      value: child.family, // 使用完整的 family，如 "Microsoft YaHei Bold"
      label: child.displayName, // 显示名称，如 "Bold"
    }));

    // 更新字重选项
    setAvailableFontWeights(weightOptions);
  };

  // 获取字重 Select 的值
  const getFontWeightValue = () => {
    const fontFamily = selectedClip.textStyle?.fontFamily || 'Arial';
    const isAvailable = availableFontWeights.some(
      (option) => option.value === fontFamily
    );
    return isAvailable ? fontFamily : 'default';
  };

  // 处理字重选择变化
  const handleFontWeightChange = (selectedFamily: string | number) => {
    if (selectedFamily === 'default') {
      return;
    }
    updateTextStyle({ fontFamily: String(selectedFamily) });
  };

  // 处理字号 Slider 变化
  const handleFontSizeSliderChange = (value: number) => {
    if (!fontSizeAdjustStartRef.current) {
      fontSizeAdjustStartRef.current = {
        initialFontSize: selectedClip.textStyle?.fontSize || 48,
        initialWidth: selectedClip.width || 300,
        initialHeight: selectedClip.height || 80,
      };
    }
    // 批量更新所有选中的 clips
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

  // 处理对齐选择变化
  const handleTextAlignChange = (value: string | number) => {
    updateTextStyle({ textAlign: String(value) });
  };

  // 处理 Case 选择变化
  const handleTextTransformChange = (value: string | number) => {
    updateTextStyle({ textTransform: String(value) });
  };

  // 处理字号输入变化
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
      // 批量更新所有选中的 clips
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

  // 处理字号输入框获得焦点
  const handleFontSizeInputFocus = () => {
    if (!fontSizeAdjustStartRef.current) {
      fontSizeAdjustStartRef.current = {
        initialFontSize: selectedClip.textStyle?.fontSize || 48,
        initialWidth: selectedClip.width || 300,
        initialHeight: selectedClip.height || 80,
      };
    }
  };

  // 处理字号输入框失去焦点
  const handleFontSizeInputBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const finalValue = isNaN(val) ? 48 : Math.max(5, Math.min(300, Math.round(val)));
    // 批量更新所有选中的 clips
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

  // 处理字号输入框键盘按键
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
        {/* 字体 */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('textStyle.font') || 'Font'}
          </div>
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
              <Icon name='videoEditor-arrow-down-icon' width={12} height={12} className='ml-2' />
            </Button>
          </div>
        </div>

        {/* 字重 */}
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
            disabled={
              availableFontWeights.length === 1 &&
              availableFontWeights[0].value === 'default'
            }
          />
        </div>

        {/* 字号 */}
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

        {/* 颜色 */}
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

        {/* 对齐 */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('textStyle.align') || 'Align'}
          </div>
          <Select
            value={selectedClip.textStyle?.textAlign || 'center'}
            onChange={handleTextAlignChange}
            className='w-[130px]'
            size='small'
            options={[
              { value: 'left', label: t('textStyle.alignLeft') || 'Left' },
              { value: 'center', label: t('textStyle.alignCenter') || 'Center' },
              { value: 'right', label: t('textStyle.alignRight') || 'Right' },
            ]}
          />
        </div>

        {/* 装饰 */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('textStyle.decoration') || 'Decoration'}
          </div>
          <div className='flex gap-2 w-[130px]'>
            <button
              className={`flex-1 border rounded hover:bg-background-default-base flex items-center justify-center h-[26px] ${
                getTextDecoration().underline ? 'bg-background-default-base' : 'bg-background-default-secondary'
              }`}
              onClick={() => handleDecorationClick('underline')}
            >
              <Icon
                name='videoEditor-underline-icon'
                width={14}
                height={14}
                color={getTextDecoration().underline ? 'var(--color-icon-secondary-hover)' : 'var(--color-icon-secondary)'}
              />
            </button>
            <button
              className={`flex-1 border rounded hover:bg-background-default-base flex items-center justify-center h-[26px] ${
                getTextDecoration().lineThrough ? 'bg-background-default-base' : 'bg-background-default-secondary'
              }`}
              onClick={() => handleDecorationClick('lineThrough')}
            >
              <Icon
                name='videoEditor-line-through-icon'
                width={14}
                height={14}
                color={getTextDecoration().lineThrough ? 'var(--color-icon-secondary-hover)' : 'var(--color-icon-secondary)'}
              />
            </button>
            <button
              className={`flex-1 border rounded hover:bg-background-default-base flex items-center justify-center h-[26px] ${
                getTextDecoration().overline ? 'bg-background-default-base' : 'bg-background-default-secondary'
              }`}
              onClick={() => handleDecorationClick('overline')}
            >
              <Icon
                name='videoEditor-overline-icon'
                width={14}
                height={14}
                color={getTextDecoration().overline ? 'var(--color-icon-secondary-hover)' : 'var(--color-icon-secondary)'}
              />
            </button>
            <button
              className={`flex-1 border rounded hover:bg-background-default-base flex items-center justify-center h-[26px] ${
                selectedClip.textStyle?.fontStyle === 'italic' ? 'bg-background-default-base' : 'bg-background-default-secondary'
              }`}
              onClick={handleItalicClick}
            >
              <Icon
                name='videoEditor-italic-icon'
                width={14}
                height={14}
                color={selectedClip.textStyle?.fontStyle === 'italic' ? 'var(--color-icon-secondary-hover)' : 'var(--color-icon-secondary)'}
              />
            </button>
          </div>
        </div>

        {/* Case */}
        <div className='flex items-center justify-between'>
          <div className='text-text-default-tertiary text-xs flex-1'>
            {t('textStyle.case') || 'Case'}
          </div>
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

        {/* 不透明度 */}
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

        {/* 字体描边 */}
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

        {/* 字体阴影 */}
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

      {/* 字体选择器 */}
      <FontSelector
        visible={fontSelectorVisible}
        position={fontSelectorPosition}
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
