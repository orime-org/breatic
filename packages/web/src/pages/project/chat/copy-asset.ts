// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Copying a found picture so it can be pasted onto the canvas.
 *
 * The clipboard gets the canvas's own text for one image node whose content
 * is the picture's address, flagged as outside our storage: pasting it makes
 * the server fetch the address into storage for the new node.
 */

import * as React from 'react';

import { COPY_ANSWER_MS } from '@web/pages/project/chat/copy-answer';
import type { ChatAsset } from '@web/pages/project/chat/types';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { serializeNodes, type ClipboardNode } from '@web/spaces/canvas/node-clipboard';

/**
 * The address a copy hands to the canvas: the thumbnail.
 *
 * The original is in whatever format the site that published it chose, and
 * storage takes PNG, JPEG and WebP only (an AVIF original is refused). The
 * thumbnail is the search service's own https copy, served as JPEG, or PNG
 * for a PNG original, and it is the picture the row already shows.
 * @param asset - The picture.
 * @returns The address to fetch.
 */
function addressOf(asset: ChatAsset): string {
  return asset.thumbnailUrl;
}

/**
 * The clipboard text a copy writes for one picture.
 * @param asset - The picture.
 * @returns The canvas's clipboard text for one image node from outside.
 */
export function clipboardTextFor(asset: ChatAsset): string {
  const node: ClipboardNode = {
    type: 'image',
    position: { x: 0, y: 0 },
    ...(asset.title !== '' ? { name: asset.title } : {}),
    content: addressOf(asset),
    external: true,
  };
  return serializeNodes([node]);
}

/** One row's copy state, shared by every button that copies a picture of it. */
export interface CopyAsset {
  /** The address of the picture the last copy wrote, while that answer is up. */
  copied: string | null;
  /** Copy a picture. */
  copy: (asset: ChatAsset) => void;
}

/**
 * Copy pictures of one row, with one answer shared across its buttons.
 *
 * Both buttons of a picture read the same answer, so the one in the open box
 * says copied when the corner one was pressed. A failed write says so and
 * leaves the button pressable.
 * @returns The answer and the action.
 */
export function useCopyAsset(): CopyAsset {
  const t = useTranslation();
  const [copied, setCopied] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  const copy = React.useCallback(
    (asset: ChatAsset) => {
      const address = addressOf(asset);
      void navigator.clipboard
        .writeText(clipboardTextFor(asset))
        .then(() => {
          if (timer.current !== undefined) clearTimeout(timer.current);
          setCopied(address);
          timer.current = setTimeout(() => {
            timer.current = undefined;
            setCopied(null);
          }, COPY_ANSWER_MS);
        })
        .catch(() => {
          toast.error(t('common.clipboardError'));
        });
    },
    [t],
  );

  return { copied, copy };
}

/**
 * Whether a picture is the one the last copy wrote.
 * @param state - The row's copy state.
 * @param asset - The picture.
 * @returns Whether its buttons say copied.
 */
export function isCopied(state: CopyAsset, asset: ChatAsset): boolean {
  return state.copied === addressOf(asset);
}
