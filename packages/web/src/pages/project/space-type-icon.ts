// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Clock, FileText, Palette } from 'lucide-react';
import type { SpaceType } from '@breatic/shared';

/** Each Space type's icon, wherever a Space is named: its tab and the chat's Space chip. */
export const SPACE_TYPE_ICON: Record<SpaceType, typeof FileText> = {
  canvas: Palette,
  document: FileText,
  timeline: Clock,
};
