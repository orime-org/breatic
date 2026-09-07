// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Remote carets, drawn by a plugin this Space registers itself.
 *
 * BlockNote ships the same plugin, and handing its collaboration extension an
 * awareness would be the shortest way to get it. That path is closed: the
 * extension writes `awareness.setLocalStateField('user', options.user)` in its
 * factory body the moment it finds one (`YCursorPlugin.ts:72-86`), and the
 * factory body runs before any `disableExtensions` check
 * (`ExtensionManager/index.ts:154-162`). #1886 delivered the opposite of that
 * write — the id is the server's to publish, from a credential it validated —
 * so the awareness stays here and the plugin is registered from here. The
 * write becomes structurally impossible rather than a frame to race.
 *
 * Both renderers come from `caret-render.ts`, which every collaborative editor
 * shares. The colour is derived from the remote user id rather than read off
 * the wire, so no remote string is ever inlined into the DOM, and the name
 * comes from the roster resolver rather than from the peer.
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { yCursorPlugin } from 'y-prosemirror';
import type { Awareness } from 'y-protocols/awareness';

import {
  renderCollabCaret,
  renderCollabSelection,
  type CaretUser,
  type ResolveCollaboratorName,
} from '@web/features/collab-editor/caret-render';

/**
 * Builds the extension that draws remote carets.
 * @param awareness - The awareness carrying collaborators' cursors.
 * @param resolveCollaboratorName - Looks a collaborator's display name up by
 *   user id. A caret is named at birth by this, synchronously, as part of
 *   building it; the presence hook repaints existing carets when the roster
 *   moves, and which of the two lands first is a race.
 * @returns The extension, for the assembly to register.
 */
export function documentCaretExtension(
  awareness: Awareness,
  resolveCollaboratorName?: ResolveCollaboratorName,
): ExtensionFactoryInstance {
  return createExtension(() => ({
    key: 'documentCaret',
    prosemirrorPlugins: [
      yCursorPlugin(awareness, {
        cursorBuilder: (user: unknown, clientId: number) =>
          renderCollabCaret(user as CaretUser, clientId, resolveCollaboratorName),
        selectionBuilder: (user: unknown) =>
          renderCollabSelection(user as CaretUser),
      }),
    ],
  }) as never)();
}
