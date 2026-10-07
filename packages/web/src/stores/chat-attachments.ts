// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { create } from 'zustand';

import { attachmentSection } from '@breatic/shared';
import type { ChatAttachedChip } from '@breatic/shared';

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

/** What to say beside the attach button about the last attempt to attach. */
export type TrayNotice =
  | { key: 'full'; limit: number }
  | { key: 'tooLong' }
  | { key: 'unsupported'; filename: string }
  | { key: 'tooLarge'; filename: string }
  | { key: 'unavailable' };

interface TrayState {
  /** The list above the box in each conversation, keyed by conversation. */
  byConversation: Record<string, TrayItem[]>;
  /**
   * What was said about the last attempt to attach, keyed by conversation.
   *
   * Here rather than with whoever attached: the canvas attaches too, and what
   * it has to say belongs above the same box.
   */
  noticeByConversation: Record<string, TrayNotice>;
}

const useStore = create<TrayState>(() => ({ byConversation: {}, noticeByConversation: {} }));

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
 * batch is said so beside the attach button.
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
    say(conversationId, { key: 'full', limit: limits.maxItems });
    return 'full';
  }
  if (!fits(next, limits)) {
    say(conversationId, { key: 'tooLong' });
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
 * limit, the item fails as too long and that is said beside the attach button.
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
  say(conversationId, { key: 'tooLong' });
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
 * Take out the items that match, and say nothing more about the last attempt.
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
  say(conversationId, null);
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
 * message. A turn opening ends the attempt the notice was about, so the
 * notice goes whether or not anything was attached.
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
    const noticeByConversation = { ...s.noticeByConversation };
    for (const id of conversationIds) {
      delete byConversation[id];
      delete noticeByConversation[id];
    }
    return { byConversation, noticeByConversation };
  });
}

/**
 * Say something beside the attach button about the last attempt to attach, or clear it.
 * @param conversationId - The conversation.
 * @param notice - What to say, or null to say nothing.
 */
function say(conversationId: string, notice: TrayNotice | null): void {
  useStore.setState((s) => {
    const noticeByConversation = { ...s.noticeByConversation };
    if (notice === null) delete noticeByConversation[conversationId];
    else noticeByConversation[conversationId] = notice;
    return { noticeByConversation };
  });
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

/**
 * What is said beside the attach button in one conversation, kept current.
 * @param conversationId - The conversation on screen, if one is.
 * @returns The notice, or null when there is none.
 */
export function useTrayNotice(conversationId: string | undefined): TrayNotice | null {
  return useStore((s) =>
    conversationId ? (s.noticeByConversation[conversationId] ?? null) : null,
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
