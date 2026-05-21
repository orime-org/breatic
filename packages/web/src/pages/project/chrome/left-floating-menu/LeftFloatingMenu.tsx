import {
  Folders,
  Headphones,
  HelpCircle,
  MessageCircle,
  Sparkles,
  Upload,
  type LucideIcon,
} from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type LeftMenuTool =
  | 'nodes'
  | 'upload'
  | 'comment'
  | 'asset-group'
  | 'help'
  | 'feedback';

interface MenuItem {
  id: LeftMenuTool;
  icon: LucideIcon;
  label: string;
  placeholder?: boolean;
}

/**
 * Two-zone menu, mirrors mock `nav.left-menu > .item / .divider` layout
 * (finalized.html lines 1248-1258):
 *
 *   Upper zone — core 3 (M0' functional placeholder):
 *     - nodes (节点库,sparkles)
 *     - upload (上传素材,upload)
 *     - comment (批注,message-circle)
 *   Divider
 *   Lower zone — placeholders (M1+, muted color, toast on click):
 *     - asset-group (资产组,folders)
 *     - help (帮助,help-circle)
 *     - feedback (反馈,headphones)
 */
const UPPER_ITEMS: ReadonlyArray<MenuItem> = [
  { id: 'nodes', icon: Sparkles, label: '节点库 — 4 类生成节点' },
  { id: 'upload', icon: Upload, label: '上传素材(多文件混合)' },
  { id: 'comment', icon: MessageCircle, label: '在画布加批注' },
];

const LOWER_ITEMS: ReadonlyArray<MenuItem> = [
  {
    id: 'asset-group',
    icon: Folders,
    label: '资产组 — 跨项目共享素材(敬请期待)',
    placeholder: true,
  },
  {
    id: 'help',
    icon: HelpCircle,
    label: '帮助(敬请期待)',
    placeholder: true,
  },
  {
    id: 'feedback',
    icon: Headphones,
    label: '反馈 / 客服(敬请期待)',
    placeholder: true,
  },
];

interface LeftFloatingMenuProps {
  active?: LeftMenuTool;
  onPick: (tool: LeftMenuTool) => void;
}

/**
 * Floating left menu over the canvas — mock `.left-menu`
 * (finalized.html CSS 933-981 + HTML 1248-1258).
 *
 * Container:
 *   - absolute, vertically centered, 12px left offset
 *   - 52px wide fixed, 8px rounded chrome container, popover bg, border,
 *     elevation-1 shadow
 *   - 6/0 padding (top/bottom only), gap 4 between items
 *
 * Items:
 *   - 40x40 hit area (`--btn-menu`), 8px rounded-lg
 *   - 20px lucide icons (`--icon-lg`)
 *   - rest: transparent / muted-foreground
 *   - hover: bg-muted / foreground
 *   - active: bg-foreground / background, shadow-sm
 *   - placeholder: muted-foreground/50 color, hover lifts to muted-foreground
 *
 * Divider:
 *   - 28px wide, 1px border-color line, 4px vertical margin
 */
export function LeftFloatingMenu({ active, onPick }: LeftFloatingMenuProps) {
  return (
    <nav
      aria-label='创建菜单'
      data-testid='left-floating-menu'
      className='absolute left-3 top-1/2 z-10 flex w-[52px] -translate-y-1/2 flex-col items-center gap-1 rounded-lg border border-border bg-popover py-1.5 shadow-sm'
    >
      {UPPER_ITEMS.map((it) => (
        <MenuButton
          key={it.id}
          item={it}
          active={it.id === active}
          onPick={onPick}
        />
      ))}
      <div
        aria-hidden
        data-testid='left-menu-divider'
        className='my-1 h-px w-7 bg-border'
      />
      {LOWER_ITEMS.map((it) => (
        <MenuButton
          key={it.id}
          item={it}
          active={it.id === active}
          onPick={onPick}
        />
      ))}
    </nav>
  );
}

function MenuButton({
  item,
  active,
  onPick,
}: {
  item: MenuItem;
  active: boolean;
  onPick: (tool: LeftMenuTool) => void;
}) {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          aria-label={item.label}
          aria-pressed={active}
          onClick={() => onPick(item.id)}
          data-testid={`tool-${item.id}`}
          className={cn(
            'inline-flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
            active
              ? 'bg-foreground text-background shadow-sm'
              : item.placeholder
                ? 'bg-transparent text-muted-foreground/50 hover:text-muted-foreground'
                : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <Icon className='h-5 w-5' />
        </button>
      </TooltipTrigger>
      <TooltipContent side='right'>{item.label}</TooltipContent>
    </Tooltip>
  );
}
