// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The crop dialog's failure and lifecycle behaviour.
 *
 * Every case here is a hole an adversarial review found in the shipped code,
 * kept so the same hole cannot reopen. The crop geometry itself is covered by
 * `avatar-crop.test.ts` and by a real-browser run — jsdom reports every size
 * as zero, so it can say nothing about where the selection lands.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { AvatarCropDialog } from '@web/pages/studio/container/dialogs/AvatarCropDialog';

vi.mock('@web/i18n/use-translation', () => ({
  useTranslation: () => (key: string) => key,
}));

const objectUrls: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  objectUrls.length = 0;
  revoked.length = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => {
      const u = `blob:mock/${objectUrls.length}`;
      objectUrls.push(u);
      return u;
    }),
    revokeObjectURL: vi.fn((u: string) => revoked.push(u)),
  });
});

/**
 * A picked file. Contents do not matter — nothing here decodes it.
 * @param name - The file name.
 * @returns The file.
 */
function pickedFile(name = 'a.png'): File {
  return new File(['x'], name, { type: 'image/png' });
}

describe('AvatarCropDialog — an image the browser cannot decode', () => {
  it('says so instead of leaving an empty frame and a dead Confirm button', async () => {
    // A HEIC off a phone, a truncated JPEG, a .txt renamed to .png: the
    // element never fires `load`, so the box is never measured, the selection
    // never appears and Confirm can never enable. Without an error the user
    // sees a blank grey box with no explanation and only Cancel to press.
    render(
      <AvatarCropDialog
        file={pickedFile('broken.png')}
        uploading={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.error(document.querySelector('img')!);

    await waitFor(() => {
      expect(screen.getByTestId('avatar-crop-error')).toHaveTextContent(
        'studio.container.settings.avatarError.not_an_image',
      );
    });
  });

  it('clears that error when a different file is picked', async () => {
    const { rerender } = render(
      <AvatarCropDialog
        file={pickedFile('broken.png')}
        uploading={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.error(document.querySelector('img')!);
    await waitFor(() =>
      expect(screen.queryByTestId('avatar-crop-error')).toBeInTheDocument(),
    );

    rerender(
      <AvatarCropDialog
        file={pickedFile('good.png')}
        uploading={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId('avatar-crop-error')).not.toBeInTheDocument(),
    );
  });
});

describe('AvatarCropDialog — closing while an upload is in flight', () => {
  it('refuses to close, since nothing would be listening for the result', () => {
    const onCancel = vi.fn();
    render(
      <AvatarCropDialog
        file={pickedFile()}
        uploading={true}
        error={null}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('closes normally when idle', async () => {
    const onCancel = vi.fn();
    render(
      <AvatarCropDialog
        file={pickedFile()}
        uploading={false}
        error={null}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(onCancel).toHaveBeenCalled());
  });
});

describe('AvatarCropDialog — upload failure', () => {
  it('keeps the dialog open and shows why, so the crop is not lost', () => {
    render(
      <AvatarCropDialog
        file={pickedFile()}
        uploading={false}
        error='upload exploded'
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('avatar-crop-error')).toHaveTextContent(
      'upload exploded',
    );
  });
});

describe('AvatarCropDialog — object URL lifetime', () => {
  it('revokes the previous file\'s URL when another is picked', async () => {
    const { rerender } = render(
      <AvatarCropDialog
        file={pickedFile('one.png')}
        uploading={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const first = objectUrls[0]!;

    rerender(
      <AvatarCropDialog
        file={pickedFile('two.png')}
        uploading={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    await waitFor(() => expect(revoked).toContain(first));
  });

  it('still shows a URL that has not been revoked, under StrictMode', async () => {
    // StrictMode is the only condition that separates the two ways of doing
    // this, and counting is not enough to tell them apart: BOTH mint two URLs
    // and revoke one (measured, not assumed). What differs is WHICH one.
    //
    // Minting during render: pass one creates A, pass two creates B and React
    // keeps B, so A is stranded — and the effect, keyed on B, revokes B on
    // StrictMode's simulated unmount. The image is then pointed at a URL that
    // has been released, with A never freed.
    //
    // Minting inside the effect: A is created and released by its own cleanup,
    // B is created on the remount and is the one displayed.
    //
    // So the assertion is about the URL actually in use, not about counts.
    render(
      <React.StrictMode>
        <AvatarCropDialog
          file={pickedFile('strict.png')}
          uploading={false}
          error={null}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </React.StrictMode>,
    );

    await waitFor(() => expect(document.querySelector('img')).not.toBeNull());
    const shown = document.querySelector('img')!.getAttribute('src');
    expect(shown).not.toBeNull();
    expect(revoked).not.toContain(shown);
  });
});

describe('AvatarCropDialog — a gesture interrupted by the dialog closing', () => {
  /**
   * Give the image and its frame real layout boxes. jsdom reports every
   * element as 0x0, and the dialog deliberately refuses to draw a selection it
   * cannot measure — so without this there is nothing to drag.
   * @param img - The image element.
   */
  function giveLayout(img: HTMLElement): void {
    // Deliberately not square: the selection is the largest square that fits,
    // so a square image gives a selection with nowhere to move — every drag
    // clamps back to the same place and the test passes whatever the code
    // does. A 200x100 image leaves 100px of travel.
    for (const [prop, value] of [
      ['offsetWidth', 200],
      ['offsetHeight', 100],
      ['offsetLeft', 0],
      ['offsetTop', 0],
    ] as const) {
      Object.defineProperty(img, prop, { configurable: true, value });
    }
    const frame = img.parentElement!;
    Object.defineProperty(frame, 'clientWidth', {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(frame, 'clientHeight', {
      configurable: true,
      value: 100,
    });
  }

  it('does not resume that gesture on the next image', async () => {
    // Closing mid-drag unmounts the element holding pointer capture, so the
    // pointerup never reaches its handler and the gesture cannot end itself.
    // Carried into the next file, merely moving the pointer would drag the
    // selection with no button held.
    const { rerender } = render(
      <AvatarCropDialog
        file={pickedFile('one.png')}
        uploading={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const img = document.querySelector('img')!;
    giveLayout(img);
    fireEvent.load(img);

    const selection = await screen.findByTestId('avatar-crop-selection');
    selection.setPointerCapture = vi.fn();
    fireEvent.pointerDown(selection, { clientX: 50, clientY: 50, pointerId: 1 });

    // The dialog closes with the pointer still down, then a new file arrives.
    rerender(
      <AvatarCropDialog
        file={pickedFile('two.png')}
        uploading={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const nextImg = document.querySelector('img')!;
    giveLayout(nextImg);
    fireEvent.load(nextImg);

    const next = await screen.findByTestId('avatar-crop-selection');
    const before = next.style.left;
    fireEvent.pointerMove(next.parentElement!, { clientX: 150, clientY: 150 });

    expect(next.style.left).toBe(before);
  });
});
