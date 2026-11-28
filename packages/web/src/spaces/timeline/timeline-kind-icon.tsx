// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { Code, Film, Image as ImageIcon, Music, Type } from 'lucide-react';

/** Each clip kind's icon, the same on its track face and before its properties heading (inner#1709). */
export const TIMELINE_KIND_ICON = {
  video: <Film className='size-4 shrink-0' />, 'web-animation': <Code className='size-4 shrink-0' />, image: <ImageIcon className='size-4 shrink-0' />,
  text: <Type className='size-4 shrink-0' />, audio: <Music className='size-4 shrink-0' />,
} as const;
