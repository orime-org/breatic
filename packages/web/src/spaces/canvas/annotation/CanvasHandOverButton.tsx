// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import { HandOverButton, type HandOverButtonProps } from '@web/features/comment-handover/HandOverButton';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/**
 * The hand-over button on a canvas note: its list follows the board as it
 * pans and zooms.
 * @param props - As `HandOverButton`.
 * @returns The buttons.
 */
export function CanvasHandOverButton(
  props: Omit<HandOverButtonProps, 'onOpenChange' | 'avoidCollisions' | 'size'>,
): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  useFollowCanvasViewport(open);
  return <HandOverButton {...props} size='compact' onOpenChange={setOpen} avoidCollisions={false} />;
}
