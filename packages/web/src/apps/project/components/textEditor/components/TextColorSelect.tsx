import {
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import Tooltip from '@/components/base/tooltip';
import { cn } from '@/utils/classnames';
/** BlockNote `defaultColors` — text + background per theme. */
const textColors = {
  light: {
    gray: '#9b9a97',
    brown: '#64473a',
    red: '#e03e3e',
    orange: '#d9730d',
    yellow: '#dfab01',
    green: '#4d6461',
    blue: '#0b6e99',
    purple: '#6940a5',
    pink: '#ad1a72',
  },
  dark: {
    gray: '#bebdb8',
    brown: '#8e6552',
    red: '#ec4040',
    orange: '#e3790d',
    yellow: '#dfab01',
    green: '#6b8b87',
    blue: '#0e87bc',
    purple: '#8552d7',
    pink: '#da208f',
  },
} as const;

const backgroundColors = {
  light: {
    gray: '#ebeced',
    brown: '#e9e5e3',
    red: '#fbe4e4',
    orange: '#f6e9d9',
    yellow: '#fbf3db',
    green: '#ddedea',
    blue: '#ddebf1',
    purple: '#eae4f2',
    pink: '#f4dfeb',
  },
  dark: {
    gray: '#9b9a97',
    brown: '#64473a',
    red: '#be3434',
    orange: '#b7600a',
    yellow: '#b58b00',
    green: '#4d6461',
    blue: '#0b6e99',
    purple: '#6940a5',
    pink: '#ad1a72',
  },
} as const;

type NamedKey = keyof typeof textColors.light;

const colorOrder: Array<'default' | NamedKey> = [
  'default',
  'gray',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
];

const colorLabels: Record<'default' | NamedKey, string> = {
  default: 'Default',
  gray: 'Gray',
  brown: 'Brown',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
};

const normHex = (c: string) => c.trim().toLowerCase();

const textMap = (isDark: boolean) => (isDark ? textColors.dark : textColors.light);
const bgMap = (isDark: boolean) => (isDark ? backgroundColors.dark : backgroundColors.light);

const textHex = (key: 'default' | NamedKey, isDark: boolean): string | undefined => {
  if (key === 'default') return undefined;
  return textMap(isDark)[key];
};

const findTextKey = (
  colorAttr: string | undefined,
  isDark: boolean,
): 'default' | NamedKey | null => {
  if (!colorAttr) return 'default';
  const n = normHex(colorAttr);
  const map = textMap(isDark);
  for (const key of Object.keys(map) as NamedKey[]) {
    if (normHex(map[key]) === n) return key;
  }
  return null;
};

const bgHex = (key: 'default' | NamedKey, isDark: boolean): string | undefined => {
  if (key === 'default') return undefined;
  return bgMap(isDark)[key];
};

const findBackgroundKey = (
  bgAttr: string | undefined,
  isDark: boolean,
): 'default' | NamedKey | null => {
  if (!bgAttr) return 'default';
  const n = normHex(bgAttr);
  const map = bgMap(isDark);
  for (const key of Object.keys(map) as NamedKey[]) {
    if (normHex(map[key]) === n) return key;
  }
  return null;
};

const useDocumentTheme = (): 'light' | 'dark' =>
  useSyncExternalStore(
    (onChange) => {
      const el = document.documentElement;
      const mo = new MutationObserver(() => onChange());
      mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
      return () => mo.disconnect();
    },
    () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'),
    () => 'light',
  );

export type TextColorSelectProps = {
  editor: Editor;
};

const paletteRowBtnClass = 'flex min-h-8 w-full cursor-pointer items-center gap-2 border-0 px-2 py-1.5 text-left text-[13px] text-text-default-base transition-colors';

const paletteSwatchClass = 'flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border-default-base text-[11px] font-semibold leading-none';

type PaletteSectionId = 'text' | 'bg';

const paletteDropdownSections: readonly {
  id: PaletteSectionId;
  title: string;
  headerClass: string;
}[] = [
  { id: 'text', title: 'Text', headerClass: 'px-2 pb-0.5 pt-1.5' },
  { id: 'bg', title: 'Background', headerClass: 'px-2 pb-0.5 pt-2' },
];

const paletteSwatchStyle = (
  sectionId: PaletteSectionId,
  key: 'default' | NamedKey,
  isDark: boolean,
): CSSProperties => {
  if (sectionId === 'text') {
    const hex = textHex(key, isDark);
    return hex ? { color: hex } : { color: 'var(--color-text-default-base)' };
  }
  return {
    backgroundColor: bgHex(key, isDark) ?? 'transparent',
    color: 'var(--color-text-default-base)',
  };
};

const TextColorSelect = ({ editor }: TextColorSelectProps) => {
  const isDark = useDocumentTheme() === 'dark';
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  const attrs = editor.getAttributes('textStyle') as {
    color?: string;
    backgroundColor?: string;
  };
  const colorAttr = attrs.color;
  const bgAttr = attrs.backgroundColor;

  const namedTextKey = findTextKey(colorAttr, isDark);
  const namedBgKey = findBackgroundKey(bgAttr, isDark);

  const textSwatchFill =
    colorAttr && colorAttr.length > 0 ? colorAttr : 'var(--color-text-default-base)';

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const applyTextColor = (key: 'default' | NamedKey) => {
    if (key === 'default') {
      editor.chain().focus().unsetColor().run();
    } else {
      const hex = textHex(key, isDark);
      if (hex) editor.chain().focus().setColor(hex).run();
    }
    setOpen(false);
  };

  const applyBackgroundColor = (key: 'default' | NamedKey) => {
    if (key === 'default') {
      editor.chain().focus().unsetBackgroundColor().run();
    } else {
      const hex = bgHex(key, isDark);
      if (hex) editor.chain().focus().setBackgroundColor(hex).run();
    }
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className='relative'>
      <Tooltip title='Text & background' placement='top' offset={4}>
        <button
          type='button'
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
          className='flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 text-icon-base transition-colors hover:bg-background-default-base-hover'
          style={bgAttr && bgAttr.length > 0 ? { backgroundColor: bgAttr } : undefined}
          aria-label='Text and background color'
        >
          <span
            className='select-none text-[14px]'
            style={{ color: textSwatchFill }}
            aria-hidden
          >
            A
          </span>
        </button>
      </Tooltip>

      {open && (
        <div className='absolute left-0 top-full z-[9999] mt-1 min-w-[168px] rounded-[8px] border border-border-default-base bg-background-default-base py-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'>
          {paletteDropdownSections.map((sec) => {
            const activeKey = sec.id === 'text' ? namedTextKey : namedBgKey;
            const apply = sec.id === 'text' ? applyTextColor : applyBackgroundColor;
            return (
              <Fragment key={sec.id}>
                <div className={cn(sec.headerClass, 'text-[11px] font-medium text-text-default-tertiary')}>
                  {sec.title}
                </div>
                {colorOrder.map((key) => {
                  const isActive = key === 'default' ? activeKey === 'default' : activeKey === key;
                  return (
                    <button
                      key={`${sec.id}-${key}`}
                      type='button'
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => apply(key)}
                      className={cn(
                        paletteRowBtnClass,
                        isActive ? 'bg-background-default-secondary font-medium' : 'bg-transparent hover:bg-background-default-secondary',
                      )}
                    >
                      <span
                        className={paletteSwatchClass}
                        style={paletteSwatchStyle(sec.id, key, isDark)}
                        aria-hidden
                      >
                        A
                      </span>
                      {colorLabels[key]}
                    </button>
                  );
                })}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TextColorSelect;
