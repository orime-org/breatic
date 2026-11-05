// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** A canvas clipboard the body's paste tests read, built from short pieces. */

import { serializeClipboard, type ClipboardNode, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';

/**
 * The pieces as a canvas clipboard, top to bottom: `P` a picture node at
 * `url`, anything else a text node holding those words.
 * @param pieces - The pieces.
 * @param url - The picture's address.
 * @returns The clipboard's plain text.
 */
export function canvasClipboardOf(pieces: readonly string[], url = ''): string {
  const nodes = pieces.map(
    (p, index): ClipboardNode =>
      p === 'P'
        ? ({ id: `n${index}`, type: 'image', position: { x: 0, y: index * 300 }, height: 100, data: { content: url } })
        : ({
          id: `n${index}`,
          type: 'text',
          position: { x: 0, y: index * 300 },
          height: 100,
          data: { body: { $y: 'xml', children: [{ el: 'paragraph', attrs: {}, children: [{ text: [{ insert: p }] }] }] } },
        }),
  );
  return serializeClipboard({ version: 2, picked: nodes.map((n) => n.id), nodes, edges: [] } as ClipboardPayload);
}
