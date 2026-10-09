// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Media in pasted content, kept only when its address is one of ours
 * (inner#1127 A18).
 *
 * With image, video and audio blocks in the schema, BlockNote's parse rules
 * turn every `<img>`, `<video>`, `<audio>` and Markdown `![]()` in a paste
 * into a media block pointing wherever the source pointed
 * (`Image/block.ts:55-75`, `Video/block.ts:35-49`, `Audio/block.ts:53-67`).
 * A block in this body has to carry an address our storage registered, so
 * each pasted medium is judged by its own address: under our public prefix
 * it stays, otherwise it is left out and the reader is told how many were.
 *
 * `transformPasted` sees every paste and every drop from outside the editor.
 * A row dragged within the body never reaches it — `document-drag-move.ts`
 * takes that drop first. While our prefix is not known yet, every medium is
 * left out: undo brings the paste back as it was before it.
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';

import { isMediaBlockType } from '@web/spaces/document/document-media-types';


/** What the body needs to judge pasted media. */
export interface PastedMediaOptions {
  /** What every address of ours starts with, or null while it is not known. */
  readonly assetUrlPrefix: () => string | null;
  /** Told how many media a paste left out, when it left any out. */
  readonly onLeftOut: (count: number) => void;
}

/**
 * Whether a block container holds a medium that is not ours.
 * @param node - A node of the pasted slice.
 * @param prefix - Our prefix, or null.
 * @returns True when it has to be left out.
 */
function isOutsideMedium(node: PMNode, prefix: string | null): boolean {
  if (node.type.name !== 'blockContainer') return false;
  const own = node.firstChild;
  if (own === null || !isMediaBlockType(own.type.name)) return false;
  const url = own.attrs['url'];
  return prefix === null || typeof url !== 'string' || !url.startsWith(prefix);
}

/**
 * A fragment with every outside medium taken out, and how many were.
 *
 * A nested block group emptied by this goes too: a block container may have
 * no group, and an empty one is not allowed (`blockGroupChild+`). The rows
 * nested under a medium taken out stay, in its place.
 * @param fragment - The fragment.
 * @param prefix - Our prefix, or null.
 * @returns The fragment and the count.
 */
function strip(fragment: Fragment, prefix: string | null): { fragment: Fragment; count: number } {
  let count = 0;
  const kept: PMNode[] = [];
  fragment.forEach((node) => {
    if (isOutsideMedium(node, prefix)) {
      count += 1;
      // The rows nested under it are text the reader pasted: they take its place.
      const group = node.lastChild;
      if (node.childCount > 1 && group !== null && group.type.name === 'blockGroup') {
        const inner = strip(group.content, prefix);
        count += inner.count;
        inner.fragment.forEach((child) => kept.push(child));
      }
      return;
    }
    if (node.isLeaf || node.isTextblock) {
      kept.push(node);
      return;
    }
    const inner = strip(node.content, prefix);
    count += inner.count;
    if (inner.count === 0) {
      kept.push(node);
    } else if (node.type.name !== 'blockGroup' || inner.fragment.childCount > 0) {
      kept.push(node.copy(inner.fragment));
    }
  });
  return { fragment: Fragment.from(kept), count };
}

/**
 * The extension that judges pasted media.
 * @param options - Our prefix and where the count goes; left out, every
 *   pasted medium is left out and nobody is told.
 * @returns The extension, for the assembly to register.
 */
export function documentPastedMediaExtension(
  options: PastedMediaOptions | undefined,
): ExtensionFactoryInstance {
  return createExtension(() => ({
    key: 'documentPastedMedia',
    prosemirrorPlugins: [
      new Plugin({
        props: {
          transformPasted: (slice) => {
            const { fragment, count } = strip(slice.content, options?.assetUrlPrefix() ?? null);
            if (count === 0) return slice;
            options?.onLeftOut(count);
            return fragment.childCount === 0
              ? Slice.empty
              : Slice.maxOpen(fragment);
          },
        },
      }),
    ],
  }) as never)();
}
