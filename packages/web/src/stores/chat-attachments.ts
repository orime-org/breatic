// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { create } from 'zustand';

import { attachmentSection } from '@breatic/shared';
import type { ChatAttachedChip } from '@breatic/shared';

/** Where one attached item stands. */
export type TrayStatus = 'uploading' | 'ready' | 'failed';

/** Why an item could not be attached. */
export type TrayFailure = 'upload' | 'extract' | 'too_long';

/** One item waiting above the chat box. */
export interface TrayItem {
  /** The canvas node's id, or one made up for a file picked from disk. */
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

interface TrayState {
  /** The list above the box in each conversation, keyed by conversation. */
  byConversation: Record<string, TrayItem[]>;
}

const useStore = create<TrayState>(() => ({ byConversation: {} }));

const EMPTY: TrayItem[] = [];

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
function trayOf(conversationId: string): TrayItem[] {
  return useStore.getState().byConversation[conversationId] ?? EMPTY;
}

/**
 * Attach a batch, whole or not at all.
 *
 * An item already in the list is skipped, so attaching the same node twice
 * does not take up two places. The rest go in together only if the list then
 * still fits both limits: a batch that partly went in would leave the reader
 * to work out which part.
 * @param conversationId - The conversation it is attached in.
 * @param batch - The items, in order.
 * @param limits - The limits the list is held to.
 * @returns Whether it went in, and if not which limit stopped it.
 */
function add(conversationId: string, batch: readonly TrayItem[], limits: AttachmentLimits): AddOutcome {
  const current = trayOf(conversationId);
  const present = new Set(current.map((item) => item.id));
  const fresh = batch.filter((item) => !present.has(item.id));
  const next = [...current, ...fresh];
  if (next.length > limits.maxItems) return 'full';
  if (!fits(next, limits)) return 'too_long';
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
 * limit, the item fails as too long rather than holding a send the server
 * would refuse.
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
  return update(conversationId, id, (item) => ({ ...item, status: 'failed', failure: 'too_long' }))
    ? 'too_long'
    : 'gone';
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
 * Take one item out.
 * @param conversationId - The conversation.
 * @param id - The item.
 */
function remove(conversationId: string, id: string): void {
  removeSent(conversationId, [id]);
}

/**
 * Take out the items a turn carried, once it has opened.
 *
 * By id, so an item attached after the press stays for the next message.
 * @param conversationId - The conversation.
 * @param ids - The items that went with the turn.
 */
function removeSent(conversationId: string, ids: readonly string[]): void {
  const current = useStore.getState().byConversation[conversationId];
  if (!current) return;
  const gone = new Set(ids);
  write(
    conversationId,
    current.filter((item) => !gone.has(item.id)),
  );
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

export const chatAttachments = {
  trayOf,
  add,
  settle,
  fail,
  remove,
  removeSent,
  forget,
  sendable,
};
