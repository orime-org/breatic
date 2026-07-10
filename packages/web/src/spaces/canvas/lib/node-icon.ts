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
 *
 * Accepts an UNTRUSTED value on purpose: the prompt `@` chip reads `kind` from a
 * Yjs-synced attribute, so a corrupt / forward-incompatible doc can carry any
 * string (or a prototype key like `constructor`). `Object.hasOwn` gates the
 * lookup to real own keys so an out-of-range value falls back to a neutral icon
 * instead of returning `undefined` and crashing the React render with
 * "Element type is invalid" (adversarial finding 2026-07-10).
 * @param kind - The source node's modality (may be an unvalidated string).
 * @returns A lucide icon component; the Image icon for any unknown modality.
 */
export function getNodeIcon(
  kind: NodeKind | string | null | undefined,
): LucideIcon {
  return kind != null && Object.hasOwn(ICON_BY_KIND, kind)
    ? ICON_BY_KIND[kind as NodeKind]
    : Image;
}
