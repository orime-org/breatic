// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A1: the insert menu's media entries and the file picker behind
 * them; the picker puts pending blocks in (inner#1351 + inner#1390).
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { DocumentInsertChoices } from '@web/spaces/document/DocumentInsertChoices';
import {
  DocumentMediaPicker,
  useDocumentMediaPick,
} from '@web/spaces/document/DocumentMediaPicker';
import type { FileEntry } from '@web/spaces/document/document-uploads';

/**
 * The insert menu, open.
 * @param onPickMedia - What a media entry does.
 */
function openMenu(onPickMedia?: (kind: 'image' | 'audio' | 'video') => void): void {
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DocumentInsertChoices onPick={vi.fn()} onPickMedia={onPickMedia} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

describe('the media entries (A1)', () => {
  it('come after the table, in the order image, audio, video', () => {
    openMenu(vi.fn());

    const ids = screen
      .getAllByRole('menuitem')
      .map((item) => item.getAttribute('data-testid'))
      .filter((id) => id !== null);
    expect(ids.slice(-4)).toEqual([
      'doc-block-insert-table',
      'doc-block-insert-image',
      'doc-block-insert-audio',
      'doc-block-insert-video',
    ]);
  });

  it('say which kind was picked', () => {
    const onPickMedia = vi.fn();
    openMenu(onPickMedia);

    fireEvent.click(screen.getByTestId('doc-block-insert-audio'));

    expect(onPickMedia).toHaveBeenCalledWith('audio');
  });

  it('are absent where nothing takes a pick', () => {
    openMenu();

    expect(screen.queryByTestId('doc-block-insert-image')).toBeNull();
  });
});

/** Presses pick for one kind, with the placement the test hands it. */
function PickButton({
  kind,
  place,
}: {
  kind: 'image' | 'audio' | 'video';
  place: (blocks: readonly unknown[]) => boolean;
}): React.JSX.Element {
  const pick = useDocumentMediaPick();
  return (
    <button type='button' data-testid='pick' onClick={() => pick?.(kind, place)}>
      pick
    </button>
  );
}

describe('the file picker (inner#1351 + inner#1390 design §5.9)', () => {
  /**
   * Renders the picker around a button that picks.
   * @param place - Where the pick puts the blocks; false when the row is gone.
   * @param admitted - Whether the chosen files are admitted.
   * @returns The stubs, the call order and the hidden input.
   */
  function setup(
    place: (blocks: readonly unknown[]) => boolean,
    admitted = true,
  ): { entry: FileEntry; start: ReturnType<typeof vi.fn>; order: string[]; input: HTMLInputElement } {
    const order: string[] = [];
    const start = vi.fn(() => order.push('start'));
    const entry: FileEntry = {
      prepare: vi.fn(() => (admitted ? { blocks: ['block'], start } : null)),
      stopCapturing: vi.fn(() => order.push('stop')),
    };
    render(
      <DocumentMediaPicker files={entry}>
        <PickButton
          kind='video'
          place={(blocks) => {
            order.push('place');
            return place(blocks);
          }}
        />
      </DocumentMediaPicker>,
    );
    const input = screen.getByTestId('doc-media-file-input') as HTMLInputElement;
    vi.spyOn(input, 'click').mockImplementation(() => undefined);
    return { entry, start, order, input };
  }

  it('opens the system picker filtered to that kind, taking several files', () => {
    const { input } = setup(() => true);

    fireEvent.click(screen.getByTestId('pick'));

    expect(input.click).toHaveBeenCalled();
    expect(input.multiple).toBe(true);
    expect(input.accept.split(',').every((type) => type.startsWith('video/'))).toBe(true);
  });

  it('puts the admitted files\' blocks in as one undo step, then starts their uploads', () => {
    const place = vi.fn(() => true);
    const { entry, order, input } = setup(place);
    fireEvent.click(screen.getByTestId('pick'));
    expect(place).not.toHaveBeenCalled();

    const chosen = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [chosen] } });

    expect(entry.prepare).toHaveBeenCalledWith([chosen]);
    expect(place).toHaveBeenCalledWith(['block']);
    expect(order).toEqual(['stop', 'place', 'stop', 'start']);
  });

  it('puts nothing in when no chosen file is admitted', () => {
    const place = vi.fn(() => true);
    const { input } = setup(place, false);
    fireEvent.click(screen.getByTestId('pick'));

    fireEvent.change(input, { target: { files: [new File([''], 'e.mp4', { type: 'video/mp4' })] } });

    expect(place).not.toHaveBeenCalled();
  });

  it('starts nothing when the row it was opened on is gone', () => {
    const { start, input } = setup(() => false);
    fireEvent.click(screen.getByTestId('pick'));

    fireEvent.change(input, { target: { files: [new File(['x'], 'clip.mp4', { type: 'video/mp4' })] } });

    expect(start).not.toHaveBeenCalled();
  });

  it('does nothing when the picker is closed with no file', () => {
    const place = vi.fn(() => true);
    const { entry, input } = setup(place);
    fireEvent.click(screen.getByTestId('pick'));

    fireEvent.change(input, { target: { files: [] } });

    expect(entry.prepare).not.toHaveBeenCalled();
    expect(place).not.toHaveBeenCalled();
  });
});
