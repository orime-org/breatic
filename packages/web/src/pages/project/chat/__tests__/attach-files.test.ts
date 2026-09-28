// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What happens to the files a reader picks with the composer's attach button.
 *
 * Media goes up to storage and is sent as the address it was filed under;
 * a document is read in the browser and sent as its text. Either way it sits
 * above the box as uploading until it is ready or has failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { attachFiles, type AttachDeps } from '@web/pages/project/chat/attach-files';
import { chatAttachments, useChatAttachments } from '@web/stores/chat-attachments';

const CONV = 'c1';

/**
 * A file of a given type.
 * @param name - Its name.
 * @param type - Its mime type.
 * @param size - Its size in bytes.
 * @returns The file.
 */
function file(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

let ids = 0;

/**
 * What is said above the box.
 * @returns The notice, or null.
 */
function notice(): unknown {
  return useChatAttachments.getState().noticeByConversation[CONV] ?? null;
}

/**
 * The list above the box, held to some limits.
 * @param maxItems - How many items it takes.
 * @param maxChars - How long its section may be.
 * @returns The tray opener.
 */
function trayWith(maxItems = 10, maxChars = 200_000): AttachDeps['tray'] {
  return async () => ({ conversationId: CONV, limits: { maxItems, maxChars } });
}

/**
 * Dependencies that succeed unless told otherwise.
 * @param over - What to change.
 * @returns The dependencies.
 */
function deps(over: Partial<AttachDeps> = {}): AttachDeps {
  return {
    tray: trayWith(),
    maxUploadBytes: async () => 1_000_000,
    upload: async (f) => `https://cdn.example/${f.name}`,
    extract: async () => 'the document text',
    newId: () => `f${++ids}`,
    ...over,
  };
}

/**
 * Attach picked files in project p1.
 * @param files - What was picked.
 * @param d - The dependencies.
 */
async function pick(files: File[], d: AttachDeps = deps()): Promise<void> {
  await attachFiles(files, 'p1', d);
}

beforeEach(() => {
  chatAttachments.forget([CONV]);
  ids = 0;
});

describe('attaching picked files', () => {
  it('sends an image as the address it was filed under', async () => {
    await pick([file('cover.png', 'image/png')]);

    expect(chatAttachments.trayOf(CONV)).toEqual([
      {
        id: 'f1',
        name: 'cover.png',
        type: 'image',
        status: 'ready',
        chip: {
          id: 'f1',
          type: 'image',
          name: 'cover.png',
          data_snapshot: { url: 'https://cdn.example/cover.png' },
        },
      },
    ]);
  });

  it('sends a document as the text read out of it', async () => {
    await pick([file('brief.pdf', 'application/pdf')]);

    expect(chatAttachments.trayOf(CONV)[0]).toMatchObject({
      status: 'ready',
      type: 'text',
      chip: { type: 'text', name: 'brief.pdf', data_snapshot: { text: 'the document text' } },
    });
  });

  it('shows an item as uploading until its upload comes back', async () => {
    let finish: (url: string) => void = () => undefined;
    const pending = pick(
      [file('cover.png', 'image/png')],
      deps({ upload: () => new Promise((resolve) => (finish = resolve)) }),
    );
    await vi.waitFor(() => expect(chatAttachments.trayOf(CONV)).toHaveLength(1));

    expect(chatAttachments.trayOf(CONV)[0]?.status).toBe('uploading');

    finish('https://cdn.example/cover.png');
    await pending;
    expect(chatAttachments.trayOf(CONV)[0]?.status).toBe('ready');
  });

  it('marks an upload that failed', async () => {
    await pick(
      [file('cover.png', 'image/png')],
      deps({
        upload: async () => {
          throw new Error('upload');
        },
      }),
    );

    expect(chatAttachments.trayOf(CONV)[0]).toMatchObject({ status: 'failed', failure: 'upload' });
  });

  it('marks an upload that came back without an address as failed', async () => {
    await pick([file('cover.png', 'image/png')], deps({ upload: async () => undefined }));

    expect(chatAttachments.trayOf(CONV)[0]).toMatchObject({ status: 'failed', failure: 'upload' });
  });

  it('marks a document that could not be read', async () => {
    await pick(
      [file('brief.pdf', 'application/pdf')],
      deps({
        extract: async () => {
          throw new Error('broken');
        },
      }),
    );

    expect(chatAttachments.trayOf(CONV)[0]).toMatchObject({ status: 'failed', failure: 'extract' });
  });

  it('marks a document too long to send, and says so', async () => {
    await pick(
      [file('report.pdf', 'application/pdf')],
      deps({ tray: trayWith(10, 100), extract: async () => 'x'.repeat(500) }),
    );

    expect(chatAttachments.trayOf(CONV)[0]).toMatchObject({ status: 'failed', failure: 'too_long' });
    expect(notice()).toEqual({ key: 'tooLong' });
  });

  it('turns away a text file too big to fit without reading it, and says so', async () => {
    const extract = vi.fn(async () => 'never read');

    await pick([file('log.txt', 'text/plain', 3001)], deps({ tray: trayWith(10, 1000), extract }));

    expect(extract).not.toHaveBeenCalled();
    expect(chatAttachments.trayOf(CONV)).toEqual([]);
    expect(notice()).toEqual({ key: 'tooLong' });
  });

  it('reads a text file whose size could still fit', async () => {
    await pick(
      [file('notes.txt', 'text/plain', 3000)],
      deps({ tray: trayWith(10, 1000), extract: async () => 'short' }),
    );

    expect(chatAttachments.trayOf(CONV)[0]).toMatchObject({ status: 'ready' });
  });

  it('attaches nothing when there is nowhere to attach', async () => {
    const extract = vi.fn(async () => 'text');

    await pick([file('notes.txt', 'text/plain')], deps({ tray: async () => undefined, extract }));

    expect(extract).not.toHaveBeenCalled();
    expect(chatAttachments.trayOf(CONV)).toEqual([]);
  });

  it('turns away a file of a kind it cannot take, and names it', async () => {
    await pick([file('model.glb', 'model/gltf-binary')]);

    expect(chatAttachments.trayOf(CONV)).toEqual([]);
    expect(notice()).toEqual({ key: 'unsupported', filename: 'model.glb' });
  });

  it('turns away a file larger than may be uploaded, and names it', async () => {
    await pick([file('film.mp4', 'video/mp4', 2_000_000)]);

    expect(chatAttachments.trayOf(CONV)).toEqual([]);
    expect(notice()).toEqual({ key: 'tooLarge', filename: 'film.mp4' });
  });

  it('attaches none of a batch that would pass the item limit, and says so', async () => {
    await pick(
      [file('a.png', 'image/png'), file('b.png', 'image/png'), file('c.png', 'image/png')],
      deps({ tray: trayWith(2) }),
    );

    expect(chatAttachments.trayOf(CONV)).toEqual([]);
    expect(notice()).toEqual({ key: 'full', limit: 2 });
  });

  it('uploads media into the project it is attached in', async () => {
    const upload = vi.fn(async () => 'https://cdn.example/x.png');

    await pick([file('x.png', 'image/png')], deps({ upload }));

    expect(upload).toHaveBeenCalledWith(expect.any(File), 'p1');
  });
});
