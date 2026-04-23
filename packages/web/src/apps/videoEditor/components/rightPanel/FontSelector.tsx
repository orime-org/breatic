import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import FontFaceObserver from 'fontfaceobserver';
import Input from '@/components/base/input';
import { Icon } from '@/components/base/icon';

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

interface FontSelectorProps {
  visible: boolean;
  position: { x: number; y: number };
  currentFont: string;
  onFontSelect: (font: string) => void;
  onClose: () => void;
  onFontWeightsDetected?: (font: string, weights: string[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fontConfig?: any[];
}

const FontSelector: React.FC<FontSelectorProps> = ({
  visible,
  position: _position,
  currentFont,
  onFontSelect,
  onClose,
  onFontWeightsDetected,
  fontConfig = [],
}) => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [fontFamilies, setFontFamilies] = useState<FontFamily[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const isInitializedRef = useRef(false);

  // 字体管理器逻辑（使用传入的 fontConfig）
  const initializeFonts = useCallback(async () => {
    if (isInitializedRef.current || fontConfig.length === 0) {
      return;
    }

    try {
      const fonts: FontFamily[] = fontConfig;

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
      const styleElement = document.createElement('style');
      styleElement.id = 'dynamic-fonts';
      styleElement.textContent = rules.join('\n\n');
      document.head.appendChild(styleElement);

      // 等待字体加载
      await Promise.all(fontObservers);

      setFontFamilies(fonts);
      isInitializedRef.current = true;
    } catch (error) {
      console.error('❌ 字体管理器初始化失败:', error);
    }
  }, [fontConfig]);

  // 获取字体的子项列表
  const getFontChildren = (family: string): FontChild[] => {
    const font = fontFamilies.find(f => f.family === family);
    return font?.children || [];
  };

  // 获取字体的显示名称
  const getFontFamilyName = (family: string): string => {
    const font = fontFamilies.find(f => f.family === family);
    if (!font) return family;
    if (!font.children || font.children.length === 0) {
      return font.family;
    }
    return font.children[0].family;
  };

  // 初始化字体列表（组件挂载时加载）
  useEffect(() => {
    initializeFonts();
  }, [initializeFonts]);

  const filteredFonts = useMemo(() => {
    if (!searchTerm) {
      return fontFamilies;
    }
    return fontFamilies.filter(
      (font) =>
        font.displayName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        font.family.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [searchTerm, fontFamilies]);

  // 点击外部关闭面板
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    if (!visible) return;

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [visible, onClose]);

  // 处理字体选择
  const handleFontClick = (fontFamily: FontFamily) => {
    // 传递基础字体名（如 "Microsoft YaHei"）
    onFontSelect(fontFamily.family);

    // 通知子项信息
    if (onFontWeightsDetected) {
      const children = getFontChildren(fontFamily.family);
      const childNames = children.map((c) => c.displayName);
      onFontWeightsDetected(fontFamily.family, childNames);
    }

    onClose();
  };

  // 处理鼠标进入
  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>, isSelected: boolean) => {
    if (!isSelected) {
      e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
    }
  };

  // 处理鼠标离开
  const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>, isSelected: boolean) => {
    if (!isSelected) {
      e.currentTarget.style.backgroundColor = 'transparent';
    }
  };

  if (!visible) return null;

  return (
    <div
      ref={panelRef}
      className='fixed z-50 right-[230px] top-[56px] w-[220px] h-[490px] overflow-hidden bg-[#333333] rounded-md border border-gray-600 shadow-lg'
    >
      {/* 标题栏 */}
      <div className='flex items-center justify-between px-3 py-2 border-b border-gray-700'>
        <h3 className='text-xs font-semibold text-white'>
          {t('fontSelector.title') || '选择字体'}
        </h3>
        <button
          onClick={onClose}
          className='text-gray-400 hover:text-white'
        >
          <Icon name='videoEditor-close-icon' width={12} height={12} />
        </button>
      </div>

      {/* 搜索框 */}
      <div className='px-3 py-1'>
        <div className='relative'>
          <Icon name='videoEditor-search-icon' width={14} height={14} className='absolute left-0 top-1/2 -translate-y-1/2 text-white/60' />
          <Input
            inputType='text'
            placeholder={t('fontSelector.searchPlaceholder') || '搜索字体...'}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            type='borderless'
            size='small'
            className='w-full py-2 pl-6 text-xs text-white placeholder-gray-400 bg-transparent focus:outline-none'
          />
        </div>
      </div>

      {/* 字体列表 */}
      <div className='h-[370px] overflow-auto'>
        {filteredFonts.length === 0 ? (
          <div className='px-3 py-4 text-xs text-center text-gray-400'>
            {t('fontSelector.noFontsFound') || '未找到字体'}
          </div>
        ) : (
          filteredFonts.map((fontFamily, index) => {
            // 检查 currentFont 是否匹配基础 family 或任何子项的 family
            const isSelected =
              currentFont === fontFamily.family ||
              (fontFamily.children && fontFamily.children.some(child => child.family === currentFont));

            return (
              <div
                key={index}
                className={`px-3 py-2 cursor-pointer text-white ${
                  isSelected ? 'bg-white/10' : 'bg-transparent'
                }`}
                onMouseEnter={(e) => handleMouseEnter(e, isSelected)}
                onMouseLeave={(e) => handleMouseLeave(e, isSelected)}
                onClick={() => handleFontClick(fontFamily)}
              >
                <div
                  style={{
                    fontFamily: getFontFamilyName(fontFamily.family),
                  }}
                  className='text-xs truncate'
                >
                  {fontFamily.displayName}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default memo(FontSelector);
