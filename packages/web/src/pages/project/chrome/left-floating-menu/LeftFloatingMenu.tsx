// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  Keyboard,
  MessageCircle,
  Sparkles,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';
import { suppressTooltipFocusOpen, useReturnFocus } from '@web/lib/overlay-focus';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import { useTranslation } from '@web/i18n/use-translation';
import type { CreatableNodeType } from '@web/spaces/canvas/node-factory';
import { CreatableNodeMenuItems } from '@web/spaces/canvas/nodes/_shared/CreatableNodeMenuItems';
import { CanvasShortcutsDialog } from '@web/spaces/canvas/shortcuts/CanvasShortcutsDialog';

export type LeftMenuTool = 'nodes' | 'upload' | 'comment';

type MenuLabelKey = 'menu.item.nodes' | 'menu.item.upload' | 'menu.item.comment';

interface MenuItem {
  id: LeftMenuTool;
  icon: LucideIcon;
  labelKey: MenuLabelKey;
  /**
   * Only the node-library entry sets this. The featured visual is a
   * permanent highlight flagging the canvas's primary surface — NOT a
   * "selected tool" or "currently active" state.
   */
  featured?: boolean;
  /**
   * Whether this entry arms a mode rather than firing an action.
   *
   * Only the comment button does: pressing it says the NEXT canvas click
   * places a note, and until that click the tool is up. A mode with no
   * visible sign of being up leaves the board looking identical either way
   * (user 2026-09-14, design §6.4.1). Everything else here is one press, one
   * thing happens, nothing pinned.
   */
  arms?: LeftMenuTool;
}

/**
 * Two-zone menu, mirrors the chrome-baseline mock
 * `nav.left-menu > .item / .divider` layout:
 *
 *   Upper zone — the three creation tools:
 *     - nodes (node library, sparkles) — FEATURED, always highlighted
 *     - upload (upload assets, upload) — pure action
 *     - comment (annotate, message-circle) — arms a mode
 *   Divider
 *   Lower zone:
 *     - shortcuts (keyboard shortcuts, keyboard) — opens the shortcuts
 *       dialog; usable by viewers too, since reading it edits nothing
 */
const UPPER_ITEMS: ReadonlyArray<MenuItem> = [
  { id: 'nodes', icon: Sparkles, labelKey: 'menu.item.nodes', featured: true },
  { id: 'upload', icon: Upload, labelKey: 'menu.item.upload' },
  {
    id: 'comment',
    icon: MessageCircle,
    labelKey: 'menu.item.comment',
    arms: 'comment',
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
  /**
   * When `true` (a reference pick is running — batch-2 item 13), the menu
   * slides out through the LEFT edge but stays mounted (its dropdown state
   * survives) and goes `inert` (off-screen controls leave the tab order).
   */
  concealed?: boolean;
  /**
   * Which tool is armed right now, if any — the canvas is waiting on the next
   * click to spend it. Only the comment button can be in this state today.
   */
  armedTool?: LeftMenuTool;
}

/**
 * Shared hit-area styling for every floating-menu tool button.
 * @param solid - Whether the button wears the solid fill: the featured node
 *   library, or a tool that is currently armed.
 * @returns The merged className string for the tool button.
 */
function toolButtonClassName(solid: boolean): string {
  return cn(
    'inline-flex h-10 w-10 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    solid
      ? // The same solid the viewport toolbar's snap / minimap toggles wear
    // while they are on — one visual for "this one is currently on"
    // across the canvas chrome.
      'bg-foreground text-background shadow-sm hover:bg-primary-hover'
      : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
  );
}

/**
 * Floating left menu over the canvas — chrome-baseline mock `.left-menu`.
 *
 * Container:
 *   - absolute, vertically centered, 10px from the Space's left edge
 *     (user 2026-09-01; the same gap the viewport toolbar keeps from the
 *     right and bottom ones)
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
 *   - armed (comment, while the canvas waits for the placing click): the
 *     same solid the viewport toolbar's toggles wear while on
 *   - shortcuts: a regular action that opens the shortcuts dialog
 *
 * Divider:
 *   - 28px wide, 1px border-color line, 4px vertical margin
 * @param root0 - Component props.
 * @param root0.onPick - Fired once with the picked tool id when a menu button is clicked.
 * @param root0.onCreateNode - Fired with the picked node type from the node-library dropdown.
 * @param root0.disabled - When `true` (a viewer), every editing tool is disabled with an editor-permission-required tooltip; the shortcuts button stays usable.
 * @param root0.concealed - When `true` (reference pick running), the menu slides off through the left edge and goes inert.
 * @param root0.armedTool - The tool currently armed, whose button wears the pressed visual.
 * @returns The floating left tool menu with upper action zone, divider, and the shortcuts button.
 */
export function LeftFloatingMenu({
  onPick,
  onCreateNode,
  disabled = false,
  concealed = false,
  armedTool,
}: LeftFloatingMenuProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <nav
      aria-label={t('menu.createAria')}
      data-testid='left-floating-menu'
      // Read by the canvas to keep what it brings into view clear of it.
      data-canvas-chrome=''
      data-disabled={disabled ? 'true' : undefined}
      // Concealment slides, never unmounts (state survives the pick). The
      // -translate-x COMPOSES with the -translate-y-1/2 vertical centering.
      inert={concealed}
      className={cn(
        'absolute left-[var(--space-5)] top-1/2 z-10 flex w-[52px] -translate-y-1/2 flex-col items-center gap-1 rounded-lg border border-border bg-popover py-1.5 shadow-sm transition-transform',
        concealed && '-translate-x-24',
      )}
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
            armedTool={armedTool}
          />
        ),
      )}
      <div
        aria-hidden
        data-testid='left-menu-divider'
        className='my-1 h-px w-7 bg-border'
      />
      <ShortcutsMenuButton readOnly={disabled} />
    </nav>
  );
}

/**
 * Single tooltip-wrapped tool button rendered inside the floating menu,
 * styled by its `featured` flag and armed state.
 * @param root0 - Component props.
 * @param root0.item - Menu item describing the button's icon, label, and visual variant.
 * @param root0.onPick - Fired with the item's tool id when the button is clicked.
 * @param root0.disabled - When `true`, the button is disabled and shows the permission-required tooltip.
 * @param root0.armedTool - The tool armed right now, against which this button decides whether it is pressed.
 * @returns The tool button with its tooltip.
 */
function MenuButton({
  item,
  onPick,
  disabled,
  armedTool,
}: {
  item: MenuItem;
  onPick: (tool: LeftMenuTool) => void;
  disabled: boolean;
  armedTool?: LeftMenuTool;
}): React.JSX.Element {
  const t = useTranslation();
  const Icon = item.icon;
  const label = t(item.labelKey);
  const tooltipLabel = disabled ? t('menu.disabledTooltip') : label;
  // Only a button that arms something can be pressed, and only about the tool
  // it arms — an action button has nothing to be pressed about, so it carries
  // no `aria-pressed` at all rather than a permanent "false".
  const armed = item.arms !== undefined && item.arms === armedTool;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={null}
          size={null}
          type='button'
          aria-label={label}
          onClick={() => onPick(item.id)}
          disabled={disabled}
          aria-pressed={item.arms === undefined ? undefined : armed}
          data-testid={`tool-${item.id}`}
          className={toolButtonClassName(item.featured === true || armed)}
        >
          <Icon className='h-5 w-5' />
        </Button>
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
    <Button
      variant={null}
      size={null}
      type='button'
      aria-label={label}
      disabled={disabled}
      data-testid={`tool-${item.id}`}
      className={toolButtonClassName(item.featured === true)}
      onFocusCapture={suppressTooltipFocusOpen}
    >
      <Icon className='h-5 w-5' />
    </Button>
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
    // `modal={false}` keeps this on-canvas picker from locking body scroll or
    // painting a modal layer over the canvas, matching the other canvas
    // overlay pickers (which are non-modal Popovers). Clicking the canvas then
    // dismisses the menu via outside-click instead of being swallowed by a
    // modal backdrop. The tooltip-refocus fix is independent (onFocusCapture
    // on the trigger); this flag is purely about canvas interaction.
    <DropdownMenu modal={false}>
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

/**
 * The keyboard shortcuts entry below the divider. Reading the list edits
 * nothing, so it stays usable for viewers, who get the rows that work for
 * them. The dialog opens from state, so focus is handed back to this button
 * by `useReturnFocus`, and the button's tooltip does not pop on that refocus.
 * @param root0 - Component props.
 * @param root0.readOnly - Whether the reader cannot edit the canvas.
 * @returns The shortcuts button and its dialog.
 */
function ShortcutsMenuButton({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = useExclusiveOverlay('canvas-shortcuts');
  const returnFocus = useReturnFocus(open);
  // The open flag lives in a global store, so a menu that unmounts (the reader
  // switches Space) must give it back or the dialog reopens on the next mount.
  React.useEffect(() => () => setOpen(false), [setOpen]);
  const label = t('menu.item.shortcuts');
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={null}
            size={null}
            type='button'
            aria-label={label}
            onClick={() => setOpen(true)}
            onFocusCapture={suppressTooltipFocusOpen}
            data-testid='tool-shortcuts'
            className={toolButtonClassName(false)}
          >
            <Keyboard className='h-5 w-5' />
          </Button>
        </TooltipTrigger>
        <TooltipContent side='right'>{label}</TooltipContent>
      </Tooltip>
      <CanvasShortcutsDialog
        open={open}
        onOpenChange={setOpen}
        readOnly={readOnly}
        onCloseAutoFocus={returnFocus}
      />
    </>
  );
}
