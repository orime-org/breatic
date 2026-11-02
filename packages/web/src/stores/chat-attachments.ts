// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { create } from 'zustand';

import { attachmentSection, t } from '@breatic/shared';
import { toast } from '@web/lib/toast';
import type { ChatAttachedChip } from '@breatic/shared';
import { keepAcrossUpdate } from '@web/stores/reload-for-update';

/** Where one attached item stands. */
export type TrayStatus = 'uploading' | 'ready' | 'failed';

/** Why an item could not be attached. */
export type TrayFailure = 'upload' | 'rate_limited' | 'extract' | 'too_long';

/** One item waiting above the chat box. */
export interface TrayItem {
  /**
   * Names what was attached, so attaching it again replaces it: the picked
   * node ids for a piece of the canvas, a document block's id, a hash of a
   * document selection's Markdown or of pasted content; fresh for a file
   * picked from disk.
   */
  id: string;
  /** What the reader sees it called. */
  name: string;
  /** What kind of thing it is. */
  type: ChatAttachedChip['type'];
  /** Where it stands. */
  status: TrayStatus;
  /** What is sent for it. Present once it is ready. */
  chip?: ChatAttachedChip;
  /** Why it failed. Present once it has. */
  failure?: TrayFailure;
}

/** The limits one message's attachments are held to, as the server serves them. */
export interface AttachmentLimits {
  /** How many items one message may carry. */
  maxItems: number;
  /** How long the attachment section may be, in characters. */
  maxChars: number;
}

/** What adding a batch came to. */
export type AddOutcome = 'added' | 'full' | 'too_long';

/** What the reader is told about an attempt to attach or send that did not go in. */
export type TrayNotice =
  | { key: 'full'; limit: number }
  | { key: 'tooLong' }
  | { key: 'unsupported'; filename: string }
  | { key: 'unsupportedMedia'; filename: string; kind: string; formats: string }
  | { key: 'tooLarge'; filename: string }
  | { key: 'unavailable' }
  | { key: 'sendUnavailable' };

interface TrayState {
  /** The list above the box in each conversation, keyed by conversation. */
  byConversation: Record<string, TrayItem[]>;
}

/**
 * Register what an update reload carries for attachments and take back what
 * the page before carried. Only ready items cross: a reload stops an upload.
 * @returns Each conversation's carried items; empty when none.
 */
function carriedAcrossUpdate(): Record<string, TrayItem[]> {
  const saved = keepAcrossUpdate('attachments', () => {
    const ready: Record<string, TrayItem[]> = {};
    for (const [conversationId, items] of Object.entries(useStore.getState().byConversation)) {
      const kept = items.filter((item) => item.status === 'ready' && item.chip !== undefined);
      if (kept.length > 0) ready[conversationId] = kept;
    }
    return ready;
  });
  if (typeof saved !== 'object' || saved === null) return {};
  return Object.fromEntries(
    Object.entries(saved).filter((entry): entry is [string, TrayItem[]] => Array.isArray(entry[1])),
  );
}

const useStore = create<TrayState>(() => ({ byConversation: carriedAcrossUpdate() }));

/** Nothing attached; one array, so whoever reads it keeps its identity. */
export const NO_ATTACHMENTS: readonly TrayItem[] = [];

/**
 * The chips of the items that have one, in order.
 * @param items - The list.
 * @returns Their chips.
 */
function chipsOf(items: readonly TrayItem[]): ChatAttachedChip[] {
  return items.flatMap((item) => (item.chip ? [item.chip] : []));
}

/**
 * Whether a list's attachment section fits the length limit.
 * @param items - The list.
 * @param limits - The limits.
 * @returns True when it fits.
 */
function fits(items: readonly TrayItem[], limits: AttachmentLimits): boolean {
  return attachmentSection(chipsOf(items)).length <= limits.maxChars;
}

/**
 * Replace one conversation's list.
 * @param conversationId - The conversation.
 * @param items - Its new list.
 */
function write(conversationId: string, items: TrayItem[]): void {
  useStore.setState((s) => ({
    byConversation: { ...s.byConversation, [conversationId]: items },
  }));
}

/**
 * The list above the box in one conversation.
 * @param conversationId - The conversation.
 * @returns Its items, in the order they were attached.
 */
function trayOf(conversationId: string): readonly TrayItem[] {
  return useStore.getState().byConversation[conversationId] ?? NO_ATTACHMENTS;
}

/**
 * Attach a batch, whole or not at all.
 *
 * An item already in the list keeps its place and takes the new snapshot:
 * attaching a node again after editing it sends what it says now. The rest go
 * in together only if the list then still fits both limits; a batch that
 * partly went in would leave the reader to work out which part. A refused
 * batch is told in a toast.
 * @param conversationId - The conversation it is attached in.
 * @param batch - The items, in order.
 * @param limits - The limits the list is held to.
 * @returns Whether it went in, and if not which limit stopped it.
 */
function add(conversationId: string, batch: readonly TrayItem[], limits: AttachmentLimits): AddOutcome {
  const current = trayOf(conversationId);
  const incoming = new Map(batch.map((item) => [item.id, item]));
  const kept = current.map((item) => incoming.get(item.id) ?? item);
  const present = new Set(current.map((item) => item.id));
  const next = [...kept, ...batch.filter((item) => !present.has(item.id))];
  if (next.length > limits.maxItems) {
    say({ key: 'full', limit: limits.maxItems });
    return 'full';
  }
  if (!fits(next, limits)) {
    say({ key: 'tooLong' });
    return 'too_long';
  }
  write(conversationId, next);
  return 'added';
}

/**
 * Change one item that is still in the list.
 *
 * An item removed while its upload was on its way, or a conversation
 * forgotten meanwhile, has nothing to change: the result is dropped.
 * @param conversationId - The conversation.
 * @param id - The item.
 * @param change - What it becomes.
 * @returns False when the item is no longer there.
 */
function update(conversationId: string, id: string, change: (item: TrayItem) => TrayItem): boolean {
  const current = useStore.getState().byConversation[conversationId];
  if (!current?.some((item) => item.id === id)) return false;
  write(
    conversationId,
    current.map((item) => (item.id === id ? change(item) : item)),
  );
  return true;
}

/**
 * An upload or extraction has what it was waiting for.
 *
 * Its length is known only now, so the list is measured again: past the
 * limit, the item fails as too long and that is told in a toast.
 * @param conversationId - The conversation.
 * @param id - The item.
 * @param chip - What is sent for it.
 * @param limits - The limits the list is held to.
 * @returns What it became, or `gone` when it was removed meanwhile.
 */
function settle(
  conversationId: string,
  id: string,
  chip: ChatAttachedChip,
  limits: AttachmentLimits,
): 'ready' | 'too_long' | 'gone' {
  const withChip = trayOf(conversationId).map((item) => (item.id === id ? { ...item, chip } : item));
  if (fits(withChip, limits)) {
    return update(conversationId, id, (item) => ({ ...item, status: 'ready', chip }))
      ? 'ready'
      : 'gone';
  }
  if (!update(conversationId, id, (item) => ({ ...item, status: 'failed', failure: 'too_long' }))) {
    return 'gone';
  }
  say({ key: 'tooLong' });
  return 'too_long';
}

/**
 * An upload or extraction did not work.
 * @param conversationId - The conversation.
 * @param id - The item.
 * @param failure - Why.
 */
function fail(conversationId: string, id: string, failure: TrayFailure): void {
  update(conversationId, id, (item) => ({ ...item, status: 'failed', failure }));
}

/**
 * Take out the items that match.
 *
 * The list is written only when something left it, so a turn that carried
 * nothing does not hand the box a new list to redraw.
 * @param conversationId - The conversation.
 * @param leaves - Whether an item goes.
 */
function removeWhere(conversationId: string, leaves: (item: TrayItem) => boolean): void {
  const current = useStore.getState().byConversation[conversationId];
  if (current) {
    const next = current.filter((item) => !leaves(item));
    if (next.length !== current.length) write(conversationId, next);
  }
}

/**
 * Take one item out.
 * @param conversationId - The conversation.
 * @param id - The item.
 */
function remove(conversationId: string, id: string): void {
  removeWhere(conversationId, (item) => item.id === id);
}

/**
 * Take out the items a turn carried, once it has opened.
 *
 * Matched on what was sent, not on the id: a node attached again after the
 * press holds a new snapshot under the same id, and that one is for the next
 * message.
 * @param conversationId - The conversation.
 * @param sent - What the turn carried.
 */
function removeSent(conversationId: string, sent: readonly ChatAttachedChip[]): void {
  const gone = new Set(sent.map((chip) => JSON.stringify(chip)));
  removeWhere(conversationId, (item) => item.chip !== undefined && gone.has(JSON.stringify(item.chip)));
}

/**
 * Drop whole lists: the conversations were deleted, or their project left.
 * @param conversationIds - The conversations.
 */
function forget(conversationIds: readonly string[]): void {
  useStore.setState((s) => {
    const byConversation = { ...s.byConversation };
    for (const id of conversationIds) delete byConversation[id];
    return { byConversation };
  });
}

/**
 * The sentence an attempt that did not go in is told with.
 * @param notice - What happened.
 * @returns The sentence, in the reader's language.
 */
export function trayNoticeText(notice: TrayNotice): string {
  switch (notice.key) {
    case 'unavailable':
      return t('chat.composer.attachUnavailable');
    case 'sendUnavailable':
      return t('chat.composer.sendUnavailable');
    case 'full':
      return t('chat.composer.attachFull', { limit: notice.limit });
    case 'tooLong':
      return t('chat.composer.attachTooLong');
    case 'tooLarge':
      return t('chat.composer.attachTooLarge', { filename: notice.filename });
    case 'unsupported':
      return t('chat.composer.attachUnsupported', { filename: notice.filename });
    case 'unsupportedMedia':
      return t('canvas.upload.unsupportedType', { filename: notice.filename, kind: notice.kind, formats: notice.formats });
  }
}

/**
 * Tell the reader an attempt to attach or send did not go in.
 *
 * A toast, said at the moment it happens (inner#1530): every writer -- the
 * attach button, the canvas adding to the Agent, a send held for its limits
 * -- comes through here, so nothing is kept to be said again later.
 * @param notice - What happened.
 */
function say(notice: TrayNotice): void {
  toast.warning(trayNoticeText(notice));
}

/**
 * What a message sent now would carry.
 * @param conversationId - The conversation.
 * @returns The chips in order, or null while any item is uploading or failed.
 */
function sendable(conversationId: string): ChatAttachedChip[] | null {
  const items = trayOf(conversationId);
  if (items.some((item) => item.status !== 'ready')) return null;
  return chipsOf(items);
}

export const useChatAttachments = useStore;

/**
 * The list above the box in one conversation, kept current.
 * @param conversationId - The conversation on screen, if one is.
 * @returns Its items.
 */
export function useTray(conversationId: string | undefined): readonly TrayItem[] {
  return useStore((s) =>
    conversationId ? (s.byConversation[conversationId] ?? NO_ATTACHMENTS) : NO_ATTACHMENTS,
  );
}

export const chatAttachments = {
  trayOf,
  add,
  settle,
  fail,
  remove,
  removeSent,
  forget,
  sendable,
  say,
};
