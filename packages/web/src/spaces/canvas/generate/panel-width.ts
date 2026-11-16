// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { GENERATE_PANEL_WIDTH_PX } from '@breatic/shared/canvas-model';

/** The panels' width style: `GENERATE_PANEL_WIDTH_PX`, or 92% of a narrower window. */
export const GENERATE_PANEL_WIDTH_STYLE = { width: GENERATE_PANEL_WIDTH_PX, maxWidth: '92vw' } as const;
