// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pasting files into the box attaches them, the same as picking them with the
 * attach button: the files go to the same handler, which sorts, refuses and
 * uploads them exactly as it does a pick.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import { CLIPBOARD_MARKER, CLIPBOARD_VERSION, serializeClipboard, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';

/**
 * Render the composer with an attach handler unless one is given.
 * @param props - Props to override.
 * @returns The attach handler.
 */
function setup(props: Partial<Parameters<typeof ChatComposer>[0]> = {}): {
  onAttachFiles: ReturnType<typeof vi.fn>;
  onPasteCanvas: ReturnType<typeof vi.fn>;
} {
  const onAttachFiles = vi.fn();
  const onPasteCanvas = vi.fn();
  render(
    <ChatComposer
      draft=''
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      onAbort={vi.fn()}
      onAttachFiles={onAttachFiles}
      onPasteCanvas={onPasteCanvas}
      {...props}
    />,
  );
  return { onAttachFiles, onPasteCanvas };
}

/**
 * Paste into the box.
 * @param files - The files the clipboard carries.
 * @param text - The plain text it carries.
 * @returns False when the composer kept the browser from inserting the paste.
 */
function paste(files: File[], text = ''): boolean {
  return fireEvent.paste(screen.getByTestId('chat-composer-box'), {
    clipboardData: { files, getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
}

const shot = new File(['png'], 'shot.png', { type: 'image/png' });
const clip = new File(['mp4'], 'clip.mp4', { type: 'video/mp4' });

describe('pasting into the composer', () => {
  it('attaches pasted files the way the attach button does', () => {
    const { onAttachFiles } = setup();

    const inserted = paste([shot, clip]);

    expect(onAttachFiles).toHaveBeenCalledWith([shot, clip]);
    expect(inserted).toBe(false);
  });

  it('attaches the files and leaves out the text when the clipboard carries both', () => {
    const { onAttachFiles } = setup();

    const inserted = paste([shot], 'shot.png');

    expect(onAttachFiles).toHaveBeenCalledWith([shot]);
    expect(inserted).toBe(false);
  });

  it('puts a plain-text paste into the box', () => {
    const { onAttachFiles } = setup();

    paste([], 'hello');

    expect(onAttachFiles).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-composer-box')).toHaveTextContent('hello');
  });

  it('attaches nothing while the attach button is off', () => {
    const { onAttachFiles } = setup({ turnPhase: 'sending' });

    paste([shot]);

    expect(onAttachFiles).not.toHaveBeenCalled();
  });

  it('hands canvas text on as nodes and keeps it out of the box', () => {
    const { onPasteCanvas } = setup();
    const payload: ClipboardPayload = {
      version: CLIPBOARD_VERSION,
      picked: ['x'],
      nodes: [{ id: 'x', type: 'image', position: { x: 0, y: 0 }, data: { content: 'https://x/y.png' }, external: true }],
      edges: [],
    };

    paste([], serializeClipboard(payload));

    expect(onPasteCanvas).toHaveBeenCalledWith(payload);
    expect(screen.getByTestId('chat-composer-box')).not.toHaveTextContent(CLIPBOARD_MARKER);
  });

  it('pastes canvas text that does not parse as the words it is', () => {
    const { onPasteCanvas } = setup();

    paste([], `${CLIPBOARD_MARKER}not json`);

    expect(onPasteCanvas).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-composer-box')).toHaveTextContent('not json');
  });
});
