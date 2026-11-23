// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DesktopBridge } from '@breatic/shared';

/**
 * The desktop client's bridge when this page runs inside it (inner#2041).
 * @returns The bridge, or null in a browser.
 */
export function getDesktopBridge(): DesktopBridge | null {
  return (window as { breaticDesktop?: DesktopBridge }).breaticDesktop ?? null;
}
