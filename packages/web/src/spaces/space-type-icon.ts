// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { Box, Clapperboard, Clock, FileText, Palette } from 'lucide-react';
import type { SpaceType } from '@breatic/shared';

/**
 * Each Space type's icon, wherever the type is shown: the type picker, tabs, the drawer and the chat's Space chips.
 * It lives apart from the `SPACE_TYPES` registry so the picker on the studio page does not load every Space body.
 */
export const SPACE_TYPE_ICON: Record<SpaceType, typeof FileText> = {
  canvas: Palette,
  document: FileText,
  timeline: Clock,
  '3d': Box,
  web_animation: Clapperboard,
};
