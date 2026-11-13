// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { GENERATE_PANEL_WIDTH_PX } from '@breatic/shared/canvas-model';

/** The panels' width style: `GENERATE_PANEL_WIDTH_PX`, or 92% of a narrower window. */
export const GENERATE_PANEL_WIDTH_STYLE = { width: GENERATE_PANEL_WIDTH_PX, maxWidth: '92vw' } as const;
