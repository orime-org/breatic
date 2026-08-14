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

import { Slot } from '@radix-ui/react-slot';
import { X, type LucideIcon } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import { getNodeIcon } from '@web/spaces/canvas/lib/node-icon';
import { HoverPreview } from '@web/spaces/canvas/nodes/_shared/HoverPreview';
import type { HoverPreviewKind } from '@web/spaces/canvas/nodes/_shared/HoverPreview';

// Shared layout / disabled classes; color + hover applied per-state. The tools
// pass `size={null}` and lay themselves out here (icon over label, two lines) —
// the Button size ladder has no entry for that footprint, and an explicit null
// keeps cva from imposing one.
const TOOL_BASE =
  'flex flex-col items-center gap-1 rounded-overlay border border-border ' +
  'px-2 py-1.5 text-xs ' +
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
 * `suppressed` withholds the content rather than the whole wrapper: a caller
 * that stops needing the tip (a slot that just got filled, which previews
 * instead) must not change the element type at this position, or React would
 * unmount and remount the button underneath and take keyboard focus with it
 * (#1946).
 * @param root0 - Component props.
 * @param root0.tip - The tooltip text.
 * @param root0.suppressed - Keep the wrapper but never open the tip.
 * @param root0.children - The button the tooltip describes.
 * @returns The tooltip-wrapped button.
 */
const ToolTip = React.forwardRef<
  HTMLElement,
  { tip: string; suppressed?: boolean; children: React.ReactNode }
>(function ToolTip({ tip, suppressed = false, children, ...rest }, ref) {
  // Controlled in BOTH states, never `undefined`: handing Radix a boolean one
  // render and nothing the next flips it between controlled and uncontrolled,
  // which React warns about and which strands whatever open state it had. A
  // slot crosses that boundary on every fill and every clear.
  const [open, setOpen] = React.useState(false);
  return (
    <Tooltip open={suppressed ? false : open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        {/* `Slot` merges what an OUTER `asChild` trigger clones onto this
            component — pointer / focus handlers, data-state, the popper anchor
            ref — down onto the button. Taking `children` straight would swallow
            all of it, since a plain function component keeps only the props it
            destructures: that silently unwired the hover preview of every
            filled slot, and the suite could not see it because it stubs
            HoverPreview out (#1946 Gate 2 round 2). */}
        <Slot ref={ref} {...rest}>
          {children}
        </Slot>
      </TooltipTrigger>
      {suppressed ? null : <TooltipContent side='top'>{tip}</TooltipContent>}
    </Tooltip>
  );
});

/**
 * What a slot holds, or `undefined` when it holds nothing.
 *
 * One object rather than a `filled` flag beside a `thumbnail`: those two could
 * disagree (a thumbnail with nothing filled), and the filled state needs all
 * three facts together — the form decides the icon AND the preview, the asset
 * is what the preview plays, and the thumbnail is what the button paints.
 */
export interface SlotPick {
  /**
   * Which form of asset the slot holds. Picks the icon (via `getNodeIcon`, the
   * same function the reference rail resolves its icon through) and the form
   * the hover preview renders.
   */
  kind: HoverPreviewKind;
  /** The asset itself — what the hover preview plays or shows. */
  url: string;
  /**
   * The picture to paint over the button, when this asset has one. Audio never
   * does, and a video only does once it has a cover (#1821), which is why the
   * button cannot read fullness off this field.
   */
  thumbnail?: string;
}

interface SlotToolProps {
  /** Stable test id for the slot button. */
  testId: string;
  /** Stable test id for the thumbnail image. */
  thumbnailTestId: string;
  /** Stable test id for the ✕ clear badge. */
  clearTestId: string;
  /** The icon shown while the slot is empty — what the slot WANTS. */
  Icon: LucideIcon;
  /** Enter the pick (empty slot), or re-enter to REPLACE (filled slot). */
  onPick: () => void;
  /** Whether this slot's pick is running — highlights the button. */
  active: boolean;
  /** What the slot holds, or undefined when it holds nothing. */
  pick?: SlotPick;
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
 * A slot tool (#1664 style, #1896 first frame, #1918 driving video): an icon +
 * label button while empty (click enters the pick); once the slot holds a pick,
 * that pick COVERS the button as an absolute overlay while the original icon +
 * label keep laying out invisibly underneath — so the button footprint is
 * IDENTICAL in both states, in every locale, and picking never shifts the
 * toolbar (user 2026-07-16).
 *
 * The cover is the thumbnail when the pick has one, and otherwise the ASSET
 * NODE's own icon standing in for it (#1946). Never the slot's own icon plus
 * its label: that is the empty state, and audio (which has no picture by
 * nature) and a coverless video used to render it while holding a pick —
 * indistinguishable from empty but for the ✕. The stand-in icon comes from
 * `getNodeIcon`, the same function the reference rail resolves its own icon
 * through, so the two places cannot drift apart.
 *
 * Clicking the filled slot re-enters the pick (the next selection REPLACES the
 * copy). A ✕ badge at the top-right clears it; the ✕ is a SIBLING button
 * positioned over the corner — never nested inside the main button
 * (button-in-button reparents silently). The ✕ stays active even when picking
 * is gated off, so a stale copy can always be removed. The filled button keeps
 * its accessible name via aria-label (the covered label is hidden from the a11y
 * tree), and a running pick shows as a foreground ring (the white-fill active
 * style would hide behind the image).
 *
 * A filled slot hovers into the shared `HoverPreview` (#1814) the reference
 * rail, the prompt chips, the history rows and the activity feed already use:
 * audio and video play, an image shows large. The preview REPLACES the tooltip
 * while filled — the rail carries no tooltip for the same reason, and two
 * floating cards on one trigger would open together. An empty slot keeps the
 * tooltip, which is what says WHAT to pick.
 * @param root0 - Component props.
 * @param root0.testId - Stable test id for the slot button.
 * @param root0.thumbnailTestId - Stable test id for the thumbnail image.
 * @param root0.clearTestId - Stable test id for the ✕ clear badge.
 * @param root0.Icon - The icon shown while the slot is empty.
 * @param root0.onPick - Enter / exit the pick.
 * @param root0.active - Whether this slot's pick is running.
 * @param root0.pick - What the slot holds, or undefined when it holds nothing.
 * @param root0.onClear - Clear the pick.
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
  pick,
  onClear,
  disabled,
  clearLabel,
  label,
  tip,
}: SlotToolProps): React.JSX.Element {
  const HeldIcon = pick ? getNodeIcon(pick.kind) : null;
  // A disabled button dispatches no pointerenter and takes no focus, so both of
  // the HoverCard's open paths are dead — declaring a preview there promises
  // something the user can never get (the style slot after switching to a model
  // without style support).
  const previews = pick !== undefined && !disabled;
  const button = (
    <Button
      type='button'
      // Hand-styled like ToggleTool, and for the same reason.
      variant={null}
      size={null}
      data-testid={testId}
      aria-label={label}
      onClick={onPick}
      // Suppressing the focus-open belongs to the tooltip alone. It stops the
      // focus event in the capture phase, which also stops the SAME element's
      // onFocus — and that is how a HoverCard opens, so leaving it on while
      // previewing would muzzle the preview for keyboard users, alone among the
      // five places that share this preview.
      onFocusCapture={previews ? undefined : suppressTooltipFocusOpen}
      disabled={disabled}
      aria-pressed={active}
      className={
        'relative overflow-hidden ' +
        TOOL_BASE +
        (active ? TOOL_ACTIVE : TOOL_INACTIVE) +
        (active && pick ? ' ring-1 ring-foreground' : '')
      }
    >
      {/* The icon + label always lay out (invisible when covered) so the
          button's intrinsic size never changes between states. */}
      <Icon className={'h-4 w-4' + (pick ? ' invisible' : '')} aria-hidden='true' />
      <span className={pick ? 'invisible' : undefined}>{label}</span>
      {pick ? (
        pick.thumbnail ? (
          <img
            src={pick.thumbnail}
            alt=''
            data-testid={thumbnailTestId}
            className='absolute inset-0 h-full w-full object-cover'
          />
        ) : (
          // No plate behind it (user 2026-08-14): the icon alone stands in for
          // the picture, and the button's own border already bounds it.
          <span className='absolute inset-0 flex h-full w-full items-center justify-center'>
            {HeldIcon ? <HeldIcon className='h-5 w-5' aria-hidden='true' /> : null}
          </span>
        )
      ) : null}
    </Button>
  );
  return (
    <div className='relative'>
      {/* BOTH wrappers stay mounted in both states, and each decides for itself
          whether to open. Alternating them instead — preview when filled,
          tooltip when empty — swaps the component at this position, so React
          unmounts and remounts the button and keyboard focus sitting on it
          drops to <body>. Reachable one-handed: Tab to the slot, then Cmd+Z,
          since the undo gate excludes only INPUT / TEXTAREA / contenteditable
          and undoing the fill empties the slot underneath the focus. */}
      <HoverPreview
        // `kind` is inert without a `src`; the empty state passes none, so
        // HoverPreview withholds its card and stays inert — mounted, but with
        // nothing to open and no viewport follower armed.
        kind={pick?.kind ?? 'image'}
        src={previews ? pick?.url : undefined}
        // A poster is a still, so only a video has use for one; an image's
        // thumbnail IS its asset and audio has neither.
        poster={previews && pick?.kind === 'video' ? pick.thumbnail : undefined}
        followCanvas
      >
        {/* The tooltip says WHAT to pick, which only an empty slot needs; a
            filled one has the preview instead, the way the rail does. */}
        <ToolTip tip={tip} suppressed={previews}>
          {button}
        </ToolTip>
      </HoverPreview>
      {pick ? (
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
