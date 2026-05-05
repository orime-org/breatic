import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import FontFaceObserver from 'fontfaceobserver';
import Input from '@/components/base/input';
import { Icon } from '@/components/base/icon';

// fontchild itemsinterface（fontvariant）
interface FontChild {
  family: string; // fontfamily ， "Microsoft YaHei Light"
  displayName: string; // display ， "Light", "Bold"
  url: string; // font path
}

// fontfamilyinterface
interface FontFamily {
  family: string; // fontfamily ， "Microsoft YaHei"
  displayName: string; // display ， " " " "
  url?: string; // font path（ child items use）
  children: FontChild[]; // child itemslist（fontvariant）
}

interface FontSelectorProps {
  visible: boolean;
  currentFont: string;
  onFontSelect: (font: string) => void;
  onClose: () => void;
  onFontWeightsDetected?: (font: string, weights: string[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fontConfig?: any[];
}

const FontSelector: React.FC<FontSelectorProps> = ({
  visible,
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

  // font logic（use fontConfig）
  const initializeFonts = useCallback(async () => {
    if (isInitializedRef.current || fontConfig.length === 0) {
      return;
    }

    try {
      const fonts: FontFamily[] = fontConfig;

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

      // injectstyle
      const styleElement = document.createElement('style');
      styleElement.id = 'dynamic-fonts';
      styleElement.textContent = rules.join('\n\n');
      document.head.appendChild(styleElement);

      // waitfontload
      await Promise.all(fontObservers);

      setFontFamilies(fonts);
      isInitializedRef.current = true;
    } catch (error) {
      console.error('❌ 字体管理器初始化失败:', error);
    }
  }, [fontConfig]);

  // getfont child itemslist
  const getFontChildren = (family: string): FontChild[] => {
    const font = fontFamilies.find(f => f.family === family);
    return font?.children || [];
  };

  // getfont display
  const getFontFamilyName = (family: string): string => {
    const font = fontFamilies.find(f => f.family === family);
    if (!font) return family;
    if (!font.children || font.children.length === 0) {
      return font.family;
    }
    return font.children[0].family;
  };

  // initializefontlist（component load）
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

  // click outsideclosepanel
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

  // handlefont
  const handleFontClick = (fontFamily: FontFamily) => {
    // font （ "Microsoft YaHei"）
    onFontSelect(fontFamily.family);

    // child items
    if (onFontWeightsDetected) {
      const children = getFontChildren(fontFamily.family);
      const childNames = children.map((c) => c.displayName);
      onFontWeightsDetected(fontFamily.family, childNames);
    }

    onClose();
  };

  // handle
  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>, isSelected: boolean) => {
    if (!isSelected) {
      e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
    }
  };

  // handle
  const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>, isSelected: boolean) => {
    if (!isSelected) {
      e.currentTarget.style.backgroundColor = 'transparent';
    }
  };

  if (!visible) return null;

  return (
    <div
      ref={panelRef}
      className='fixed z-50 right-[250px] top-[65px] w-[220px] h-[490px] overflow-hidden bg-[#333333] rounded-md border border-gray-600 shadow-lg'
    >
      {/* title bar */} <div className='flex items-center justify-between px-3 py-2 border-b border-gray-700'> <h3 className='text-xs font-semibold text-white'> {t('fontSelector.title') || ' font'} </h3> <button onClick={onClose} className='text-gray-400 hover:text-white' > <Icon name='videoEditor-close-icon' width={12} height={12} /> </button> </div> {/* search box */} <div className='px-3 py-1'> <div className='relative'> <Icon name='videoEditor-search-icon' width={14} height={14} className='absolute left-0 top-1/2 -translate-y-1/2 text-white/60' /> <Input inputType='text' placeholder={t('fontSelector.searchPlaceholder') || ' ...'} value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} type='borderless' size='small' className='w-full py-2 pl-6 text-xs text-white placeholder-gray-400 bg-transparent focus:outline-none' /> </div> </div> {/* fontlist */}
      <div className='h-[370px] overflow-auto'>
        {filteredFonts.length === 0 ? (
          <div className='px-3 py-4 text-xs text-center text-gray-400'>
            {t('fontSelector.noFontsFound') || '未找到字体'}
          </div>
        ) : (
          filteredFonts.map((fontFamily, index) => {
            // check currentFont family child items family
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
