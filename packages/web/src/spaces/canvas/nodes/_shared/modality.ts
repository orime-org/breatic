// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  Box,
  FileText,
  Globe,
  Image as ImageIcon,
  Music,
  Video,
} from 'lucide-react';

import type { Modality } from '@web/spaces/canvas/types/node-view';

/** Lucide icon per content modality — shared by the placeholder + name header. */
export const MODALITY_ICONS: Record<Modality, typeof FileText> = {
  text: FileText,
  image: ImageIcon,
  audio: Music,
  video: Video,
  '3d': Box,
  web: Globe,
};

/**
 * Fixed English display label per modality. Used both as the empty-node
 * default `data.name` (the factory) and as the name-header fallback when a
 * node's name is blank. A DATA value, not an i18n UI string (see the 2a
 * design): it stays a fixed English literal so it never freezes a locale.
 */
export const MODALITY_LABEL: Record<Modality, string> = {
  text: 'Text',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  '3d': '3D',
  web: 'Web',
};
