// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  Folders,
  Headphones,
  HelpCircle,
  MessageCircle,
  Sparkles,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import type * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';
import type { CreatableNodeType } from '@web/spaces/canvas/node-factory';
import { CreatableNodeMenuItems } from '@web/spaces/canvas/nodes/_shared/CreatableNodeMenuItems';

export type LeftMenuTool =
  | 'nodes'
  | 'upload'
  | 'comment'
  | 'collection'
  | 'help'
  | 'feedback';

type MenuLabelKey =
  | 'menu.item.nodes'
  | 'menu.item.upload'
  | 'menu.item.comment'
  | 'menu.item.collection'
  | 'menu.item.help'
  | 'menu.item.feedback';

interface MenuItem {
  id: LeftMenuTool;
  icon: LucideIcon;
  labelKey: MenuLabelKey;
  placeholder?: boolean;
  /**
   * Only the node-library entry sets this. The featured visual is a
   * permanent highlight flagging the canvas's primary surface — NOT a
   * "selected tool" or "currently active" state. Every other button is
   * a fire-and-forget action with idle + hover only; they never enter
   * any pressed / pinned / activated visual at any moment.
   */
  featured?: boolean;
}

/**
 * Two-zone menu, mirrors the chrome-baseline mock
 * `nav.left-menu > .item / .divider` layout:
 *
 *   Upper zone — core 3 (M0' functional placeholder):
 *     - nodes (node library, sparkles) — FEATURED, always highlighted
 *     - upload (upload assets, upload) — pure action
 *     - comment (annotate, message-circle) — pure action
 *   Divider
 *   Lower zone — placeholders (M1+, muted color, toast on click):
 *     - collection (collection, folders)
 *     - help (help, help-circle)
 *     - feedback (feedback, headphones)
 */
const UPPER_ITEMS: ReadonlyArray<MenuItem> = [
  { id: 'nodes', icon: Sparkles, labelKey: 'menu.item.nodes', featured: true },
  { id: 'upload', icon: Upload, labelKey: 'menu.item.upload' },
  { id: 'comment', icon: MessageCircle, labelKey: 'menu.item.comment' },
];

const LOWER_ITEMS: ReadonlyArray<MenuItem> = [
  {
    id: 'collection',
    icon: Folders,
    labelKey: 'menu.item.collection',
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
  onPick: (tool: LeftMenuTool) => void;
  /**
   * Called when a node type is picked from the node-library dropdown. The
   * node-library button is outside the ReactFlow viewport, so picking only
   * posts the *type*; the canvas resolves the drop point (viewport centre).
   */
  onCreateNode: (type: CreatableNodeType) => void;
  /**
   * When `true`, every tool button is rendered disabled with a
   * tooltip indicating editor permission is required. Per 2026-05-28
   * spec § 6.2 viewers see the menu but can't fire any action.
   */
  disabled?: boolean;
}

/**
 * Shared hit-area styling for every floating-menu tool button, branched by
 * the item's `featured` / `placeholder` visual variant.
 * @param item - The menu item whose visual variant selects the classes.
 * @returns The merged className string for the tool button.
 */
function toolButtonClassName(item: MenuItem): string {
  return cn(
    'inline-flex h-10 w-10 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    item.featured
      ? 'bg-foreground text-background shadow-sm hover:bg-primary-hover'
      : item.placeholder
        ? 'bg-transparent text-muted-foreground/50 hover:text-muted-foreground'
        : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
  );
}

/**
 * Floating left menu over the canvas — chrome-baseline mock `.left-menu`.
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
 *   - featured (node library only): solid bg-foreground, permanent
 *     highlight flagging the canvas's primary surface
 *   - regular action: transparent / muted-foreground, hover lifts to
 *     bg-accent / foreground; click fires onPick once and does not
 *     leave any pressed / pinned state behind
 *   - placeholder: muted-foreground/50 color, hover lifts to muted-foreground
 *
 * Divider:
 *   - 28px wide, 1px border-color line, 4px vertical margin
 * @param root0 - Component props.
 * @param root0.onPick - Fired once with the picked tool id when a menu button is clicked.
 * @param root0.onCreateNode - Fired with the picked node type from the node-library dropdown.
 * @param root0.disabled - When `true`, every tool button is disabled with an editor-permission-required tooltip.
 * @returns The floating left tool menu with upper action zone, divider, and lower placeholder zone.
 */
export function LeftFloatingMenu({
  onPick,
  onCreateNode,
  disabled = false,
}: LeftFloatingMenuProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <nav
      aria-label={t('menu.createAria')}
      data-testid='left-floating-menu'
      data-disabled={disabled ? 'true' : undefined}
      className='absolute left-3 top-1/2 z-10 flex w-[52px] -translate-y-1/2 flex-col items-center gap-1 rounded-lg border border-border bg-popover py-1.5 shadow-sm'
    >
      {UPPER_ITEMS.map((it) =>
        it.id === 'nodes' ? (
          <NodesMenuButton
            key={it.id}
            item={it}
            onCreateNode={onCreateNode}
            disabled={disabled}
          />
        ) : (
          <MenuButton
            key={it.id}
            item={it}
            onPick={onPick}
            disabled={disabled}
          />
        ),
      )}
      <div
        aria-hidden
        data-testid='left-menu-divider'
        className='my-1 h-px w-7 bg-border'
      />
      {LOWER_ITEMS.map((it) => (
        <MenuButton key={it.id} item={it} onPick={onPick} disabled={disabled} />
      ))}
    </nav>
  );
}

/**
 * Single tooltip-wrapped tool button rendered inside the floating menu,
 * styled by its `featured` / `placeholder` flags.
 * @param root0 - Component props.
 * @param root0.item - Menu item describing the button's icon, label, and visual variant.
 * @param root0.onPick - Fired with the item's tool id when the button is clicked.
 * @param root0.disabled - When `true`, the button is disabled and shows the permission-required tooltip.
 * @returns The tool button with its tooltip.
 */
function MenuButton({
  item,
  onPick,
  disabled,
}: {
  item: MenuItem;
  onPick: (tool: LeftMenuTool) => void;
  disabled: boolean;
}): React.JSX.Element {
  const t = useTranslation();
  const Icon = item.icon;
  const label = t(item.labelKey);
  const tooltipLabel = disabled ? t('menu.disabledTooltip') : label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          aria-label={label}
          onClick={() => onPick(item.id)}
          disabled={disabled}
          data-testid={`tool-${item.id}`}
          className={toolButtonClassName(item)}
        >
          <Icon className='h-5 w-5' />
        </button>
      </TooltipTrigger>
      <TooltipContent side='right'>{tooltipLabel}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The node-library entry — a featured button that opens a dropdown of the 4
 * creatable node types instead of firing a fire-and-forget action. Picking a
 * type calls `onCreateNode`; the canvas (which owns the viewport) resolves
 * the drop point. Disabled for viewers (the trigger never opens).
 * @param root0 - Component props.
 * @param root0.item - The node-library menu item (icon, label, featured flag).
 * @param root0.onCreateNode - Called with the chosen creatable node type.
 * @param root0.disabled - When `true`, the trigger is disabled and never opens.
 * @returns The node-library dropdown trigger with its tooltip.
 */
function NodesMenuButton({
  item,
  onCreateNode,
  disabled,
}: {
  item: MenuItem;
  onCreateNode: (type: CreatableNodeType) => void;
  disabled: boolean;
}): React.JSX.Element {
  const t = useTranslation();
  const Icon = item.icon;
  const label = t(item.labelKey);
  const tooltipLabel = disabled ? t('menu.disabledTooltip') : label;
  const button = (
    <button
      type='button'
      aria-label={label}
      disabled={disabled}
      data-testid={`tool-${item.id}`}
      className={toolButtonClassName(item)}
    >
      <Icon className='h-5 w-5' />
    </button>
  );

  // Viewers see the featured button but it never opens — render it without
  // the dropdown wrapper at all (Radix's trigger ignores the child button's
  // `disabled`, so gating has to be structural, not just the attribute).
  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side='right'>{tooltipLabel}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side='right'>{tooltipLabel}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side='right' align='start'>
        <CreatableNodeMenuItems onPick={onCreateNode} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
