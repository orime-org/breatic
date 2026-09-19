// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a text node says, read live (#2175).
 *
 * Every other modality's content is a plain field the node view carries, so
 * the history panel reads it straight off the node. A text node's words are
 * not there — they live in the shared body the editor binds to, deliberately
 * kept out of the view (#1774) so a keystroke does not re-render the canvas.
 * This is the panel's way to that body, and it has to stay live: the reader
 * edits the node with the panel open, and the row marked as what the node
 * holds must stop being marked.
 */

import type * as Y from 'yjs';
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { writePlainTextIntoBody } from '@breatic/shared';
import type { CanvasNodeFields } from '@breatic/shared';

import { addNode, getTextBody } from '@web/data/yjs/canvas-space';
import { _resetForTests } from '@web/data/yjs/manager';
import { useNodeBodyText } from '@web/spaces/canvas/history/use-node-body-text';

const PID = 'p1';
const SID = 's1';

/**
 * Builds a minimal text-node fixture.
 * @param id - Node id.
 * @returns A complete `CanvasNodeFields`.
 */
function textNode(id = 'n1'): CanvasNodeFields {
  return {
    id,
    type: 'text',
    position: { x: 0, y: 0 },
    data: {
      name: 'N',
      createdAt: 1000,
      createdBy: 'u1',
      locked: false,
      attachments: [],
    },
  };
}

describe('useNodeBodyText', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('reads what the node says right now', () => {
    addNode(PID, SID, textNode());
    writePlainTextIntoBody(
      getTextBody(PID, SID, 'n1') as Y.XmlFragment,
      'A red bicycle.',
    );

    const { result } = renderHook(() =>
      useNodeBodyText(PID, SID, 'n1', true),
    );

    expect(result.current).toBe('A red bicycle.');
  });

  it('follows the node as it is edited', () => {
    addNode(PID, SID, textNode());
    const { result } = renderHook(() =>
      useNodeBodyText(PID, SID, 'n1', true),
    );

    act(() => {
      writePlainTextIntoBody(
        getTextBody(PID, SID, 'n1') as Y.XmlFragment,
        'Edited since.',
      );
    });

    expect(result.current).toBe('Edited since.');
  });

  // Every other modality reads its content off the node view. Subscribing a
  // body they do not have would be a subscription that can never fire.
  it('answers nothing when the host is not a text node', () => {
    const { result } = renderHook(() =>
      useNodeBodyText(PID, SID, 'n1', false),
    );

    expect(result.current).toBeNull();
  });
});
