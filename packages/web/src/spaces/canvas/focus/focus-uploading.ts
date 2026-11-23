// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The focus crops a node shows as uploading in its reference list (#1580). A crop uploading is a row running, so it
 * follows a node's upload: this page holds its own crop from the confirm until the bytes are sent, and from the moment
 * the upload opens the node's `focusUploads`, written by collab, shows it to every member until it ends. The two are
 * merged by id, and a crop already in the pool is never shown as uploading.
 */

import { validFocusImages, validFocusUploads } from '@breatic/shared';

/** A crop this page is still sending. */
interface LocalCrop {
  id: string;
  nodeId: string;
  name: string;
}

/**
 * The crops `nodeId` shows as uploading.
 * @param local - This page's crops still being sent.
 * @param nodeId - The node.
 * @param data - The node's data, any node type, read for `focusImages` and `focusUploads`; undefined when it is gone.
 * @returns Each crop once, the node's own first.
 */
export function uploadingFocusOf(
  local: ReadonlyArray<LocalCrop>,
  nodeId: string,
  data: object | undefined,
): Array<{ id: string; name: string }> {
  const lists = data as { focusImages?: unknown; focusUploads?: unknown } | undefined;
  const inPool = new Set(validFocusImages(lists?.focusImages).map((f) => f.id));
  const held = validFocusUploads(lists?.focusUploads).filter((u) => !inPool.has(u.id)).map((u) => ({ id: u.id, name: u.name }));
  const seen = new Set([...inPool, ...held.map((u) => u.id)]);
  const mine = local.filter((p) => p.nodeId === nodeId && !seen.has(p.id)).map((p) => ({ id: p.id, name: p.name }));
  return [...held, ...mine];
}
