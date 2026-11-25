// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type * as React from 'react';

/** Which navigation the panel sits beside. */
export type DownloadPanelPlacement = 'project' | 'studio' | 'page';

/**
 * Which navigation the panel sits beside on a page.
 * @param _pathname - The page's path.
 * @returns The placement.
 */
export function downloadPanelPlacement(_pathname: string): DownloadPanelPlacement {
  return 'page';
}

/**
 * The desktop client's Downloads panel (inner#2041).
 * @param _props - The current path.
 * @param _props.pathname - The current path.
 * @returns The panel, or nothing.
 */
export function DownloadPanel(_props: { pathname: string }): React.JSX.Element | null {
  return null;
}
