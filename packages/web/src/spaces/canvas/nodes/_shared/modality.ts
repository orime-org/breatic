// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  Box,
  FileText,
  Globe,
  Image as ImageIcon,
  Music,
  Video,
} from 'lucide-react';

import { MODALITY_LABEL, type Modality } from '@breatic/shared/canvas-model';

/** Lucide icon per content modality — shared by the placeholder + name header. */
export const MODALITY_ICONS: Record<Modality, typeof FileText> = {
  text: FileText,
  image: ImageIcon,
  audio: Music,
  video: Video,
  '3d': Box,
  web: Globe,
};

export { MODALITY_LABEL };
