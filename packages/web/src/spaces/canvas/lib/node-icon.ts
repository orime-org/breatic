// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Node modality → representative icon. Used wherever a canvas node is shown
 * without a visual thumbnail — the reference rail and the prompt `@` chip
 * fallback for non-image modalities (text / audio / 3d / web / …). Replaces the
 * old blanket `ImageOff` placeholder so a text node reads as a text node.
 */

import {
  Box,
  FileText,
  Frame,
  Globe,
  Image,
  Music,
  StickyNote,
  Video,
  type LucideIcon,
} from 'lucide-react';

import type { NodeKind } from '@web/spaces/canvas/types/node-view';

/** Single source of truth for modality → icon; exhaustive over {@link NodeKind}. */
const ICON_BY_KIND: Record<NodeKind, LucideIcon> = {
  text: FileText,
  image: Image,
  audio: Music,
  video: Video,
  '3d': Box,
  web: Globe,
  annotation: StickyNote,
  group: Frame,
};

/**
 * Returns the lucide icon representing a node modality, for use where the node
 * has no visual thumbnail to show.
 * @param kind - The source node's modality.
 * @returns The lucide icon component for that modality.
 */
export function getNodeIcon(kind: NodeKind): LucideIcon {
  return ICON_BY_KIND[kind];
}
