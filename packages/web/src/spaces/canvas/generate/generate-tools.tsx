// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The pieces every Generate panel's tool row is built from.
 *
 * Both panels carry a tool row and both rows are made of the same two things:
 * a toggle that enters a canvas pick, and a slot that holds one picked image.
 * They differ only in WHICH tools they show — image has style and focus, video
 * has the source slots its mode needs — so the tools themselves live here and
 * each panel's row just arranges them.
 */

import { X, type LucideIcon } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';

// Shared layout / disabled classes; color + hover applied per-state. The tools
// pass `size={null}` and lay themselves out here (icon over label, two lines) —
// the Button size ladder has no entry for that footprint, and an explicit null
// keeps cva from imposing one.
const TOOL_BASE =
  'flex flex-col items-center gap-1 rounded-overlay px-2 py-1.5 text-xs ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-1 ' +
  'focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed';
const TOOL_INACTIVE =
  ' text-muted-foreground enabled:hover:bg-accent enabled:hover:text-accent-foreground';
// Active toggle = the minimap's white fill (ViewportToolbar VtButton), a solid
// `bg-foreground text-background` with NO accent hover — every toggle in the
// panel must read identically (I4, user 2026-07-12). No hover pair is needed
// because no variant is in play: `variant={null}` leaves this fill as the whole
// appearance, so nothing can flip an active toggle to grey mid-hover.
const TOOL_ACTIVE = ' bg-foreground text-background';

interface ToggleToolProps {
  testId: string;
  label: string;
  /** Hover tooltip describing what the tool does. */
  tip: string;
  Icon: LucideIcon;
  onClick: () => void;
  active: boolean;
  /** Whether the tool is unavailable (Focus in t2i); omitted = always enabled. */
  disabled?: boolean;
}

/**
 * A live toggle tool button (Reference): enters a canvas pick mode and
 * highlights (white fill) while its pick runs, so it reads as a toggle.
 * @param root0 - Component props.
 * @param root0.testId - Stable test id.
 * @param root0.label - Visible + a11y label.
 * @param root0.tip - Hover tooltip describing what the tool does.
 * @param root0.Icon - Lucide icon.
 * @param root0.onClick - Enter / exit the pick.
 * @param root0.active - Whether this tool's pick is running (highlighted).
 * @param root0.disabled - Whether the tool is unavailable in the current mode.
 * @returns The toggle tool button.
 */
export function ToggleTool({
  testId,
  label,
  tip,
  Icon,
  onClick,
  active,
  disabled = false,
}: ToggleToolProps): React.JSX.Element {
  return (
    <ToolTip tip={tip}>
      <Button
        type='button'
        // Styled by hand (TOOL_BASE plus the active / inactive pair) rather
        // than through a Button variant: `variant={null}` opts out of the cva
        // defaults entirely, so these classes are the whole appearance.
        variant={null}
        size={null}
        data-testid={testId}
        onClick={onClick}
        onFocusCapture={suppressTooltipFocusOpen}
        disabled={disabled}
        aria-pressed={active}
        className={TOOL_BASE + (active ? TOOL_ACTIVE : TOOL_INACTIVE)}
      >
        <Icon className='h-4 w-4' aria-hidden='true' />
        {label}
      </Button>
    </ToolTip>
  );
}

/**
 * Wraps a tool button in a hover tooltip carrying its one-line description
 * (user 2026-07-17): the toolbar buttons are icon + short label, so the tip
 * spells out what each pick does. Deliberately NO nested TooltipProvider —
 * the app mounts one provider (App.tsx) whose delayDuration is the
 * calibrated timing every chrome tooltip shares; nesting another here put
 * these tips on their own schedule (user 2026-07-17).
 * @param root0 - Component props.
 * @param root0.tip - The tooltip text.
 * @param root0.children - The button the tooltip describes.
 * @returns The tooltip-wrapped button.
 */
function ToolTip({
  tip,
  children,
}: {
  tip: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side='top'>{tip}</TooltipContent>
    </Tooltip>
  );
}

interface SlotToolProps {
  /** Stable test id for the slot button. */
  testId: string;
  /** Stable test id for the thumbnail image. */
  thumbnailTestId: string;
  /** Stable test id for the ✕ clear badge. */
  clearTestId: string;
  /** The icon shown while the slot is empty. */
  Icon: LucideIcon;
  /** Enter the pick (empty slot), or re-enter to REPLACE (filled slot). */
  onPick: () => void;
  /** Whether this slot's pick is running — highlights the button. */
  active: boolean;
  /** The picked image URL (pick-time copy), or undefined when empty. */
  thumbnail?: string;
  /** Clear the picked image (the ✕ badge). */
  onClear: () => void;
  /** Disable picking — the active model / mode takes no such source. */
  disabled: boolean;
  /** Localized ✕ aria-label. */
  clearLabel: string;
  /** Localized tool label ("Style" / "First frame"). */
  label: string;
  /** Hover tooltip describing the slot. */
  tip: string;
}

/**
 * An image slot tool (#1664 style, #1896 first frame): an icon + label button
 * while empty (click enters the pick); once an image is picked the thumbnail
 * COVERS the button as an absolute overlay while the original icon + label keep
 * laying out invisibly underneath — so the button footprint is IDENTICAL in both
 * states, in every locale, and picking never shifts the toolbar (user
 * 2026-07-16). Clicking the filled slot re-enters the pick (the next selection
 * REPLACES the copy). A ✕ badge at the top-right clears it; the ✕ is a SIBLING
 * button positioned over the corner — never nested inside the main button
 * (button-in-button reparents silently). The ✕ stays active even when picking
 * is gated off, so a stale copy can always be removed. The filled button keeps
 * its accessible name via aria-label (the covered label is hidden from the a11y
 * tree), and a running pick shows as a foreground ring (the white-fill active
 * style would hide behind the image).
 * @param root0 - Component props.
 * @param root0.testId - Stable test id for the slot button.
 * @param root0.thumbnailTestId - Stable test id for the thumbnail image.
 * @param root0.clearTestId - Stable test id for the ✕ clear badge.
 * @param root0.Icon - The icon shown while the slot is empty.
 * @param root0.onPick - Enter / exit the pick.
 * @param root0.active - Whether this slot's pick is running.
 * @param root0.thumbnail - The picked image URL, if any.
 * @param root0.onClear - Clear the picked image.
 * @param root0.disabled - Whether picking is unavailable.
 * @param root0.clearLabel - Localized ✕ aria-label.
 * @param root0.label - Localized tool label.
 * @param root0.tip - Hover tooltip describing the slot.
 * @returns The slot tool.
 */
export function SlotTool({
  testId,
  thumbnailTestId,
  clearTestId,
  Icon,
  onPick,
  active,
  thumbnail,
  onClear,
  disabled,
  clearLabel,
  label,
  tip,
}: SlotToolProps): React.JSX.Element {
  return (
    <div className='relative'>
      <ToolTip tip={tip}>
        <Button
          type='button'
          // Hand-styled like ToggleTool, and for the same reason.
          variant={null}
          size={null}
          data-testid={testId}
          aria-label={label}
          onClick={onPick}
          onFocusCapture={suppressTooltipFocusOpen}
          disabled={disabled}
          aria-pressed={active}
          className={
            'relative overflow-hidden ' +
            TOOL_BASE +
            (active ? TOOL_ACTIVE : TOOL_INACTIVE) +
            (active && thumbnail ? ' ring-1 ring-foreground' : '')
          }
        >
          {/* The icon + label always lay out (invisible when covered) so the
              button's intrinsic size never changes between states. */}
          <Icon
            className={'h-4 w-4' + (thumbnail ? ' invisible' : '')}
            aria-hidden='true'
          />
          <span className={thumbnail ? 'invisible' : undefined}>{label}</span>
          {thumbnail ? (
            <img
              src={thumbnail}
              alt=''
              data-testid={thumbnailTestId}
              className='absolute inset-0 h-full w-full object-cover'
            />
          ) : null}
        </Button>
      </ToolTip>
      {thumbnail ? (
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid={clearTestId}
          aria-label={clearLabel}
          onClick={onClear}
          className='absolute -right-1 -top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <X className='h-2.5 w-2.5' aria-hidden='true' />
        </Button>
      ) : null}
    </div>
  );
}
