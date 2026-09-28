// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The items waiting above the chat box, one list per conversation.
 *
 * What can be sent is what is shown: every item has to be ready, and the
 * whole list has to fit the limits the server enforces, before the send
 * button does anything.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { attachmentSection } from '@breatic/shared';
import type { ChatAttachedChip } from '@breatic/shared';

import {
  chatAttachments,
  type AttachmentLimits,
  type TrayItem,
} from '@web/stores/chat-attachments';

const LIMITS: AttachmentLimits = { maxItems: 3, maxChars: 10_000 };

/**
 * A canvas node that is ready the moment it is attached.
 * @param id - Its id.
 * @param text - What its snapshot holds.
 * @returns The item.
 */
function node(id: string, text = 'x'): TrayItem {
  const chip: ChatAttachedChip = { id, type: 'text', name: id, data_snapshot: { text } };
  return { id, name: id, type: 'text', status: 'ready', chip };
}

/**
 * A file still on its way up.
 * @param id - Its id.
 * @returns The item.
 */
function uploading(id: string): TrayItem {
  return { id, name: `${id}.png`, type: 'image', status: 'uploading' };
}

beforeEach(() => {
  chatAttachments.forget(['c1', 'c2']);
});

describe('adding a batch', () => {
  it('puts every item in, in order', () => {
    expect(chatAttachments.add('c1', [node('a'), node('b')], LIMITS)).toBe('added');
    expect(chatAttachments.trayOf('c1').map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('keeps each conversation to its own list', () => {
    chatAttachments.add('c1', [node('a')], LIMITS);
    expect(chatAttachments.trayOf('c2')).toEqual([]);
  });

  it('skips an item that is already there', () => {
    chatAttachments.add('c1', [node('a')], LIMITS);
    expect(chatAttachments.add('c1', [node('a'), node('b')], LIMITS)).toBe('added');
    expect(chatAttachments.trayOf('c1').map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('refuses the whole batch when it would pass the item limit', () => {
    chatAttachments.add('c1', [node('a'), node('b')], LIMITS);
    expect(chatAttachments.add('c1', [node('c'), node('d')], LIMITS)).toBe('full');
    expect(chatAttachments.trayOf('c1').map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('refuses the whole batch when it would pass the length limit', () => {
    const big = node('big', 'y'.repeat(LIMITS.maxChars));
    expect(chatAttachments.add('c1', [node('a'), big], LIMITS)).toBe('too_long');
    expect(chatAttachments.trayOf('c1')).toEqual([]);
  });

  it('admits a batch that lands exactly on the length limit', () => {
    const bare = attachmentSection([node('a', '').chip!]).length;
    const exact = node('a', 'y'.repeat(LIMITS.maxChars - bare));
    expect(chatAttachments.add('c1', [exact], LIMITS)).toBe('added');
  });
});

describe('an upload coming back', () => {
  it('turns ready with what it filed', () => {
    chatAttachments.add('c1', [uploading('f')], LIMITS);
    const chip: ChatAttachedChip = {
      id: 'f',
      type: 'image',
      name: 'f.png',
      data_snapshot: { url: 'https://cdn.example/f.png' },
    };

    expect(chatAttachments.settle('c1', 'f', chip, LIMITS)).toBe('ready');
    expect(chatAttachments.trayOf('c1')[0]).toMatchObject({ status: 'ready', chip });
  });

  it('fails as too long when its content pushes the list past the limit', () => {
    chatAttachments.add('c1', [uploading('f')], LIMITS);
    const chip: ChatAttachedChip = {
      id: 'f',
      type: 'text',
      name: 'f.pdf',
      data_snapshot: { text: 'y'.repeat(LIMITS.maxChars) },
    };

    expect(chatAttachments.settle('c1', 'f', chip, LIMITS)).toBe('too_long');
    expect(chatAttachments.trayOf('c1')[0]).toMatchObject({
      status: 'failed',
      failure: 'too_long',
    });
  });

  it('is dropped when the item was removed while it was on its way', () => {
    chatAttachments.add('c1', [uploading('f')], LIMITS);
    chatAttachments.remove('c1', 'f');
    const chip: ChatAttachedChip = { id: 'f', type: 'image', name: 'f.png', data_snapshot: {} };

    chatAttachments.settle('c1', 'f', chip, LIMITS);
    chatAttachments.fail('c1', 'f', 'upload');

    expect(chatAttachments.trayOf('c1')).toEqual([]);
  });

  it('is dropped when the conversation was forgotten while it was on its way', () => {
    chatAttachments.add('c1', [uploading('f')], LIMITS);
    chatAttachments.forget(['c1']);
    chatAttachments.fail('c1', 'f', 'upload');

    expect(chatAttachments.trayOf('c1')).toEqual([]);
  });

  it('marks a failed upload as failed', () => {
    chatAttachments.add('c1', [uploading('f')], LIMITS);
    chatAttachments.fail('c1', 'f', 'upload');
    expect(chatAttachments.trayOf('c1')[0]).toMatchObject({ status: 'failed', failure: 'upload' });
  });
});

describe('what can be sent', () => {
  it('is the ready chips when every item is ready', () => {
    chatAttachments.add('c1', [node('a'), node('b')], LIMITS);
    expect(chatAttachments.sendable('c1')?.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('is nothing to hold the send while an item is uploading', () => {
    chatAttachments.add('c1', [node('a'), uploading('f')], LIMITS);
    expect(chatAttachments.sendable('c1')).toBeNull();
  });

  it('is nothing to hold the send while an item has failed', () => {
    chatAttachments.add('c1', [uploading('f')], LIMITS);
    chatAttachments.fail('c1', 'f', 'upload');
    expect(chatAttachments.sendable('c1')).toBeNull();
  });

  it('is an empty list when nothing is attached', () => {
    expect(chatAttachments.sendable('c1')).toEqual([]);
  });
});

describe('after a turn opens', () => {
  it('takes out only the items that went with it', () => {
    chatAttachments.add('c1', [node('a'), node('b')], LIMITS);
    chatAttachments.add('c1', [node('c')], LIMITS);

    chatAttachments.removeSent('c1', ['a', 'b']);

    expect(chatAttachments.trayOf('c1').map((i) => i.id)).toEqual(['c']);
  });
});
