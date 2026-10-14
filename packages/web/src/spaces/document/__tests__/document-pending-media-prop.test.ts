// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A pending media block is a real image, video or audio block whose
 * `uploadId` is set and whose `url` is empty (inner#1351 design §5.5). The
 * prop exists on all three, defaults to empty, and is not part of any other
 * block.
 */

import { describe, it, expect } from 'vitest';
import { documentBodyFragment } from '@breatic/shared';
import * as Y from 'yjs';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

/**
 * The default of a node's `uploadId` attribute in the real schema.
 * @param node - The node name.
 * @returns The default, or undefined when the node has no such attribute.
 */
function uploadIdDefault(node: string): unknown {
  const doc = new Y.Doc();
  try {
    const { pmSchema } = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
    const attrs = pmSchema.nodes[node]?.spec.attrs as Record<string, { default?: unknown }> | undefined;
    return attrs?.['uploadId']?.default;
  } finally {
    doc.destroy();
  }
}

describe('the uploadId prop', () => {
  it.each(['image', 'video', 'audio'])('%s has it, empty by default', (node) => {
    expect(uploadIdDefault(node)).toBe('');
  });

  it.each(['paragraph', 'heading', 'table'])('%s does not have it', (node) => {
    expect(uploadIdDefault(node)).toBeUndefined();
  });
});
