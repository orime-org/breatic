// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A node shows no task state (inner#888 §7.8). What its tasks did lives in the
 * counts column beside it and in the task list; the node itself shows its
 * empty state or its content, and its border answers only to selection and
 * hover.
 *
 * Rendered from the projection the canvas mirror uses, so a status that
 * reappears anywhere between the document and the shell turns this red.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { CanvasNodeFields, NodeTaskCounts } from '@breatic/shared';

import { toNodeView } from '@web/data/yjs/node-view';
import { AudioNode } from '@web/spaces/canvas/nodes/AudioNode';
import { ImageNode } from '@web/spaces/canvas/nodes/ImageNode';
import { VideoNode } from '@web/spaces/canvas/nodes/VideoNode';

afterEach(cleanup);

/**
 * A wire node of the given medium carrying these task counts and no content.
 * @param type - The medium.
 * @param counts - The node's four task counts.
 * @returns The wire fields.
 */
function fields(
  type: 'image' | 'video' | 'audio',
  counts: NodeTaskCounts,
): CanvasNodeFields {
  return {
    id: 'n1',
    type,
    position: { x: 0, y: 0 },
    data: {
      name: 'N',
      createdAt: 1000,
      createdBy: 'u1',
      locked: false,
      attachments: [],
      taskCounts: counts,
    },
  };
}

const STATES: ReadonlyArray<[string, NodeTaskCounts]> = [
  ['failed', { running: 0, done: 0, failed: 1, expired: 0 }],
  ['expired', { running: 0, done: 0, failed: 0, expired: 1 }],
  ['running', { running: 1, done: 0, failed: 0, expired: 0 }],
];

/**
 * Render one medium's node from the projection of these counts.
 * @param type - The medium.
 * @param counts - The node's four task counts.
 * @returns The shell element.
 */
function renderNode(
  type: 'image' | 'video' | 'audio',
  counts: NodeTaskCounts,
): HTMLElement {
  const view = toNodeView(fields(type, counts));
  if (view === null) throw new Error('no view');
  if (view.kind === 'image') render(<ImageNode data={view} />);
  else if (view.kind === 'video') render(<VideoNode data={view} />);
  else if (view.kind === 'audio') render(<AudioNode data={view} />);
  return screen.getByTestId(`${type}-node`);
}

describe('a node shows no task state', () => {
  for (const type of ['image', 'video', 'audio'] as const) {
    for (const [state, counts] of STATES) {
      it(`draws no error box and no status border on ${type} whose task is ${state}`, () => {
        const shell = renderNode(type, counts);

        expect(screen.queryByTestId('node-content-error')).toBeNull();
        expect(screen.queryByTestId('node-content-view-tasks')).toBeNull();
        expect(shell.className).not.toMatch(/border-status-(info|error)/);
        expect(screen.getByTestId('node-placeholder')).toBeInTheDocument();
      });
    }
  }
});
