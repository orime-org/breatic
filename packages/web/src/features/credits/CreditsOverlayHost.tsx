// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { CreditsOverlay } from '@web/features/credits/CreditsOverlay';
import { CREDITS_OVERLAY_ID } from '@web/stores/credit-refusals';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';

/**
 * The credits overlay on a page that has no account menu to open it, the
 * Project page: a refusal's 充值 opens it here (inner#1968, design 3.3).
 * @returns The overlay, closed until something opens it.
 */
export function CreditsOverlayHost(): React.JSX.Element {
  const [open, setOpen] = useExclusiveOverlay(CREDITS_OVERLAY_ID);
  return <CreditsOverlay open={open} onOpenChange={setOpen} />;
}
