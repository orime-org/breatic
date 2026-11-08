// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { ChoiceMenu } from '@web/spaces/canvas/generate/ChoiceMenu';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/** One selectable generation mode. */
export interface ModeOption {
  /** The mode id written to the node (`t2i` / `i2v` / …). */
  value: string;
  /**
   * Display label — English only, never localized (user 2026-07-10 item 15).
   * These are product mode names in the do-not-translate spirit of the DNT
   * glossary, so they read identically across all locales.
   */
  label: string;
  /** Stable test id for this option row. */
  testId: string;
}

interface ModeToggleProps {
  /** The active mode. */
  value: string;
  /** The modes this panel offers, in display order. */
  options: ReadonlyArray<ModeOption>;
  /** Called with the newly-picked mode (only when it differs from the active one). */
  onChange: (mode: string) => void;
  /** Test id for the trigger pill. */
  triggerTestId: string;
}

/**
 * The generation-mode picker sitting to the LEFT of the model picker (mode
 * toggle 2026-07-09 §2.1; popover form per user 2026-07-10 item 1): a pill
 * showing the active mode that opens a popover to switch.
 *
 * One component for every panel: which modes exist is the caller's business,
 * but the pill, the popover, the canvas-follow and the no-op-on-reselect rule
 * are the same question each time — and the video panel would otherwise be a
 * second copy of sixty lines of popover wiring that could drift on any of them.
 * Presentational: the active mode + change handler are threaded in by the
 * container, which writes the switch to Yjs. Picking the already-active mode is
 * a no-op so a redundant write never resets the node's model / params.
 * @param root0 - Component props.
 * @param root0.value - The active generation mode.
 * @param root0.options - The modes this panel offers.
 * @param root0.onChange - Called with the newly-picked mode.
 * @param root0.triggerTestId - Test id for the trigger pill.
 * @returns The mode picker.
 */
export const ModeToggle = React.memo(function ModeToggle({
  value,
  options,
  onChange,
  triggerTestId,
}: ModeToggleProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  // Follow the ReactFlow viewport while open (#1796): Radix's Floating-UI
  // auto-update does not track the canvas's CSS-transform pan/zoom, so the
  // popover would drift off its trigger — same fix as the ratio / camera / model
  // pickers. Inert while closed.
  useFollowCanvasViewport(open);
  return (
    <ModePill value={value} options={options} onChange={onChange} triggerTestId={triggerTestId}
      // Clip, don't flip/shift, at a screen edge (like the ratio / camera / model
      // pickers): a following popover that flipped would fight the follow and
      // jump as the canvas pans (user's clip-not-jump, #1788).
      avoidCollisions={false} onOpenChange={setOpen} />
  );
});

interface ModePillProps extends ModeToggleProps {
  /** Whether the list moves to stay on screen. */
  avoidCollisions?: boolean;
  /** Told when the list opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** Whether the pill cannot be pressed. */
  disabled?: boolean;
}

/**
 * The mode pill on its own, for a panel that does not sit on the canvas (the
 * 3D generation dialog, inner#1691): it opens upward, a list of the modes.
 * @param root0 - Props.
 * @param root0.value - The active generation mode.
 * @param root0.options - The modes offered.
 * @param root0.onChange - Called with the newly-picked mode.
 * @param root0.triggerTestId - Test id for the pill.
 * @param root0.avoidCollisions - Whether the list moves to stay on screen.
 * @param root0.onOpenChange - Told when the list opens or closes.
 * @param root0.disabled - Whether the pill cannot be pressed.
 * @returns The pill.
 */
export function ModePill({ value, options, onChange, triggerTestId, avoidCollisions, onOpenChange, disabled }: ModePillProps): React.JSX.Element {
  const select = React.useCallback((next: string | number): void => onChange(String(next)), [onChange]);
  return (
    <ChoiceMenu value={value} options={options} onSelect={select} triggerTestId={triggerTestId} triggerClassName='shrink-0 rounded-full'
      side='top' avoidCollisions={avoidCollisions} onOpenChange={onOpenChange} disabled={disabled} />
  );
}
