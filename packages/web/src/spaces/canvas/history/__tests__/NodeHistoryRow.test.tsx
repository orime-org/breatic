// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { NodeHistoryEntry } from '@web/data/api/canvas';
import {
  NodeHistoryRow,
  type HistoryModality,
} from '@web/spaces/canvas/history/NodeHistoryRow';

// t(key) → key, so assertions target the i18n key the chip renders.
vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));

/**
 * Builds a history-entry fixture. Defaults to a FAILED generation — failed rows
 * carry no thumbnail (`thumbSrc` returns null), so no `ThumbnailHoverPreview` /
 * Tooltip is mounted and the row renders standalone.
 * @param over - Field overrides merged onto the failed-generation default.
 * @returns A {@link NodeHistoryEntry}.
 */
function entry(over: Partial<NodeHistoryEntry> = {}): NodeHistoryEntry {
  return {
    id: 'h1',
    operatorName: null,
    entryType: 'generation',
    status: 'failed',
    content: null,
    thumbnailUrl: null,
    errorMessage: 'boom',
    metadata: {},
    createdAt: '2026-07-21T00:00:00.000Z',
    ...over,
  };
}

/**
 * Renders a row with the given entry.
 * @param e - The history entry to render.
 * @param modality - The host node modality (defaults to image).
 * @returns Nothing.
 */
function renderRow(
  e: NodeHistoryEntry,
  modality: HistoryModality = 'image',
): void {
  render(
    <NodeHistoryRow
      entry={e}
      modality={modality}
      isCurrent={false}
      onRestore={() => {}}
    />,
  );
}

describe('NodeHistoryRow (#1619)', () => {
  // #1 (user 2026-07-22): the type chip states ONLY the type (Generated /
  // Upload), never the outcome. Before the fix a FAILED row's chip rendered
  // `canvas.history.failed` ("Can't restore") and the type key was absent —
  // mislabelling the entry and duplicating the right-slot action.
  it('failed generation row: the type chip states the TYPE, not the failure', () => {
    renderRow(entry({ entryType: 'generation', status: 'failed' }));
    expect(screen.getByText('canvas.history.typeGeneration')).toBeTruthy();
  });

  it('upload row: the type chip states Upload', () => {
    renderRow(entry({ entryType: 'upload', status: 'failed' }));
    expect(screen.getByText('canvas.history.typeUpload')).toBeTruthy();
  });

  // Who-operated (#1619): the operator's joined display name shows next to the
  // time when resolved, and the row falls back to time alone when it is null.
  it('shows the operator name AND its separator next to the time when resolved', () => {
    renderRow(entry({ operatorName: 'Justin' }));
    expect(screen.getByText('Justin')).toBeTruthy();
    // The "·" separator renders WITH the name — both gated on operatorName.
    expect(screen.queryByText('·')).not.toBeNull();
  });

  it('shows only the time — no name, no orphan separator — when unresolved (null)', () => {
    renderRow(entry({ operatorName: null }));
    expect(screen.queryByText('Justin')).toBeNull();
    // A null operator falls back to the time ALONE: the "·" separator must not
    // render on its own. Guards against an unconditional separator leaving a
    // dangling "·" on every unresolved row (Gate-2 caught the vacuous version).
    expect(screen.queryByText('·')).toBeNull();
  });
});
