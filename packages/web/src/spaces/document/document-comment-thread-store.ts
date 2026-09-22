// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The thread store, wired to one document (#18, design §4.2 · §4.3).
 *
 * Threads live in the same Y.Doc as the body, under the key
 * `documentCommentThreads` owns, so one collab connection carries both and a
 * thread cannot arrive without the text it points at. That is the whole
 * reason `YjsThreadStore` was chosen over `RESTYjsThreadStore`: no new
 * dependency, no backend change.
 *
 * The library's extension is what computes `threadPositions`, the table the
 * orphan test reads (§9), so it has to be registered even though none of its
 * React components are used — those need a components context that only
 * `BlockNoteView` provides (§4.3).
 *
 * WHAT THE LIBRARY WILL NOT DO. `YjsThreadStore.addThreadToDocument` is
 * `undefined` on purpose, its own comment saying the store does not support
 * it, so creating a thread writes the thread and nothing else. Putting the
 * mark on the text is ours, and that is what lets a block entry hand in a
 * range the library's `setMark` fallback could never reach (§6).
 */

import type { ExtensionFactoryInstance } from '@blocknote/core';
import { CommentsExtension } from '@blocknote/core/comments';
import { YjsThreadStore } from '@blocknote/core/yjs';
import type * as Y from 'yjs';

import { documentCommentThreads } from '@breatic/shared';

import type { UserSummary } from '@web/data/api/users';
import { usersApi } from '@web/data/api/users';
import {
  documentCommentAuth,
  type DocumentCommentAuthInput,
} from '@web/spaces/document/document-comment-auth';

/** A comment author as the library holds one. */
interface CommentUser {
  /** The account id, which is what a comment stores. */
  readonly id: string;
  /** The display name; the library's own field name for it. */
  readonly username: string;
  /** Their avatar, absent for an account that has none. */
  readonly avatarUrl: string | undefined;
}

/** What a caller has to supply to wire comments to a document. */
export interface DocumentCommentsOptions {
  /** The document Space's Y.Doc, holding the body and the threads. */
  readonly doc: Y.Doc;
  /**
   * Who is reading, asked afresh for every auth answer.
   *
   * A reading rather than a value because the editor is built once per
   * document and outlives a Space-tab switch, while a role does not (A17).
   */
  readonly readWho: () => DocumentCommentAuthInput;
}

/**
 * Maps accounts onto the shape the library reads.
 *
 * Not an identity mapping: the library reads `username` and the account calls
 * the same thing `name` (`UserSummary`, which already falls back to the email
 * local part for somebody mid-onboarding).
 * @param accounts - The profiles the account endpoint answered with.
 * @returns The same people in the library's shape.
 */
export function toCommentUsers(
  accounts: readonly UserSummary[],
): readonly CommentUser[] {
  return accounts.map((account) => ({
    id: account.id,
    username: account.name,
    avatarUrl: account.avatarUrl,
  }));
}

/**
 * Resolves comment authors, straight from the account.
 *
 * The account endpoint rather than the project roster, for the reason
 * `useUserProfiles` gives: a comment keeps its author's name after they leave
 * the project, and the roster cannot say what it no longer holds. It omits
 * only soft-deleted accounts, and the library then has no entry for them —
 * which the panel renders as not knowing who.
 *
 * The library caches, de-duplicates and merges concurrent calls itself
 * (`createUserStore`), so this asks for exactly the ids it is handed.
 * @param userIds - The ids the library has no entry for yet.
 * @returns Those it could resolve.
 * @throws {ApiException} When the request fails.
 */
async function resolveCommentUsers(
  userIds: string[],
): Promise<readonly CommentUser[]> {
  return toCommentUsers(await usersApi.getByIds(userIds));
}

/**
 * Builds the comments extension for one document.
 *
 * `CommentsExtension` is called rather than wrapped: the factory stamps its
 * own identity onto the instance it builds, and `editor.getExtension` matches
 * on that stamp. Wrapping it in another `createExtension` registers the
 * extension but under the wrapper's identity, so `getExtension` answers
 * nothing and the position table becomes unreachable — measured.
 * @param options - The document, and who is reading it.
 * @returns The extension, for the assembly to register.
 */
export function documentCommentsExtension(
  options: DocumentCommentsOptions,
): ExtensionFactoryInstance {
  // The author id is the one place the library takes a value rather than
  // asking: it is stamped onto every comment this client writes, and the
  // store keeps the one it was built with. That is the right reading anyway —
  // who is at the keyboard does not change while a Space is open, whereas
  // what they are allowed to do does.
  const store = new YjsThreadStore(
    options.readWho().viewerId ?? '',
    documentCommentThreads(options.doc),
    documentCommentAuth(options.readWho),
  );

  return CommentsExtension({
    threadStore: store,
    resolveUsers: resolveCommentUsers,
  } as never) as unknown as ExtensionFactoryInstance;
}
