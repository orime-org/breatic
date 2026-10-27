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

const toastSpy = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: { warning: toastSpy.warning, error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
beforeEach(() => {
  toastSpy.warning.mockClear();
});

import { UploadFailedError } from '@web/data/upload/media-upload';
import { uploadableFormatList, uploadableSpellings } from '@breatic/shared';
import { attachAccept, attachFiles, type AttachDeps } from '@web/pages/project/chat/attach-files';
import { pickExtractor } from '@web/spaces/canvas/text-extract';
import { chatAttachments } from '@web/stores/chat-attachments';

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
  return toastSpy.warning.mock.calls.at(-1)?.[0] ?? null;
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

describe('attachment picker formats', () => {
  it.each([
    ['notes.txt', 'text/plain'], ['notes.md', 'text/markdown'], ['rows.csv', 'text/csv'],
    ['data.json', 'application/json'], ['data.xml', 'application/xml'],
    ['code.js', 'application/javascript'], ['code.es', 'application/ecmascript'],
    ['data.yaml', 'application/x-yaml'], ['data.yml', 'application/yaml'],
    ['document.pdf', 'application/pdf'],
    ['document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['sheet.xls', 'application/vnd.ms-excel'],
  ])('offers the existing extractor capability for %s', (name, mime) => {
    expect(pickExtractor(mime)).not.toBeNull();
    const tokens = attachAccept().split(',');
    const extension = name.slice(name.lastIndexOf('.'));
    expect(tokens.includes(extension) || tokens.includes(mime) || (mime.startsWith('text/') && tokens.includes('text/*'))).toBe(true);
  });

  it('retains supported media aliases and document extensions', () => {
    const tokens = attachAccept().split(',');
    expect(tokens).toEqual(expect.arrayContaining([...uploadableSpellings(), '.pdf', '.docx', '.xlsx', '.xls', '.txt']));
    for (const unsupported of ['.doc', 'application/zip', 'image/*', 'video/*', 'audio/*']) {
      expect(tokens).not.toContain(unsupported);
    }
  });
});

describe('attaching picked files', () => {
  it.each([
    ['vector.svg', 'image/svg+xml', 'image', 'Images'],
    ['clip.ogv', 'video/ogg', 'video', 'Video'],
    ['sound.aiff', 'audio/aiff', 'audio', 'Audio'],
  ] as const)('explains the supported formats when refusing %s before upload', async (name, type, kind, label) => {
    const upload = vi.fn(async () => 'https://cdn.example/unused');
    const extract = vi.fn(async () => 'unused');
    const say = vi.spyOn(chatAttachments, 'say');
    try {
      await pick([file(name, type)], deps({ upload, extract }));
      expect(upload).not.toHaveBeenCalled();
      expect(extract).not.toHaveBeenCalled();
      expect(chatAttachments.trayOf(CONV)).toEqual([]);
      expect(say).toHaveBeenCalledWith({
        key: 'unsupportedMedia', filename: name, kind, formats: uploadableFormatList(kind),
      });
      expect(notice()).toBe(`${name} isn’t a supported format. ${label} take${kind === 'image' ? '' : 's'} ${uploadableFormatList(kind)}.`);
    } finally {
      say.mockRestore();
    }
  });

  it('explains an upload format refusal and retains the failed attachment until removed', async () => {
    const say = vi.spyOn(chatAttachments, 'say');
    try {
      await pick([file('photo.png', 'image/png')], deps({
        upload: async () => { throw new UploadFailedError('unsupportedType'); },
      }));
      expect(say).toHaveBeenCalledWith({
        key: 'unsupportedMedia', filename: 'photo.png', kind: 'image', formats: uploadableFormatList('image'),
      });
      expect(notice()).toBe(`photo.png isn’t a supported format. Images take ${uploadableFormatList('image')}.`);
      expect(chatAttachments.trayOf(CONV)[0]).toMatchObject({ status: 'failed', failure: 'upload' });
      expect(chatAttachments.sendable(CONV)).toBeNull();
      chatAttachments.remove(CONV, 'f1');
      await pick([file('retry.png', 'image/png')]);
      expect(chatAttachments.sendable(CONV)).toEqual([{
        id: 'f2', type: 'image', name: 'retry.png', data_snapshot: { url: 'https://cdn.example/retry.png' },
      }]);
    } finally {
      say.mockRestore();
    }
  });

  it.each(['image/png', 'image/svg+xml'])('keeps a zero-byte %s refusal separate from format errors', async (type) => {
    const upload = vi.fn(async () => 'https://cdn.example/unused');
    await pick([file('empty', type, 0)], deps({ upload }));
    expect(upload).not.toHaveBeenCalled();
    expect(chatAttachments.trayOf(CONV)).toEqual([]);
    expect(notice()).toBe('empty can’t be attached');
  });

  it('reports an unsupported format before considering its upload size', async () => {
    await pick([file('huge.svg', 'image/svg+xml', 2_000_000)]);
    expect(notice()).toBe(`huge.svg isn’t a supported format. Images take ${uploadableFormatList('image')}.`);
    expect(chatAttachments.trayOf(CONV)).toEqual([]);
  });

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
    expect(notice()).toBeNull();
  });

  it('marks an upload turned away for uploading too often as that', async () => {
    await pick(
      [file('cover.png', 'image/png')],
      deps({
        upload: async () => {
          throw new UploadFailedError('rateLimited');
        },
      }),
    );

    expect(chatAttachments.trayOf(CONV)[0]).toMatchObject({ status: 'failed', failure: 'rate_limited' });
    expect(notice()).toBeNull();
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
    expect(notice()).toBeNull();
  });

  it('marks a document with no words in it, such as a scanned pdf, as not read', async () => {
    await pick([file('scan.pdf', 'application/pdf')], deps({ extract: async () => ' \n\t ' }));

    expect(chatAttachments.trayOf(CONV)[0]).toMatchObject({ status: 'failed', failure: 'extract' });
  });

  it('marks a document too long to send, and says so', async () => {
    await pick(
      [file('report.pdf', 'application/pdf')],
      deps({ tray: trayWith(10, 100), extract: async () => 'x'.repeat(500) }),
    );

    expect(chatAttachments.trayOf(CONV)[0]).toMatchObject({ status: 'failed', failure: 'too_long' });
    expect(notice()).toBe('Too much content attached. Attach fewer items or shorter files.');
  });

  it('turns away a text file too big to fit without reading it, and says so', async () => {
    const extract = vi.fn(async () => 'never read');

    await pick([file('log.txt', 'text/plain', 3001)], deps({ tray: trayWith(10, 1000), extract }));

    expect(extract).not.toHaveBeenCalled();
    expect(chatAttachments.trayOf(CONV)).toEqual([]);
    expect(notice()).toBe('Too much content attached. Attach fewer items or shorter files.');
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
    expect(notice()).toBe('model.glb can’t be attached');
  });

  it('turns away a file larger than may be uploaded, and names it', async () => {
    await pick([file('film.mp4', 'video/mp4', 2_000_000)]);

    expect(chatAttachments.trayOf(CONV)).toEqual([]);
    expect(notice()).toBe('film.mp4 is too large to attach');
  });

  it('attaches none of a batch that would pass the item limit, and says so', async () => {
    await pick(
      [file('a.png', 'image/png'), file('b.png', 'image/png'), file('c.png', 'image/png')],
      deps({ tray: trayWith(2) }),
    );

    expect(chatAttachments.trayOf(CONV)).toEqual([]);
    expect(notice()).toBe('At most 2 items can be attached');
  });

  it('uploads media into the project it is attached in', async () => {
    const upload = vi.fn(async () => 'https://cdn.example/x.png');

    await pick([file('x.png', 'image/png')], deps({ upload }));

    expect(upload).toHaveBeenCalledWith(expect.any(File), 'p1');
  });
});
