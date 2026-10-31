// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Box, Clock, FileText, Palette } from 'lucide-react';
import type { SpaceType } from '@breatic/shared';

/** Each Space type's icon on its tab and on the chat's Space chip. */
export const SPACE_TYPE_ICON: Record<SpaceType, typeof FileText> = {
  canvas: Palette,
  document: FileText,
  timeline: Clock,
  '3d': Box,
};

/**
 * Whether a Space of this type has content the Agent can be sent. A timeline's
 * cannot be read: only its name and type go.
 * @param type - The Space's type.
 * @returns True when its content is read.
 */
export function spaceContentReadable(type: SpaceType): boolean {
  return type === 'canvas' || type === 'document';
}
