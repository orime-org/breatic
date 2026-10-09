// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A1: the insert menu's media entries and the file picker behind
 * them.
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
import type { DocumentUploader } from '@web/spaces/document/document-uploads';
import type { UploadGap } from '@web/spaces/document/document-upload-slots';

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

/** Presses pick for one kind, with the gap the test hands it. */
function PickButton({
  kind,
  gap,
}: {
  kind: 'image' | 'audio' | 'video';
  gap: () => UploadGap | null;
}): React.JSX.Element {
  const pick = useDocumentMediaPick();
  return (
    <button type='button' data-testid='pick' onClick={() => pick?.(kind, gap)}>
      pick
    </button>
  );
}

describe('the file picker (A1)', () => {
  /**
   * Renders the picker around a button that picks.
   * @param gap - The gap the pick makes when files arrive.
   * @returns The uploader stub and the hidden input.
   */
  function setup(
    gap: () => UploadGap | null,
  ): { start: ReturnType<typeof vi.fn>; input: HTMLInputElement } {
    const start = vi.fn().mockResolvedValue(undefined);
    const uploader = { start, retry: vi.fn(), remove: vi.fn() } as unknown as DocumentUploader;
    const view = {} as never;
    render(
      <DocumentMediaPicker uploader={uploader} view={() => view}>
        <PickButton kind='video' gap={gap} />
      </DocumentMediaPicker>,
    );
    const input = screen.getByTestId('doc-media-file-input') as HTMLInputElement;
    return { start, input };
  }

  it('opens the system picker filtered to that kind, taking several files', () => {
    const { input } = setup(() => null);
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);

    fireEvent.click(screen.getByTestId('pick'));

    expect(click).toHaveBeenCalled();
    expect(input.multiple).toBe(true);
    expect(input.accept.split(',').every((type) => type.startsWith('video/'))).toBe(true);
  });

  it('hands the chosen files over with the way to make their gap, and makes none itself', () => {
    const anchor = { before: 'a', after: 'b' };
    const gap = vi.fn(() => ({ anchor, quoted: true }));
    const { input, start } = setup(gap);
    vi.spyOn(input, 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByTestId('pick'));
    expect(gap).not.toHaveBeenCalled();

    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [file] } });

    // The uploader makes the gap once a file is admitted.
    expect(gap).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.anything(), [file], gap);
  });

  it('makes no gap and starts nothing when the picker is closed with no file', () => {
    const gap = vi.fn(() => ({ anchor: { before: null, after: null }, quoted: false }));
    const { input, start } = setup(gap);
    vi.spyOn(input, 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByTestId('pick'));

    fireEvent.change(input, { target: { files: [] } });

    expect(gap).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
