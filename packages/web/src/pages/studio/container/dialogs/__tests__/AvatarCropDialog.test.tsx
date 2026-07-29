// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
});
