// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { EditorState } from '@tiptap/pm/state';

import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import type { DocumentBodyRuntimeSnapshot } from '@web/spaces/document/document-body-runtime-types';

/**
 * Leaves independent parsers and the explicit XML editor unsubscribed.
 * @returns An inert release function.
 * @throws {never}
 */
function noSubscription(): () => void {
  return (): void => undefined;
}

/**
 * Provides a stable snapshot for editors without a records runtime.
 * @returns No runtime restriction.
 * @throws {never}
 */
function noRuntime(): null {
  return null;
}

/**
 * Reads the existing handle runtime without creating or mirroring its state.
 * @param editor - The same editor whose local input owners are on screen.
 * @param editor.prosemirrorState - Its current state carrying the original records binding.
 * @returns Its current runtime snapshot, or none for independent editors.
 * @throws {never}
 */
export function useDocumentBodyRuntime(editor: { readonly prosemirrorState: EditorState }): DocumentBodyRuntimeSnapshot | null {
  const runtime = bodyBindingOf(editor.prosemirrorState)?.runtime;
  return React.useSyncExternalStore(runtime?.subscribe ?? noSubscription, runtime?.read ?? noRuntime, runtime?.read ?? noRuntime);
}
