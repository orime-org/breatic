import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { selectedRect, TableMap } from '@tiptap/pm/tables';
import Tooltip from '@/ui/tooltip';
import { cn } from '@/utils/classnames';
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

const findTextKey = (colorAttr: string | undefined, isDark: boolean): 'default' | NamedKey | null => {
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

const findBackgroundKey = (bgAttr: string | undefined, isDark: boolean): 'default' | NamedKey | null => {
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

const paletteRowBtnClass =
  'flex min-h-8 w-full cursor-pointer items-center gap-2 border-0 px-2 py-1.5 text-left text-[13px] text-text-default-base transition-colors';

const paletteSwatchClass =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border-default-base text-[11px] font-semibold leading-none';

type PaletteSectionId = 'text' | 'bg';

const paletteDropdownSections: readonly {
  id: PaletteSectionId;
  title: string;
  headerClass: string;
}[] = [
  { id: 'text', title: 'Text', headerClass: 'px-2 pb-0.5 pt-1.5' },
  { id: 'bg', title: 'Background', headerClass: 'px-2 pb-0.5 pt-2' },
];

const paletteSwatchStyle = (sectionId: PaletteSectionId, key: 'default' | NamedKey, isDark: boolean): CSSProperties => {
  if (sectionId === 'text') {
    const hex = textHex(key, isDark);
    return hex ? { color: hex } : { color: 'var(--color-text-default-base)' };
  }
  return {
    backgroundColor: bgHex(key, isDark) ?? 'transparent',
    color: 'var(--color-text-default-base)',
  };
};

/** Apply palette to every cell in a table row, column, or the whole table (`tableStart` = table node pos). */
export type TextColorPaletteTableScope =
  | { axis: 'row'; index: number; tableStart?: number }
  | { axis: 'column'; index: number; tableStart?: number }
  | { axis: 'whole'; tableStart: number };

/** Block-level color scope: applies color to all text in a specific `{from, to}` range. */
export type TextColorPaletteBlockScope = {
  from: number;
  to: number;
};

export type TextColorPalettePanelProps = {
  editor: Editor;
  className?: string;
  onAfterPick?: () => void;
  tableScope?: TextColorPaletteTableScope;
  blockScope?: TextColorPaletteBlockScope;
  atomBlockPos?: number;
};

function tryTableSelectedRect(editor: Editor) {
  try {
    return selectedRect(editor.state);
  } catch {
    return null;
  }
}

/** Resolves a TableMap from a known `tableStart` position (content start of the table node). */
function resolveTableMapFromStart(editor: Editor, tableStart: number): TableMap | null {
  try {
    const $ts = editor.state.doc.resolve(tableStart);
    for (let d = $ts.depth; d >= 0; d--) {
      const n = $ts.node(d);
      if (n.type.name === 'table') return TableMap.get(n);
    }
    return null;
  } catch {
    return null;
  }
}

/** Returns [tableStart, TableMap] for the given scope, falling back to scope.tableStart when selectedRect fails. */
function resolveTableContext(
  editor: Editor,
  scope: Exclude<TextColorPaletteTableScope, { axis: 'whole' }>,
): { tableStart: number; map: TableMap } | null {
  const rect = tryTableSelectedRect(editor);
  if (rect) return { tableStart: rect.tableStart, map: rect.map };
  if (scope.tableStart != null) {
    const map = resolveTableMapFromStart(editor, scope.tableStart);
    if (map) return { tableStart: scope.tableStart, map };
  }
  return null;
}

function tableCellInnerRanges(editor: Editor, scope: TextColorPaletteTableScope): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  const pushCellInner = (abs: number) => {
    const cell = editor.state.doc.nodeAt(abs);
    if (!cell || (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader')) return;
    const from = abs + 1;
    const to = abs + cell.nodeSize - 1;
    if (from < to) ranges.push({ from, to });
  };

  if (scope.axis === 'whole') {
    const table = editor.state.doc.nodeAt(scope.tableStart);
    if (!table || table.type.name !== 'table') return [];
    const map = TableMap.get(table);
    const tableContentStart = scope.tableStart + 1;
    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) {
        pushCellInner(tableContentStart + map.map[row * map.width + col]);
      }
    }
    return ranges;
  }

  const ctx = resolveTableContext(editor, scope);
  if (!ctx) return [];
  const { tableStart, map } = ctx;
  if (scope.axis === 'row') {
    const row = scope.index;
    if (row < 0 || row >= map.height) return [];
    for (let col = 0; col < map.width; col++) {
      pushCellInner(tableStart + map.map[row * map.width + col]);
    }
  } else {
    const col = scope.index;
    if (col < 0 || col >= map.width) return [];
    for (let row = 0; row < map.height; row++) {
      pushCellInner(tableStart + map.map[row * map.width + col]);
    }
  }
  return ranges;
}

function applyTextColorToTableScope(
  editor: Editor,
  scope: TextColorPaletteTableScope,
  key: 'default' | NamedKey,
  isDark: boolean,
  onAfterPick?: () => void,
): void {
  const ranges = tableCellInnerRanges(editor, scope);
  for (const { from, to } of ranges) {
    if (key === 'default') {
      editor.chain().focus().setTextSelection({ from, to }).unsetColor().run();
    } else {
      const hex = textHex(key, isDark);
      if (hex) editor.chain().focus().setTextSelection({ from, to }).setColor(hex).run();
    }
  }
  onAfterPick?.();
}

/** Sets `backgroundColor` on every `tableCell` / `tableHeader` in the scoped row or column. */
function applyCellBackgroundToTableScope(
  editor: Editor,
  scope: TextColorPaletteTableScope,
  key: 'default' | NamedKey,
  isDark: boolean,
  onAfterPick?: () => void,
): void {
  const color: string | null = key === 'default' ? null : (bgHex(key, isDark) ?? null);
  const { state, view } = editor;
  let tr = state.tr;

  const paintCell = (abs: number) => {
    const cell = tr.doc.nodeAt(abs);
    if (!cell || (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader')) return;
    tr = tr.setNodeMarkup(abs, undefined, { ...cell.attrs, backgroundColor: color });
  };

  if (scope.axis === 'whole') {
    const table = state.doc.nodeAt(scope.tableStart);
    if (!table || table.type.name !== 'table') {
      onAfterPick?.();
      return;
    }
    const map = TableMap.get(table);
    const tableContentStart = scope.tableStart + 1;
    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) {
        paintCell(tableContentStart + map.map[row * map.width + col]);
      }
    }
    if (tr.docChanged) view.dispatch(tr);
    onAfterPick?.();
    return;
  }

  const ctx = resolveTableContext(editor, scope);
  if (!ctx) {
    onAfterPick?.();
    return;
  }
  const { tableStart, map } = ctx;

  if (scope.axis === 'row') {
    if (scope.index < 0 || scope.index >= map.height) {
      onAfterPick?.();
      return;
    }
    for (let col = 0; col < map.width; col++) {
      paintCell(tableStart + map.map[scope.index * map.width + col]);
    }
  } else {
    if (scope.index < 0 || scope.index >= map.width) {
      onAfterPick?.();
      return;
    }
    for (let row = 0; row < map.height; row++) {
      paintCell(tableStart + map.map[row * map.width + scope.index]);
    }
  }

  if (tr.docChanged) view.dispatch(tr);
  onAfterPick?.();
}

function firstScopedCellBackgroundColor(editor: Editor, scope: TextColorPaletteTableScope): string | undefined {
  let abs: number | null = null;
  if (scope.axis === 'whole') {
    const table = editor.state.doc.nodeAt(scope.tableStart);
    if (!table || table.type.name !== 'table') return undefined;
    const map = TableMap.get(table);
    if (map.height < 1 || map.width < 1) return undefined;
    abs = scope.tableStart + 1 + map.map[0];
  } else {
    const ctx = resolveTableContext(editor, scope);
    if (!ctx) return undefined;
    const { tableStart, map } = ctx;
    if (scope.axis === 'row') {
      if (scope.index < 0 || scope.index >= map.height) return undefined;
      abs = tableStart + map.map[scope.index * map.width + 0];
    } else {
      if (scope.index < 0 || scope.index >= map.width) return undefined;
      abs = tableStart + map.map[0 * map.width + scope.index];
    }
  }
  const cell = editor.state.doc.nodeAt(abs);
  if (!cell) return undefined;
  const raw = (cell.attrs as { backgroundColor?: string | null }).backgroundColor;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Same Text / Background palette as the bubble menu — reusable as a nested submenu. */
export const TextColorPalettePanel = ({
  editor,
  className,
  onAfterPick,
  tableScope,
  blockScope,
  atomBlockPos,
}: TextColorPalettePanelProps) => {
  const isDark = useDocumentTheme() === 'dark';

  useEditorState({
    editor,
    selector: ({ transactionNumber, editor: ed }) => {
      if (typeof atomBlockPos !== 'number') return transactionNumber;
      const raw = ed.state.doc.nodeAt(atomBlockPos)?.attrs as { accentBackground?: string | null } | undefined;
      return [transactionNumber, raw?.accentBackground ?? ''] as const;
    },
  });

  const attrs = editor.getAttributes('textStyle') as {
    color?: string;
    backgroundColor?: string;
  };
  const colorAttr = attrs.color;
  const bgAttr = attrs.backgroundColor;

  const atomAccent =
    typeof atomBlockPos === 'number'
      ? (editor.state.doc.nodeAt(atomBlockPos)?.attrs as { accentBackground?: string | null })?.accentBackground
      : undefined;
  const namedTextKey = findTextKey(colorAttr, isDark);
  const cellBgAttr = tableScope ? firstScopedCellBackgroundColor(editor, tableScope) : undefined;
  const namedBgKey =
    typeof atomBlockPos === 'number'
      ? findBackgroundKey(typeof atomAccent === 'string' ? atomAccent : undefined, isDark)
      : findBackgroundKey(tableScope ? cellBgAttr : bgAttr, isDark);

  const sections: readonly { id: PaletteSectionId; title: string; headerClass: string }[] =
    typeof atomBlockPos === 'number'
      ? [{ id: 'bg', title: 'Background', headerClass: 'px-2 pb-0.5 pt-1.5' }]
      : paletteDropdownSections;

  const applyTextColor = (key: 'default' | NamedKey) => {
    if (tableScope) {
      applyTextColorToTableScope(editor, tableScope, key, isDark, onAfterPick);
      return;
    }
    if (blockScope && blockScope.from < blockScope.to) {
      // Select the entire block range first, then apply color to all text in it
      const chain = editor.chain().focus().setTextSelection({ from: blockScope.from, to: blockScope.to });
      if (key === 'default') {
        chain.unsetColor().run();
      } else {
        const hex = textHex(key, isDark);
        if (hex) chain.setColor(hex).run();
      }
      onAfterPick?.();
      return;
    }
    if (key === 'default') {
      editor.chain().focus().unsetColor().run();
    } else {
      const hex = textHex(key, isDark);
      if (hex) editor.chain().focus().setColor(hex).run();
    }
    onAfterPick?.();
  };

  const applyBackgroundColor = (key: 'default' | NamedKey) => {
    if (typeof atomBlockPos === 'number') {
      const hex = key === 'default' ? null : (bgHex(key, isDark) ?? null);
      const n = editor.state.doc.nodeAt(atomBlockPos);
      if (n) {
        editor
          .chain()
          .focus()
          .setNodeSelection(atomBlockPos)
          .updateAttributes(n.type.name, { accentBackground: hex })
          .run();
      }
      onAfterPick?.();
      return;
    }
    if (tableScope) {
      applyCellBackgroundToTableScope(editor, tableScope, key, isDark, onAfterPick);
      return;
    }
    if (blockScope && blockScope.from < blockScope.to) {
      // Select the entire block range first, then apply background color to all text in it
      const chain = editor.chain().focus().setTextSelection({ from: blockScope.from, to: blockScope.to });
      if (key === 'default') {
        chain.unsetBackgroundColor().run();
      } else {
        const hex = bgHex(key, isDark);
        if (hex) chain.setBackgroundColor(hex).run();
      }
      onAfterPick?.();
      return;
    }
    if (key === 'default') {
      editor.chain().focus().unsetBackgroundColor().run();
    } else {
      const hex = bgHex(key, isDark);
      if (hex) editor.chain().focus().setBackgroundColor(hex).run();
    }
    onAfterPick?.();
  };

  return (
    <div
      className={cn(
        'min-w-[168px] rounded-[8px] border border-border-default-base bg-background-default-base py-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]',
        className,
      )}
    >
      {sections.map((sec) => {
        const activeKey = sec.id === 'text' ? namedTextKey : namedBgKey;
        const apply = sec.id === 'text' ? applyTextColor : applyBackgroundColor;
        const sectionTitle = tableScope && sec.id === 'bg' ? 'Cell background' : sec.title;
        return (
          <Fragment key={sec.id}>
            <div className={cn(sec.headerClass, 'text-[11px] font-medium text-text-default-tertiary')}>
              {sectionTitle}
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
                    isActive
                      ? 'bg-background-default-secondary font-medium'
                      : 'bg-transparent hover:bg-background-default-secondary',
                  )}
                >
                  <span className={paletteSwatchClass} style={paletteSwatchStyle(sec.id, key, isDark)} aria-hidden>
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
  );
};

export type CellBackgroundPaletteProps = {
  /** `null` clears cell background. */
  onPick: (backgroundCssColor: string | null) => void;
  className?: string;
};

/** Same preset background swatches as the text palette — for table cell `backgroundColor` only. */
export function CellBackgroundPalette({ onPick, className }: CellBackgroundPaletteProps) {
  const isDark = useDocumentTheme() === 'dark';

  return (
    <div
      className={cn(
        'min-w-[168px] rounded-[8px] border border-border-default-base bg-background-default-base py-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]',
        className,
      )}
    >
      <div className='px-2 pb-0.5 pt-1.5 text-[11px] font-medium text-text-default-tertiary'>Background</div>
      {colorOrder.map((key) => (
        <button
          key={key}
          type='button'
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(key === 'default' ? null : (bgHex(key, isDark) ?? null))}
          className={cn(paletteRowBtnClass, 'bg-transparent hover:bg-background-default-secondary')}
        >
          <span className={paletteSwatchClass} style={paletteSwatchStyle('bg', key, isDark)} aria-hidden>
            A
          </span>
          {colorLabels[key]}
        </button>
      ))}
    </div>
  );
}

const TextColorSelect = ({ editor }: TextColorSelectProps) => {
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

  const textSwatchFill = colorAttr && colorAttr.length > 0 ? colorAttr : 'var(--color-text-default-base)';

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={wrapRef} className='relative'>
      <Tooltip title='Text & background' placement='top' offset={4}>
        <button
          type='button'
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
          className='flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 text-icon-base transition-colors hover:bg-background-default-base-hover'
          aria-label='Text and background color'
        >
          <span
            className='flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[4px]'
            style={bgAttr && bgAttr.length > 0 ? { backgroundColor: bgAttr } : undefined}
            aria-hidden
          >
            <span className='select-none text-[12px] font-medium leading-none' style={{ color: textSwatchFill }}>
              A
            </span>
          </span>
        </button>
      </Tooltip>

      {open && (
        <div className='absolute left-0 top-full z-[91] mt-1'>
          <TextColorPalettePanel editor={editor} onAfterPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
};

export default TextColorSelect;
