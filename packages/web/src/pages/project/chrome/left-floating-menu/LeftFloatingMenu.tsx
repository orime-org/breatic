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
import { useTranslation } from '@/i18n/use-translation';

export type LeftMenuTool =
  | 'nodes'
  | 'upload'
  | 'comment'
  | 'asset-group'
  | 'help'
  | 'feedback';

type MenuLabelKey =
  | 'menu.item.nodes'
  | 'menu.item.upload'
  | 'menu.item.comment'
  | 'menu.item.assetGroup'
  | 'menu.item.help'
  | 'menu.item.feedback';

interface MenuItem {
  id: LeftMenuTool;
  icon: LucideIcon;
  labelKey: MenuLabelKey;
  placeholder?: boolean;
}

/**
 * Two-zone menu, mirrors mock `nav.left-menu > .item / .divider` layout
 * (finalized.html lines 1248-1258):
 *
 *   Upper zone — core 3 (M0' functional placeholder):
 *     - nodes (node library, sparkles)
 *     - upload (upload assets, upload)
 *     - comment (annotate, message-circle)
 *   Divider
 *   Lower zone — placeholders (M1+, muted color, toast on click):
 *     - asset-group (asset group, folders)
 *     - help (help, help-circle)
 *     - feedback (feedback, headphones)
 */
const UPPER_ITEMS: ReadonlyArray<MenuItem> = [
  { id: 'nodes', icon: Sparkles, labelKey: 'menu.item.nodes' },
  { id: 'upload', icon: Upload, labelKey: 'menu.item.upload' },
  { id: 'comment', icon: MessageCircle, labelKey: 'menu.item.comment' },
];

const LOWER_ITEMS: ReadonlyArray<MenuItem> = [
  {
    id: 'asset-group',
    icon: Folders,
    labelKey: 'menu.item.assetGroup',
    placeholder: true,
  },
  {
    id: 'help',
    icon: HelpCircle,
    labelKey: 'menu.item.help',
    placeholder: true,
  },
  {
    id: 'feedback',
    icon: Headphones,
    labelKey: 'menu.item.feedback',
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
  const t = useTranslation();
  return (
    <nav
      aria-label={t('menu.createAria')}
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
  const t = useTranslation();
  const Icon = item.icon;
  const label = t(item.labelKey);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          aria-label={label}
          aria-pressed={active}
          onClick={() => onPick(item.id)}
          data-testid={`tool-${item.id}`}
          className={cn(
            'inline-flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
            active
              ? // Active button: solid swap to `--color-primary-hover` (light
                // = neutral-700, dark = neutral-500) — same hover treatment
                // Button / Badge / ChatComposer send use for foreground-bg
                // buttons, so chrome stays consistent.
                'bg-foreground text-background shadow-sm hover:bg-primary-hover'
              : item.placeholder
                ? 'bg-transparent text-muted-foreground/50 hover:text-muted-foreground'
                : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Icon className='h-5 w-5' />
        </button>
      </TooltipTrigger>
      <TooltipContent side='right'>{label}</TooltipContent>
    </Tooltip>
  );
}
